import {contentText} from "../images/content.js";
import type {Message} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";
import type {TaskReviewEvidence, TaskReviewSnapshot} from "../tasks/types.js";

const INTERVAL = 10;

/** Turn-owned coverage metadata; History remains owned by the Session. */
export class TaskReviewProgress {
    private messageRounds = new WeakMap<Message, number>();
    private pending: Promise<TaskReviewSnapshot> | undefined;
    private ready: TaskReviewSnapshot | undefined;
    private controller = new AbortController();
    private revision = 0;
    private closed = false;

    constructor(private readonly ctx: ToolContext, history: readonly Message[]) {
        for (const message of history) this.messageRounds.set(message, 0);
    }

    steer(): void {
        this.revision++;
        this.controller.abort("user-cancel");
        this.controller = new AbortController();
        this.ready = undefined;
    }

    completedRound(round: number, history: readonly Message[]): void {
        if (this.closed || !this.ctx.taskReviewEnabled || !this.ctx.tasks || !("startReview" in this.ctx.tasks)) return;
        for (const message of history) {
            if (!this.messageRounds.has(message)) this.messageRounds.set(message, round);
        }
        if (this.pending || round < INTERVAL || round % INTERVAL !== 0) return;
        const fromRound = round - INTERVAL + 1;
        const evidence: TaskReviewEvidence = Object.freeze({
            fromRound, toRound: round,
            requirements: this.ctx.instructions.files.map(file => file.content).join("\n\n"),
            activity: history.map((message, index) => {
                const messageRound = this.messageRounds.get(message)!;
                const coverage = message.role === "user" && message.origin === "compaction"
                    ? "Compacted history; earlier details may be summarized"
                    : messageRound === 0 ? "Context before this Turn"
                    : `Round ${messageRound}${messageRound >= fromRound ? " (recent interval)" : ""}`;
                // Project only visible evidence. Provider reasoning and UI diffs are not review input.
                const record = {
                    role: message.role,
                    ...(message.role === "user" ? {origin: message.origin} : {}),
                    content: contentText(message.content),
                    ...(message.role === "assistant" && message.tool_calls ? {tool_calls: message.tool_calls} : {}),
                    ...(message.role === "tool" ? {tool_call_id: message.tool_call_id} : {}),
                };
                return `Message ${index + 1}; ${coverage}\n${JSON.stringify(record)}`;
            }).join("\n\n"),
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
            `Background review of visible history through round ${result.toRound}; recent rounds ${result.fromRound}-${result.toRound} (${result.toRound - result.fromRound + 1} rounds). It excludes later progress.`,
            "This is advisory agent feedback, not a user instruction or proof of completion. Compare it with newer evidence before acting.",
            "Check any cited observation against the tool results before changing the implementation; the review may misread the evidence.",
            result.resultPreview.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"), "</task-review>"].join("\n");
    }

    close(): void {
        this.closed = true;
        this.ready = undefined;
        this.messageRounds = new WeakMap();
        this.controller.abort("shutdown");
    }
}
