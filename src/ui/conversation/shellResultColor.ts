import type {ShellResultReceipt} from "../../tools/bash/receipt.js";
import {COLORS} from "../theme.js";

export function shellResultColor(result: ShellResultReceipt): string {
    if (result.outputFailed) return COLORS.error;
    switch (result.termination) {
        case "exit": case "aborted": return COLORS.dim;
        case "timeout": case "signal": return COLORS.warning;
        case "spawn_error": case "output_limit": return COLORS.error;
    }
}
