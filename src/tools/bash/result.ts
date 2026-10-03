import {basename} from "node:path";
import {parseShellCommand} from "../../permissions/shellCommand.js";
import type {ShellExecutionResult} from "./process.js";

export function noMatchSearch(command: string, result: ShellExecutionResult): "rg" | "grep" | undefined {
    if (result.termination.kind !== "exit" || result.termination.code !== 1 || result.termination.signal !== null ||
        result.stdout.trim() || result.stderr.trim() || result.outputComplete === false) return undefined;
    // This is a result hint, never an execution or permission decision. As in a shell,
    // the final command usually determines the status of a command list.
    const lastProgram = parseShellCommand(command).segments.at(-1)?.tokens[0];
    const name = lastProgram ? basename(lastProgram) : undefined;
    return name === "rg" || name === "grep" ? name : undefined;
}

export function shellOutcome(command: string, result: ShellExecutionResult): "ok" | "failed" | "interrupted" {
    if (result.termination.kind === "aborted") return "interrupted";
    return noMatchSearch(command, result) || (result.termination.kind === "exit" && result.termination.code === 0)
        ? "ok"
        : "failed";
}
