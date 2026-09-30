import type {ToolContext} from "../types.js";
import {formatTaskSummary, isTaskId} from "../../tasks/format.js";

export async function taskLookupFailure(ctx: ToolContext, id: string | undefined, action: string): Promise<string> {
    const reason = id === undefined || id === "" ? `${action} requires task_id.`
        : !isTaskId(id) ? "Invalid task_id format. Copy the complete task_id from a task result."
            : "Background task not found in this Session's accessible tasks.";
    const tasks = await ctx.tasks?.list() ?? [];
    return [reason,
        tasks.length ? "Accessible tasks:" : "No accessible tasks. No command was started or restarted.",
        ...tasks.slice(0, 6).map(formatTaskSummary),
        ...(tasks.length > 6 ? [`${tasks.length - 6} more tasks; use task {\"action\":\"list\"}.`] : []),
        ...(tasks[0] ? [`Inspect an existing task: ${JSON.stringify({action: "status", task_id: tasks[0].id})}`] : []),
    ].join("\n");
}
