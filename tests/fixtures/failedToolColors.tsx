import {cleanup, render} from "ink-testing-library";
import {MessageList} from "../../src/ui/conversation/MessageList.js";
import type {UIThread} from "../../src/ui/conversation/types.js";

const threads: UIThread[] = [{
    id: "failed-bash", role: "tool_call", toolCallId: "failed-bash", name: "bash",
    args: JSON.stringify({command: "pytest -q"}), status: "done", outcome: "failed",
    result: "Command exited with code 1:\nFAILED example.py::test_case",
}, {
    id: "failed-task", role: "task_notification", kind: "shell", taskId: "t_123456789abc",
    status: "failed", shellTermination: "exit", label: "pytest -q", summary: "exit 1 · FAILED example.py::test_case",
}, {
    id: "runtime-failure", role: "task_notification", kind: "shell", taskId: "t_987654321abc",
    status: "failed", shellTermination: "spawn_error", label: "pytest -q", summary: "spawn error · permission denied",
}];

const view = render(<MessageList threads={threads}/>);
process.stdout.write(JSON.stringify(view.lastFrame()));
cleanup();
