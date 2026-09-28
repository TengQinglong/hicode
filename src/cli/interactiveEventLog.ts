import {closeSync, constants, openSync, realpathSync, writeSync} from "node:fs";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import type {InteractiveEvent} from "../ui/interactiveEvents.js";

/** Explicit CLI export owned by the CLI, outside the untrusted task workspace. */
export function createInteractiveEventLog(path: string, cwd: string, onFailure: () => void) {
    if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error("--event-log requires an absolute file path");
    const target = resolve(realpathSync(dirname(path)), path.split(sep).at(-1)!);
    const inside = relative(realpathSync(cwd), target);
    if (!inside || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside)))
        throw new Error("--event-log must be outside the task workspace");
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let closed = false, failed = false, sequence = 0, bytes = 0, lastProgress = 0;
    return {
        emit(event: InteractiveEvent): void {
            if (closed || failed) return;
            if (event.type === "agent_event" && event.event.type === "assistant_draft") return;
            if (event.type === "agent_event" && event.event.type === "model_stream_progress") {
                if (Date.now() - lastProgress < 1000) return;
                lastProgress = Date.now();
            }
            try {
                const line = Buffer.from(JSON.stringify({version: 1, sequence: ++sequence, at: Date.now(), ...event}) + "\n");
                if (line.byteLength > 8 * 1024 * 1024 || bytes + line.byteLength > 256 * 1024 * 1024)
                    throw new Error("Interactive event export exceeded its size limit");
                for (let offset = 0; offset < line.length;) {
                    const written = writeSync(fd, line, offset, line.length - offset);
                    if (written === 0) throw new Error("Interactive event export stalled");
                    offset += written;
                }
                bytes += line.byteLength;
            } catch {
                failed = true;
                onFailure();
            }
        },
        close(): void {if (!closed) {closed = true; closeSync(fd);}},
    };
}
