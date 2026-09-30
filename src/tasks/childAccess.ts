import {resolve} from "node:path";
import type {ToolResultStore} from "../toolResults/index.js";
import type {ShellTaskSnapshot, TaskSessionLike, TaskSnapshot} from "./types.js";

/** A child can manage only Shell tasks it created. Root retains resource ownership. */
export type ChildTaskAccess = Pick<TaskSessionLike, "sessionId" | "shellContinuation" | "startShell" | "runShell" | "get" | "list" | "stop" | "subscribe" | "acknowledgeNotification">;

export function isParentTaskSession(tasks: TaskSessionLike | ChildTaskAccess): tasks is TaskSessionLike {
    return "startAgent" in tasks;
}

export function createChildTaskAccess(parent: ChildTaskAccess, files: Pick<ToolResultStore, "resolveFile">): {tasks: ChildTaskAccess; files: Pick<ToolResultStore, "resolveFile">} {
    const owned = new Set<string>();
    const isOwned = (task: TaskSnapshot): task is ShellTaskSnapshot => task.kind === "shell" && owned.has(task.id);
    const tasks: ChildTaskAccess = {
        sessionId: parent.sessionId,
        get shellContinuation() {return parent.shellContinuation;},
        async startShell(input) {
            const task = await parent.startShell(input);
            owned.add(task.id);
            return task;
        },
        async runShell(input) {
            const result = await parent.runShell(input);
            if (result.kind === "task") owned.add(result.task.id);
            return result;
        },
        async acknowledgeNotification(notification) {
            if (!owned.has(notification.taskId)) throw new Error("Cannot acknowledge another task's result");
            await parent.acknowledgeNotification(notification);
        },
        async get(id) {
            if (!owned.has(id)) return undefined;
            const task = await parent.get(id);
            return task && isOwned(task) ? task : undefined;
        },
        async list() {return (await parent.list()).filter(isOwned);},
        async stop(id) {
            if (!owned.has(id)) return undefined;
            return parent.stop(id);
        },
        subscribe(listener) {
            return parent.subscribe(event => {if (isOwned(event.task)) listener(event);});
        },
    };
    return {tasks, files: {async resolveFile(path) {
        const allowed = (await tasks.list()).some(task => task.kind === "shell" && task.outputResult && resolve(task.outputResult.path) === resolve(path));
        return allowed ? files.resolveFile(path) : null;
    }}};
}
