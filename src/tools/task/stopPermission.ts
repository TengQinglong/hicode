import {taskLookupFailure} from "./recovery.js";
import {isTaskId} from "../../tasks/format.js";
import type {PermissionResult} from "../../permissions/index.js";
import type {ToolContext} from "../types.js";

export async function checkTaskStopPermission(
    ctx: ToolContext,
    taskId: string | undefined
): Promise<PermissionResult> {
    if (!ctx.tasks) return {behavior: "deny", message: "This Runtime does not support background tasks"};
    if (!taskId || !isTaskId(taskId)) return {behavior: "deny", message: await taskLookupFailure(ctx, taskId, "stop/interrupt")};
    // list does not consume notifications; Runtime revalidates ownership when stopping.
    const task = (await ctx.tasks.list()).find(task =>
        task.id === taskId && task.owner.sessionId === ctx.tasks?.sessionId
    );
    if (!task) return {behavior: "deny", message: await taskLookupFailure(ctx, taskId, "stop/interrupt")};
    return {behavior: "allow"};
}
