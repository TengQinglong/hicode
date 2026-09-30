import type {TaskSessionLike} from "./types.js";

/** Subscribe before reading so completion between registration and inspection cannot be lost. */
export function waitForTaskCompletion(tasks: Pick<TaskSessionLike, "get" | "subscribe">, ids: readonly string[], signal: AbortSignal, kind: "agent" | "shell" | "result"): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            signal.removeEventListener("abort", abort);
            if (error !== undefined) reject(error); else resolve();
        };
        const abort = () => finish(signal.reason);
        const inspect = async () => {
            try {
                const snapshots = await Promise.all(ids.map(id => tasks.get(id)));
                if (snapshots.some(task => !task || (kind === "result" ? task.kind === "memory" : task.kind !== kind))) throw new Error(`Cannot wait for an unavailable ${kind} task`);
                if (!snapshots.length || snapshots.some(task => task?.status !== "running")) finish();
            } catch (error) {finish(error);}
        };
        unsubscribe = tasks.subscribe(event => {
            if (ids.includes(event.task.id) && event.type === "task_finished") void inspect();
        });
        signal.addEventListener("abort", abort, {once: true});
        if (signal.aborted) abort(); else void inspect();
    });
}

/** Race task completion against safe-boundary input, cancelling the losing subscription. */
export async function waitForTaskActivity(
    tasks: Pick<TaskSessionLike, "get" | "subscribe">,
    ids: readonly string[],
    signal: AbortSignal,
    kind: "agent" | "shell" | "result",
    waitForInput: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
    signal.throwIfAborted();
    const wake = new AbortController();
    const waitSignal = AbortSignal.any([signal, wake.signal]);
    try {
        await Promise.race([
            waitForTaskCompletion(tasks, ids, waitSignal, kind),
            waitForInput(waitSignal),
        ]);
        signal.throwIfAborted();
    } finally {wake.abort();}
}
