import {createTaskJournal} from "../../src/tasks/journal.js";
import {callOpenAICompatible} from "../../src/llm/providers/openAICompatible.js";
import {expect, test, spyOn} from "bun:test";
import {join} from "node:path";
import {readFile} from "node:fs/promises";
import type {AgentRunner} from "../../src/agent/runner.js";
import type {SubagentResult, CreateTaskReviewThread} from "../../src/subagents/types.js";
import type {StartTaskReviewInput, TaskReviewSnapshot} from "../../src/tasks/types.js";
import {TaskReviewProgress} from "../../src/agent/taskReview.js";
import {prepareAgentInvoke} from "../../src/agent/invokePreparation.js";
import {createSubagentFactories} from "../../src/subagents/runSubagent.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import {runAgentForTest} from "../helpers/agent.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {withTempProject} from "../helpers/tempProject.js";
import {assistantText, assistantToolCall, createFakeLLM, fixtureToolSchemas} from "../helpers/fakeLLM.js";
import {getSubagentStorageDirectory} from "../../src/persistence/layout.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {resolve = done;});
    return {promise, resolve};
}
const report = JSON.stringify({summary: "Read the relevant code and ran a reproduction.",
    suggestions: [{round: 9, evidence: "The reproduction still fails.", nextStep: "Resolve that counterexample before broadening tests."}]});
const steps = () => Array.from({length: 10}, (_, i) => assistantToolCall("read_file", {path: "source.py"}, `read-${i}`));
const bindings = {getToolSchemas: () => fixtureToolSchemas("read_file"), executeTool: async () => "observed result",
    isToolConcurrencySafe: () => false};

function reviewResult(agentId: string, reply = report): SubagentResult {
    return {agentId, agentType: "TaskReview", description: "review", reply, reason: "completed", iterations: 1,
        toolUseCount: 0, durationMs: 1};
}

test("round 10 launches review without blocking round 11 or final completion; Turn teardown cancels it", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const started = deferred<AbortSignal>();
        let reviews = 0;
        const factory: CreateTaskReviewThread = options => ({agentId: options.agentId, async run(input) {
            reviews++;
            started.resolve(input.signal);
            await new Promise<void>(resolve => {
                if (input.signal.aborted) resolve();
                else input.signal.addEventListener("abort", () => resolve(), {once: true});
            });
            return {...reviewResult(options.agentId), reason: "interrupted"};
        }});
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, undefined, undefined, undefined, undefined, undefined, factory);
        const session = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks: session, taskReviewEnabled: true});
        const fake = createFakeLLM([...steps(), async options => {
            // Reaching this model request proves the main loop did not await the reviewer.
            const signal = await started.promise;
            expect(signal.aborted).toBe(false);
            expect(options.messages.some(m => typeof m.content === "string" && m.content.includes("<task-review>"))).toBe(false);
            return assistantText("done");
        }]);
        try {
            const history = createInitialHistory(cwd, "glm-test");
            const result = await runAgentForTest("Fix the task", history, () => {}, ctx, {callLLM: fake.callLLM, ...bindings});
            expect(result.reason).toBe("completed");
            expect(fake.calls).toHaveLength(11);
            expect(ctx.taskJoin?.ids).toEqual([]);
            expect((await started.promise).aborted).toBe(true);
            await runtime.close();
            expect(reviews).toBe(1);
            expect((await session.list()).find(task => task.kind === "review")).toMatchObject({status: "cancelled", owner: {turnId: ctx.turnId}});
            expect(await session.pendingNotifications()).toEqual([]);
            const next = createFakeLLM([assistantText("next task")]);
            await runAgentForTest("Another task", history, () => {}, createTestContext(cwd), {callLLM: next.callLLM});
            expect(JSON.stringify(next.calls)).not.toContain("<task-review>");
        } finally {await runtime.close();}
    });
});

test("a delayed review is injected once at the request tail with the frozen round range", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const started = deferred<void>();
        const finish = deferred<void>();
        const published = deferred<void>();
        let captured = "";
        const factory: CreateTaskReviewThread = (options, request) => ({agentId: options.agentId, async run() {
            captured = request.prompt;
            expect(request.parentTurnId).toBeDefined();
            expect(request.parentToolCallId).toBeUndefined();
            started.resolve(); await finish.promise;
            return reviewResult(options.agentId);
        }});
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, undefined, undefined, undefined, undefined, undefined, factory);
        const session = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        session.subscribe(event => {if (event.type === "task_finished" && event.task.kind === "review") published.resolve();});
        const ctx = createTestContext(cwd, {tasks: session, taskReviewEnabled: true});
        const fake = createFakeLLM([...steps(), async () => {
            await started.promise; finish.resolve(); await published.promise;
            return assistantToolCall("read_file", {path: "later.py"}, "read-later");
        }, options => {
            expect(options.messages.at(-1)).toMatchObject({role: "user", origin: "agent"});
            expect(options.messages.at(-1)?.content).toContain("rounds 1-10 (10 rounds)");
            expect(options.messages.at(-1)?.content).toContain("excludes later progress");
            return assistantToolCall("read_file", {path: "last.py"}, "read-last");
        }, options => {
            expect(JSON.stringify(options.messages)).not.toContain("<task-review>");
            return assistantText("done");
        }]);
        const history = createInitialHistory(cwd, "glm-test");
        try {
            await runAgentForTest("Keep the original task requirements", history, () => {}, ctx, {callLLM: fake.callLLM, ...bindings});
            expect(captured).toContain("Keep the original task requirements");
            expect(captured).toContain("read-9");
            expect(captured).not.toContain("later.py");
            expect(JSON.stringify(history)).not.toContain("<task-review>");
            expect(await session.pendingNotifications()).toEqual([]);
        } finally {await runtime.close();}
    });
});

test("busy reviews do not stack; changed user requirements invalidate old results and preserve bounded evidence", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd, {taskReviewEnabled: true});
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        const first = deferred<TaskReviewSnapshot>();
        const second = deferred<TaskReviewSnapshot>();
        const inputs: StartTaskReviewInput[] = [];
        session.startReview = input => {inputs.push(input); return inputs.length === 1 ? first.promise : second.promise;};
        const active = createTestContext(cwd, {tasks: session, taskReviewEnabled: true});
        const progress = new TaskReviewProgress(active, "Original target", "user", [{role: "user", origin: "user", content: "Earlier original requirement"}]);
        const snapshot: TaskReviewSnapshot = {id: "t_0123456789ab", kind: "review", status: "completed", owner: {sessionId: active.sessionId, turnId: active.turnId},
            startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), fromRound: 1, toRound: 10, resultPreview: report};
        try {
            for (let round = 1; round <= 20; round++) {
                progress.record({type: "tool_call_end", turnId: active.turnId, toolCallId: `call-${round}`, result: "large".repeat(10_000), outcome: "failed"}, round);
                if (round === 10) progress.recordInput({id: "receipt", source: "task_notification", taskId: "t_0123456789ab",
                    content: "Background command completed with exit code 0"}, round);
                progress.completedRound(round);
            }
            expect(inputs).toHaveLength(1);
            expect(inputs[0]?.evidence.activity).toContain("Background command completed with exit code 0");
            expect(inputs[0]?.evidence.activity.length).toBeLessThanOrEqual(24_000);
            expect(inputs[0]?.evidence.activity).toContain("Evidence omitted");
            progress.steer("New restriction: do not change the public interface");
            expect(inputs[0]?.signal.aborted).toBe(true);
            first.resolve(snapshot); await first.promise; await Promise.resolve();
            expect(progress.takeReminder()).toBeUndefined();
            progress.completedRound(30);
            expect(inputs).toHaveLength(2);
            expect(inputs[1]?.evidence.requirements).toContain("Original target");
            expect(inputs[1]?.evidence.requirements).toContain("Earlier original requirement");
            expect(inputs[1]?.evidence.requirements).toContain("do not change the public interface");
            progress.close(); second.resolve({...snapshot, fromRound: 21, toRound: 30});
            await second.promise;
            expect(progress.takeReminder()).toBeUndefined();
        } finally {progress.close(); await runtime.close();}
    });
});

test("tool-free review reuses the child Agent pipeline and records a Turn owner", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd, {taskReviewEnabled: true});
        let calls = 0;
        let hooks = 0;
        ctx.runHook = async () => {hooks++; return {blocked: false, additionalContexts: [], executions: []};};
        const runner: AgentRunner = async (input, history, _event, child, _channel, options) => {
            calls++;
            expect(options.getToolSchemas()).toEqual([]);
            expect(options.maxIterations).toBe(1);
            expect(options.callKind).toBe("task_review");
            expect(child.tasks).toBeUndefined();
            expect(child.subagentLauncher).toBeUndefined();
            expect(child.taskReviewEnabled).toBe(false);
            expect(child.fileState).not.toBe(ctx.fileState);
            expect(child.model).toBe(ctx.fastModel);
            expect(child.sessionId).not.toBe(ctx.sessionId);
            expect(history[0]?.content).toContain("frozen evidence");
            expect(input).toBe("frozen assignment");
            return {reply: report, reason: "completed", iterations: 1};
        };
        const factories = createSubagentFactories({primaryRunAgent: runner, fastRunAgent: runner,
            registry: BUILTIN_SUBAGENT_REGISTRY, createToolResultStore: (path, id) => createTestToolResultStore(path, id)});
        const thread = factories.createTaskReviewThread({parentContext: ctx, agentId: "review-child", onEvent: () => {}},
            {agentType: "TaskReview", parentTurnId: ctx.turnId, description: "review", prompt: "frozen assignment", readOnly: true});
        await thread.run({prompt: "frozen assignment", signal: ctx.signal, inputChannel: new RuntimeMessageQueue().createAgentInputChannel(() => {})});
        expect(calls).toBe(1); expect(hooks).toBe(0);
        const path = join(getSubagentStorageDirectory(ctx.storage, cwd, ctx.sessionId, "review-child"), "events.jsonl");
        const start = JSON.parse((await readFile(path, "utf8")).split("\n")[0]!);
        expect(start.parentTurnId).toBe(ctx.turnId);
        expect(start.parentToolCallId).toBeUndefined();
    });
});

test("invalid or out-of-range reviewer advice fails the advisory task without publishing a main-thread notification", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const factory: CreateTaskReviewThread = options => ({agentId: options.agentId, async run() {
            return reviewResult(options.agentId, JSON.stringify({summary: "guess", suggestions: [{round: 99, evidence: "unseen", nextStep: "guess"}]}));
        }});
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, undefined, undefined, undefined, undefined, undefined, factory);
        const session = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        try {
            const result = await session.startReview({parentContext: base, signal: base.signal,
                evidence: {fromRound: 1, toRound: 10, requirements: "task", activity: "observations"}});
            expect(result.status).toBe("failed");
            expect(result.resultPreview).toBeUndefined();
            expect(await session.pendingNotifications()).toEqual([]);
        } finally {await runtime.close();}
    });
});

test("a review reminder survives request rebuild after compaction without entering History", async () => {
    await withTempProject(async cwd => {
        const history = createInitialHistory(cwd, "glm-test");
        const ctx = createTestContext(cwd);
        const result = await prepareAgentInvoke({history, ctx, onEvent: () => {}, getToolSchemas: () => [], forceCompact: true,
            taskReviewReminder: "<task-review>rounds 1-10: advice</task-review>",
            compactHistory: async () => ({compacted: true, preTokenCount: 1000, threshold: 1})});
        expect(result.invokeMessages.at(-1)?.content).toContain("<task-review>");
        expect(JSON.stringify(history)).not.toContain("<task-review>");
    });
});


test("advisory review remains available in one-shot Hosts and archived results do not leak into later Turns", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const factory: CreateTaskReviewThread = options => ({agentId: options.agentId, async run() {return reviewResult(options.agentId);}});
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, undefined, undefined, undefined, undefined, undefined, factory);
        const binding = {sessionId: base.sessionId, toolResultStore: base.toolResultStore, allowBackgroundTasks: false};
        try {
            const result = await runtime.forSession(binding).startReview({parentContext: base, signal: base.signal,
                evidence: {fromRound: 1, toRound: 10, requirements: "task", activity: "evidence"}});
            expect(result.status).toBe("completed");
            await runtime.close();
            const restored = createTaskRuntimeForTest(cwd, base.shellRunner);
            try {
                const session = restored.forSession(binding);
                expect((await session.list()).find(task => task.kind === "review")).toMatchObject({status: "completed"});
                expect(await session.pendingNotifications()).toEqual([]);
            } finally {await restored.close();}
        } finally {await runtime.close();}
    });
});

test("task-review Provider requests have a bounded output allowance; normal main requests retain their existing behavior", async () => {
    await withTempProject(async (cwd, storage) => {
        const requests: unknown[] = [];
        const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
            if (typeof init?.body !== "string") throw new Error("Expected request JSON");
            requests.push(JSON.parse(init.body));
            return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n',
                {headers: {"Content-Type": "text/event-stream"}});
        }, {preconnect() {}}));
        try {
            for (const kind of ["task_review", "main"] as const) {
                await callOpenAICompatible({messages: [{role: "user", origin: "user", content: "review"}], tools: [], storage, cwd,
                    model: "test-model", kind}, {apiKey: "fake-key", baseUrl: "https://offline.invalid/v1", displayName: "offline"});
            }
            expect(requests[0]).toMatchObject({max_tokens: 2048});
            expect(requests[1]).not.toHaveProperty("max_tokens");
        } finally {fetch.mockRestore();}
    });
});


test("many advisory reviews compact without retaining an undelivered-notification backlog", async () => {
    await withTempProject(async (cwd, storage) => {
        const journal = createTaskJournal(storage, cwd);
        const timestamp = new Date().toISOString();
        for (let sequence = 1; sequence <= 1030; sequence++) {
            await journal.append({version: 8, type: "task_finished", sequence, sessionId: "review-owner", task: {
                id: `t_${sequence.toString(16).padStart(12, "0")}`, kind: "review", owner: {sessionId: "review-owner", turnId: "turn"},
                status: "completed", startedAt: timestamp, completedAt: timestamp, fromRound: 1, toRound: 10, resultPreview: "summary",
            }});
        }
        const loaded = await journal.load("review-owner");
        expect(loaded.pendingRuns).toEqual([]);
        expect(loaded.tasks.length).toBeLessThanOrEqual(64);
        expect(loaded.sequence).toBe(1030);
    });
});
