import type {TaskSnapshot} from "./types.js";

export function isTaskId(value: string): boolean {
    return /^t_[a-f0-9]{12}$/.test(value);
}

export function formatTaskHeader(task: Pick<TaskSnapshot, "id" | "kind" | "status">): string {
    return `task_id: ${task.id}\nkind: ${task.kind}\nstatus: ${task.status}`;
}

export function formatTaskSummary(task: TaskSnapshot): string {
    const label = task.kind === "shell" ? task.command : task.kind === "agent" ? task.description : task.kind === "review" ? `Advisory task review: rounds ${task.fromRound}-${task.toRound}; do not wait for this task` : "Memory maintenance";
    return `${formatTaskHeader(task)}${task.kind === "shell" ? `\nphase: ${task.phase}` : ""}\n${label.replace(/\s+/g, " ").slice(0, 160)}`;
}
