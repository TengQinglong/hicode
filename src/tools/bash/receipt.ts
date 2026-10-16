import {z} from "zod";
import type {ShellTermination} from "./process.js";

export const shellResultReceiptSchema = z.object({
    termination: z.enum(["exit", "signal", "aborted", "timeout", "output_limit", "spawn_error"]),
    outputFailed: z.boolean(),
}).strict();
export type ShellResultReceipt = z.infer<typeof shellResultReceiptSchema>;

export function shellResultReceipt(termination: ShellTermination, outputFailed = false): ShellResultReceipt {
    return {
        termination: termination.kind === "exit" && termination.signal ? "signal"
            : termination.kind === "aborted" && termination.reason === "timeout" ? "timeout" : termination.kind,
        outputFailed,
    };
}

export function shellResultUI(termination: ShellTermination | undefined, outputFailed = false) {
    return termination ? {uiData: {type: "shell_result" as const, receipt: shellResultReceipt(termination, outputFailed)}} : {};
}
