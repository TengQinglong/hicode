import {createTurnAbortController, normalizeTurnAbortReason} from "../runtime/abort.js";
import type {ShellExecutionResult} from "../tools/bash/process.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import type {StartShellTaskInput, TaskSessionBinding, TaskStatus,} from "./types.js";
import {type ManagedShellTask, readOutputPreview,} from "./managed.js";
import {isExpectedShellShutdown} from "./notifications.js";
import type {FileCommitCoordinator} from "../tools/shared/fileCommit.js";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function statusFromResult(result: ShellExecutionResult): TaskStatus {
    if (result.termination.kind === "aborted") return "cancelled";
    return result.termination.kind === "exit" && result.termination.code === 0
        ? "completed"
        : "failed";
}

export async function createShellTask(
    id: string,
    binding: TaskSessionBinding,
    input: StartShellTaskInput
): Promise<ManagedShellTask> {
    const outputPath = await binding.toolResultStore.createCapture();
    return {
        id,
        phase: "queued",
        createdTick: performance.now(),
        published: false,
        publication: Promise.resolve(),
        executionMode: input.sandboxPermissions === "require_escalated" ? "host" : "sandbox",
        owner: {sessionId: binding.sessionId, toolCallId: input.toolCallId},
        command: input.command,
        cwd: input.cwd,
        status: "running",
        startedAt: new Date().toISOString(),
        outputPath,
        store: binding.toolResultStore,
        controller: createTurnAbortController(),
        notificationPending: false,
        suppressTerminalNotification: false,
        completion: Promise.resolve(),
    };
}

export async function runShellTask(
    task: ManagedShellTask,
    input: StartShellTaskInput,
    shellRunner: ShellRunnerLike,
    execution: {kind: "background" | "continuation"; timeoutMs: number | null; fileCommits: FileCommitCoordinator; onPhaseChanged(): void},
    onFinished: (task: ManagedShellTask) => Promise<void>
): Promise<void> {
    let finalStatus: TaskStatus = "failed";
    try {
        const run = () => {
            task.phase = "starting";
            task.acquiredTick = performance.now();
            task.blockedByTaskId = undefined;
            execution.onPhaseChanged();
            return shellRunner.run({
                command: input.command,
                cwd: input.cwd,
                signal: task.controller.signal,
                timeoutMs: execution.timeoutMs,
                outputFilePath: task.outputPath,
                maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
                previewChars: 30_000,
                onStarted: () => {task.phase = "running"; task.processStartedAt = new Date().toISOString(); task.processStartedTick = performance.now(); execution.onPhaseChanged();},
                sandboxPermissions: input.sandboxPermissions,
                writableRoots: input.writableRoots,
                networkAccess: input.networkAccess,
            });
        };
        const result = execution.kind === "continuation"
            ? await execution.fileCommits.exclusive(task.controller.signal, run, task.id, owner => {task.blockedByTaskId = owner; execution.onPhaseChanged();}) : await run();
        if (!task.published) task.inlineResult = result;
        finalStatus = statusFromResult(result);
        task.termination = result.termination;
        const outputPreview = await readOutputPreview(task.outputPath);
        task.outputPreview = outputPreview;
        // Proxy approval diagnostics are generated after process output capture.
        if (result.stderr.trim() && !task.outputPreview.includes(result.stderr.trim())) {
            task.outputPreview = `${task.outputPreview}\n${result.stderr}`.trim();
        }
        if (task.published || (result.outputBytes ?? 0) > 30_000 || result.outputComplete === false) try {
            task.outputResult = await task.store.promoteFile({
                toolCallId: task.owner.toolCallId,
                toolName: "task",
                sourcePath: task.outputPath,
                originalByteLength: result.outputBytes,
                complete: result.outputComplete,
                resultId: `task_${task.id}`,
            });
        } catch (error) {
            task.outputIssue = error instanceof Error
                ? error.message
                : String(error);
            finalStatus = "failed";
        }
    } catch (error) {
        finalStatus = task.controller.signal.aborted ? "cancelled" : "failed";
        task.outputIssue = error instanceof Error ? error.message : String(error);
        if (!task.published) task.inlineResult = {stdout: "", stderr: "", termination: task.controller.signal.aborted
            ? {kind: "aborted", reason: normalizeTurnAbortReason(task.controller.signal.reason)}
            : {kind: "spawn_error", error: error instanceof Error ? error : new Error(String(error))}};
    } finally {
        task.status = finalStatus;
        task.phase = "finished";
        task.finishedTick = performance.now();
        task.blockedByTaskId = undefined;
        task.completedAt = new Date().toISOString();
        task.notificationPending = !task.suppressTerminalNotification && !isExpectedShellShutdown(task);
        await task.store.removeTemporaryFile(task.outputPath);
        await onFinished(task);
    }
}
