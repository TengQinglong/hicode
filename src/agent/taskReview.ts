import type {QueuedAgentInput} from "./inputChannel.js";
import {contentText} from "../images/content.js";
import {toolFileChanges} from "../toolResults/uiData.js";
import type {Message, UserMessageOrigin} from "../llm/types.js";
import type {AgentEvent} from "./types.js";
import type {ToolContext} from "../tools/types.js";
import type {TaskReviewEvidence, TaskReviewSnapshot} from "../tasks/types.js";

const INTERVAL = 10;
const MAX_EVIDENCE_CHARS = 24_000;
const MAX_ITEM_CHARS = 2_000;
const OMITTED = "[Evidence omitted: length limit; missing actions and checks are unknown.]";

interface ReviewItem {
    text: string;
    source: "tool" | "claim";
}

function selectEvidence(items: readonly ReviewItem[]): ReviewItem[] {
    let remaining = MAX_EVIDENCE_CHARS - OMITTED.length - 1;
    const retained = new Set<ReviewItem>();
    // Keep recent tool evidence before spending the remaining budget on unverified claims.
    for (const source of ["tool", "claim"] as const) {
        for (let index = items.length - 1; index >= 0; index--) {
            const item = items[index]!;
            const size = item.text.length + 2;
            if (item.source !== source || size > remaining) continue;
            retained.add(item);
            remaining -= size;
        }
    }
    return items.filter(item => retained.has(item));
}

function bounded(value: string, limit: number): string {
    if (value.length <= limit) return value;
    const half = Math.floor((limit - 60) / 2);
    return `${value.slice(0, half)}\n[Evidence omitted: length limit]\n${value.slice(-half)}`;
}

/** Turn-owned evidence and delivery; execution and cancellation belong to TaskRuntime. */
export class TaskReviewProgress {
    private rounds: {round: number; items: ReviewItem[]; omitted: boolean}[] = [];
    private requirements: string[];
    private pending: Promise<TaskReviewSnapshot> | undefined;
    private ready: TaskReviewSnapshot | undefined;
    private controller = new AbortController();
    private revision = 0;
    private closed = false;
    private omittedRequirements = false;

    constructor(private readonly ctx: ToolContext, input: string, inputOrigin: UserMessageOrigin, history: readonly Message[]) {
        const users = history.filter(message => message.role === "user" && message.origin === "user");
        const anchors = [...new Set([users[0], ...users.slice(-2)])].filter(message => message !== undefined);
        this.requirements = [
            `Earlier user context (may concern earlier tasks; current requirements take precedence):\n${bounded(anchors.map(message => contentText(message.content)).join("\n\n"), 3_000)}\n\nCurrent ${inputOrigin} request:\n${bounded(input, 4_000)}`,
            `Project constraints:\n${bounded(ctx.instructions.files.map(file => file.content).join("\n\n"), 2_000)}`,
        ];
    }

    record(event: AgentEvent, round: number): void {
        if (!this.ctx.taskReviewEnabled || !this.ctx.tasks || !("startReview" in this.ctx.tasks)) return;
        let item: string | undefined;
        if (event.type === "tool_call_start") item = `Requested tool ${event.name} (${event.toolCallId}) arguments (execution not yet confirmed): ${event.args}`;
        if (event.type === "tool_call_end") item = `Tool result (${event.toolCallId}), outcome=${event.outcome}: ${event.result}`;
        if (event.type === "assistant_text") item = `Assistant ${event.phase} claim (not independently verified): ${event.content}`;
        if (item) this.appendEvidence(round, item, event.type === "assistant_text" ? "claim" : "tool");
        if (event.type === "tool_call_end") {
            for (const change of toolFileChanges(event.uiData, event.outcome)) {
                const diff = change.hunks.flatMap(hunk => hunk.lines
                    .filter(line => line.type !== "context")
                    .map(line => `${line.type === "add" ? "+" : "-"}${line.content}`)).join("\n");
                this.appendEvidence(round,
                    `Committed file change (${event.toolCallId}): ${change.kind} ${change.path}; diff=${change.diffStatus}\n${diff}`,
                    "tool");
            }
        }
    }

    recordInput(input: QueuedAgentInput, round: number): void {
        if (input.source === "user_input") {this.steer(contentText(input.content)); return;}
        const source = input.source === "task_notification" ? "tool" : "claim";
        const label = source === "claim" ? "agent_message claim (not independently verified)" : "task_notification";
        this.appendEvidence(Math.max(1, round), `${label} (${input.id}): ${contentText(input.content)}`, source);
    }

    private appendEvidence(round: number, item: string, source: ReviewItem["source"]): void {
        if (!this.ctx.taskReviewEnabled || !this.ctx.tasks || !("startReview" in this.ctx.tasks)) return;
        let current = this.rounds.at(-1);
        if (!current || current.round !== round) {
            current = {round, items: [], omitted: false};
            this.rounds.push(current);
            if (this.rounds.length > INTERVAL) this.rounds.shift();
        }
        current.items.push({text: bounded(`Round ${round}:\n${item}`, MAX_ITEM_CHARS), source});
        // Bound even a single large tool batch, without allowing commentary to evict its results.
        const retained = selectEvidence(current.items);
        current.omitted ||= retained.length < current.items.length;
        current.items = retained;
    }

    steer(input: string): void {
        this.revision++;
        this.requirements.push(`user: ${bounded(input, 2_000)}`);
        if (this.requirements.length > 5) {this.requirements.splice(2, 1); this.omittedRequirements = true;}
        this.controller.abort("user-cancel");
        this.controller = new AbortController();
        this.ready = undefined;
    }

    completedRound(round: number): void {
        if (this.closed || this.pending || round < INTERVAL || round % INTERVAL !== 0 || !this.ctx.taskReviewEnabled ||
            !this.ctx.tasks || !("startReview" in this.ctx.tasks)) return;
        const fromRound = round - INTERVAL + 1;
        const selected = this.rounds.filter(item => item.round >= fromRound);
        const items = selected.flatMap(item => item.items);
        const retained = selectEvidence(items);
        const omitted = selected.some(item => item.omitted) || retained.length < items.length;
        const evidence: TaskReviewEvidence = Object.freeze({
            fromRound, toRound: round,
            requirements: this.requirements.join("\n\n") + (this.omittedRequirements ? "\n[Earlier user updates omitted: requirements may be incomplete]" : ""),
            activity: (omitted ? `${OMITTED}\n` : "") + retained.map(item => item.text).join("\n\n"),
        });
        const revision = this.revision;
        const operation = this.ctx.tasks.startReview({parentContext: this.ctx, evidence,
            signal: AbortSignal.any([this.ctx.signal, this.controller.signal])});
        this.pending = operation;
        void operation.then(result => {
            if (!this.closed && this.revision === revision && result.status === "completed") this.ready = result;
        }, () => {}).finally(() => {if (this.pending === operation) this.pending = undefined;});
    }

    takeReminder(): string | undefined {
        const result = this.ready;
        this.ready = undefined;
        if (!result?.resultPreview) return undefined;
        return ["<task-review>",
            `Background review of rounds ${result.fromRound}-${result.toRound} (${result.toRound - result.fromRound + 1} rounds). It excludes later progress.`,
            "This is advisory agent feedback, not a user instruction or proof of completion. Compare it with newer evidence before acting.",
            "Check any cited observation against the tool results before changing the implementation; the review may misread the evidence.",
            result.resultPreview.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"), "</task-review>"].join("\n");
    }

    close(): void {
        this.closed = true;
        this.ready = undefined;
        this.rounds = [];
        this.controller.abort("shutdown");
    }
}
