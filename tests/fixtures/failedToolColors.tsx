import {cleanup, render} from "ink-testing-library";
import {MessageList} from "../../src/ui/conversation/MessageList.js";
import type {UIThread} from "../../src/ui/conversation/types.js";
import type {ShellResultReceipt} from "../../src/tools/bash/receipt.js";

const receipts: Record<string, ShellResultReceipt | undefined> = {
    exit: {termination: "exit", outputFailed: false},
    signal: {termination: "signal", outputFailed: false},
    timeout: {termination: "timeout", outputFailed: false},
    cancelled: {termination: "aborted", outputFailed: false},
    spawn: {termination: "spawn_error", outputFailed: false},
    outputLimit: {termination: "output_limit", outputFailed: false},
    delivery: {termination: "exit", outputFailed: true},
    unknown: undefined,
};
const frames: Record<string, {normal: string; transcript: string}> = {};
for (const [id, receipt] of Object.entries(receipts)) {
    const threads: UIThread[] = [{
        id, role: "tool_call", toolCallId: id, name: "bash",
        args: JSON.stringify({command: "pytest -q"}), status: "done",
        outcome: id === "cancelled" ? "interrupted" : "failed",
        ...(receipt ? {uiData: {type: "shell_result", receipt}} : {}),
        result: "Command exited with code 1:\nEXIT=0\nFAILED example.py::test_case",
    }, {
        id: `${id}-task`, role: "task_notification", kind: "shell", taskId: "t_123456789abc",
        status: id === "cancelled" ? "cancelled" : "failed",
        ...(receipt ? {shellResult: receipt} : {}),
        label: "pytest -q", summary: "exit 1 · FAILED example.py::test_case",
    }];
    const normal = render(<MessageList threads={threads}/>).lastFrame() ?? "";
    cleanup();
    const transcript = render(<MessageList threads={threads} transcript/>).lastFrame() ?? "";
    cleanup();
    frames[id] = {normal, transcript};
}
process.stdout.write(JSON.stringify(frames));
