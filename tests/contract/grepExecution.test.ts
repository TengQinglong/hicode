import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";

test("native regex errors remain failures; PCRE and multiline are explicit rg options", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "source.txt"), "前文\r\n中文 AbAb tail\r\n后文");
        const ctx = createTestContext(cwd);
        const run = (command: string) => executeToolResult("bash", JSON.stringify({command}), ctx, command);
        expect((await run("rg -e '[' source.txt")).outcome).toBe("failed");
        for (const command of ["rg -n -i -P -C 1 -e '(?<=中文 )([a-z]{2})\\1(?= tail)' source.txt", "rg -n -U -C 1 -e '前文\\r?\\n中文' source.txt"]) {
            const found = await run(command);
            expect(found.outcome).toBe("ok");
            expect(found.modelContent).toContain("中文 AbAb tail");
            expect(found.modelContent).toContain("前文");
        }
        const compound = await run("rg -e ABSENT source.txt && echo unreachable");
        expect(compound.outcome).toBe("failed");
        expect(compound.modelContent).not.toContain("No matches found");
    });
});

test("the last search command reports exit 1 as no matches without hiding actual errors", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "source.txt"), "present\n");
        const ctx = createTestContext(cwd);
        const run = (command: string) => executeToolResult("bash", JSON.stringify({command}), ctx, command);
        for (const command of [
            "rg -n ABSENT source.txt",
            `cd '${cwd}' && rg -n ABSENT source.txt`,
            "printf '' && grep -n ABSENT source.txt",
        ]) {
            const result = await run(command);
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toContain("No matches found (");
            expect(result.modelContent).toContain("exit code 1");
        }
        for (const command of [
            "rg -n -e '[' source.txt",
            "rg -n ABSENT missing.txt",
            "cd missing && rg -n ABSENT source.txt",
        ]) {
            const result = await run(command);
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).not.toContain("No matches found");
        }
    });
});

test("large saved results are searched without the old per-file limit and remain session scoped", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const long = await ctx.toolResultStore.persistText({toolCallId: "long", toolName: "bash",
            content: "😀".repeat(150_000) + "NEEDLE_MIDDLE" + "你".repeat(200_000)});
        expect(long.complete).toBe(true);
        expect(long.preview).not.toContain("NEEDLE_MIDDLE");
        const result = await executeToolResult("bash", JSON.stringify({command: `rg -n -o -F -e NEEDLE_MIDDLE '${long.path}'`}), ctx, "long-search");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("1:NEEDLE_MIDDLE");
        const lines = ("ordinary output".padEnd(1023, "x") + "\n").repeat(5120);
        const saved = await ctx.toolResultStore.persistText({toolCallId: "many", toolName: "bash", content: lines + "before\nERR_ASSERTION at game.test.js:42\nafter\n" + lines});
        expect(saved.byteLength).toBeGreaterThan(10 * 1024 * 1024);
        const command = `rg -n -C 1 -e ERR_ASSERTION '${saved.path}'`;
        const found = await executeToolResult("bash", JSON.stringify({command}), ctx, "many-search");
        expect(found.outcome).toBe("ok");
        expect(found.modelContent).toContain("5122:ERR_ASSERTION");
        expect(found.modelContent).toContain("game.test.js:42");
        expect(found.modelContent).toContain("before");
        expect(found.modelContent).toContain("after");
        const foreign = await executeToolResult("bash", JSON.stringify({command}), createTestContext(cwd, {sessionId: "other"}), "foreign");
        expect(foreign.outcome).toBe("denied");
        expect(foreign.modelContent).not.toContain("game.test.js:42");
    });
});


test("search no-match and real errors agree across foreground, managed inline and background completion", async () => {
    await withTempProject(async cwd => {
        const {createTaskRuntimeForTest} = await import("../helpers/taskRuntime.js");
        const {waitForTaskCompletion} = await import("../../src/tasks/wait.js");
        const ctx = createTestContext(cwd, {permissionMode: "full-access"});
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
        const tasks = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        await writeFile(join(cwd, "source.txt"), "present\n");
        try {
            for (const [command, expected] of [["true; rg ABSENT source.txt", "ok"], ["true; rg ABSENT missing.txt", "failed"], ["true; exit 1", "failed"]] as const) {
                for (const context of [ctx, {...ctx, tasks}]) {
                    const result = await executeToolResult("bash", JSON.stringify({command}), context, command);
                    expect(result.outcome).toBe(expected);
                    if (expected === "ok") expect(result.modelContent).toContain("No matches found");
                }
                const started = await tasks.startShell({command, cwd, toolCallId: command});
                await waitForTaskCompletion(tasks, [started.id], ctx.signal, "shell");
                const waited = await executeToolResult("task", JSON.stringify({action: "wait", task_id: started.id}), {...ctx, tasks}, "wait");
                expect(waited.outcome).toBe(expected);
                if (expected === "ok") {
                    expect(waited.modelContent).toContain("No matches found");
                    expect((await tasks.get(started.id))?.status).toBe("completed");
                    expect((await tasks.get(started.id))).toMatchObject({termination: {kind: "exit", code: 1}});
                }
            }
        } finally {await runtime.close();}
    });
});
