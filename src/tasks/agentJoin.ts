import {waitForTaskActivity} from "./wait.js";
import type {QueuedAgentInput} from "../agent/inputChannel.js";
import {notificationFor, taskNotificationId} from "./notifications.js";
import type {AgentTaskSnapshot, TaskSessionLike} from "./types.js";

export function waitForAgentActivity(tasks: TaskSessionLike, ids: readonly string[], signal: AbortSignal, waitForInput: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return waitForTaskActivity(tasks, ids, signal, "agent", waitForInput);
}

/** Turn-owned dependency IDs only; task state remains owned by TaskRuntime. */
export class AgentTaskJoin {
    private readonly pending = new Set<string>();
    private readonly reported = new Set<string>();
    private readonly unacknowledged = new Map<string, string>();
    constructor(private readonly tasks: TaskSessionLike) {}

    register(task: AgentTaskSnapshot): void {this.pending.add(task.id);}

    markReported(task: AgentTaskSnapshot): void {
        if (task.status === "running") return;
        this.pending.delete(task.id);
        const notificationId = taskNotificationId(task.id, task.progress.runCount);
        this.reported.add(notificationId);
        this.unacknowledged.set(notificationId, task.id);
    }

    /** Called only after the Session has durably saved the corresponding History/tool result. */
    async acknowledgeReported(): Promise<void> {
        for (const [notificationId, taskId] of this.unacknowledged) {
            await this.tasks.acknowledgeNotification({notificationId, taskId});
            this.unacknowledged.delete(notificationId);
        }
    }

    accepts(input: QueuedAgentInput): boolean {
        return input.source !== "task_notification" || !this.reported.has(input.id);
    }

    async consume(input: QueuedAgentInput): Promise<void> {
        if (input.source !== "task_notification" || !input.taskId) return;
        const task = await this.tasks.get(input.taskId);
        if (task?.kind === "agent" && taskNotificationId(task.id, task.progress.runCount) === input.id) this.markReported(task);
    }

    async collect(): Promise<QueuedAgentInput[]> {
        const inputs: QueuedAgentInput[] = [];
        for (const id of this.pending) {
            const task = await this.tasks.get(id);
            if (!task || task.kind !== "agent") throw new Error(`Delegated Agent task is unavailable: ${id}`);
            if (task.status === "running") continue;
            const notification = notificationFor(task);
            inputs.push({id: notification.notificationId, source: "task_notification", taskId: id,
                content: `<task-notification>\n${notification.message}\nInspect the result, integrate the changes and complete the remaining verification.\n</task-notification>`});
        }
        return inputs;
    }

    get ids(): readonly string[] {return [...this.pending];}
    wait(signal: AbortSignal, waitForInput: (signal: AbortSignal) => Promise<void>): Promise<void> {
        return waitForAgentActivity(this.tasks, this.ids, signal, waitForInput);
    }
}
