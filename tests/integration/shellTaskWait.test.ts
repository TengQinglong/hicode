import {expect, test} from "bun:test";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import {createChildTaskAccess} from "../../src/tasks/childAccess.js";
import {childTaskTool, taskTool} from "../../src/tools/task/task.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";

test("Shell wait returns real output/exit and excludes unrelated services and Agent joins", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        try {
            await tasks.startShell({command: "sleep 30", cwd, toolCallId: "service"});
            const empty = await executeToolResult("task", '{"action":"wait"}', ctx, "empty");
            expect(empty.modelContent).toContain("No delegated");
            const target = await tasks.startShell({command: "printf once; sleep 0.1; printf done; exit 7", cwd, toolCallId: "job"});
            const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), ctx, "wait");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain("exit code 7");
            expect(result.modelContent).toContain("oncedone");
            expect((await tasks.get(target.id))?.status).toBe("failed");
            expect((await tasks.list()).filter(t => t.status === "running")).toHaveLength(1);
        } finally {await runtime.close();}
    });
});

test("cancelling Shell wait preserves the running process and later results", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        try {
            const target = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "job"});
            const controller = new AbortController();
            const ctx = createTestContext(cwd, {tasks, signal: controller.signal});
            const waiting = executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), ctx, "wait");
            controller.abort("user-cancel");
            expect((await waiting).outcome).toBe("interrupted");
            expect((await tasks.get(target.id))?.status).toBe("running");
            await tasks.stop(target.id);
            const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), {...base, tasks}, "after-stop");
            expect(result.modelContent).toContain("Termination:");
        } finally {await runtime.close();}
    });
});

test("child wait exposes only its owned Shell task", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const parent = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const child = createChildTaskAccess(parent, base.toolResultStore).tasks;
        const ctx = createTestContext(cwd);
        ctx.tasks = child;
        try {
            const foreign = await parent.startShell({command: "sleep 30", cwd, toolCallId: "foreign"});
            const own = await child.startShell({command: "sleep 0.1; printf child", cwd, toolCallId: "own"});
            expect(childTaskTool(taskTool).parameters.safeParse({action: "wait", task_id: own.id}).success).toBe(true);
            expect((await executeToolResult("task", JSON.stringify({action: "wait", task_id: foreign.id}), ctx, "foreign-wait")).outcome).toBe("failed");
            expect((await executeToolResult("task", JSON.stringify({action: "wait", task_id: own.id}), ctx, "own-wait")).modelContent).toContain("child");
        } finally {await runtime.close();}
    });
});

test("Shell wait wakes for user input without consuming it or stopping the process", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const queue = new RuntimeMessageQueue();
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore, messageQueue: queue});
        const ctx = createTestContext(cwd, {tasks});
        ctx.agentMessaging = tasks.messaging;
        try {
            const target = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "job"});
            const waiting = executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), ctx, "wait");
            queue.enqueueUser("new requirement");
            const result = await waiting;
            expect(result.modelContent).toContain("New input is available");
            expect((await tasks.get(target.id))?.status).toBe("running");
            expect(queue.createAgentInputChannel(() => {}).drainSafeBoundary()).toHaveLength(1);
        } finally {await runtime.close();}
    });
});
