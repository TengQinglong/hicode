import type {ToolContext} from "../types.js";
import {formatTaskSummary, isTaskId} from "../../tasks/format.js";
import type {TaskSnapshot} from "../../tasks/types.js";

function recoveryOrder(task: TaskSnapshot): number {
    if (task.kind !== "shell" && task.kind !== "agent") return 2;
    return task.status === "running" ? 0 : 1;
}

export async function taskLookupFailure(ctx: ToolContext, id: string | undefined, action: string): Promise<string> {
    const reason = id === undefined || id === "" ? `${action} requires task_id.`
        : !isTaskId(id) ? "Invalid task_id format. Copy the complete task_id from a task result."
            : "Background task not found in this Session's accessible tasks.";
    const tasks = [...(await ctx.tasks?.list() ?? [])].sort((a, b) => recoveryOrder(a) - recoveryOrder(b));
    const candidate = tasks.find(task => task.kind === "shell" || task.kind === "agent");
    return [reason,
        tasks.length ? "Accessible tasks:" : "No accessible tasks. No command was started or restarted.",
        ...tasks.slice(0, 6).map(formatTaskSummary),
        ...(tasks.length > 6 ? [`${tasks.length - 6} more tasks; use task {\"action\":\"list\"}.`] : []),
        ...(candidate ? [`Inspect an existing task: ${JSON.stringify({action: "status", task_id: candidate.id})}`] : []),
        ...(action === "wait" && tasks.length && !candidate
            ? ["No Shell or Agent tasks are available to wait for. Review and Memory tasks do not support wait."] : []),
    ].join("\n");
}
