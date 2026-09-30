import {expect, test} from "bun:test";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const probe = fileURLToPath(new URL("../diagnostics/qwenTokenPlan.ts", import.meta.url));
const preload = fileURLToPath(new URL("../fixtures/qwenTokenPlanMock.ts", import.meta.url));
const key = "sk-sp-offline-fixture-key";

async function run(cwd: string, args: string[], fixture = "ok") {
    const env = {...testChildEnvironment.base, QWEN_TOKEN_PLAN_FIXTURE_CASE: fixture, QWEN_TOKEN_PLAN_API_KEY: ""};
    const child = Bun.spawn([process.execPath, "--preload", preload, probe, ...args], {cwd, env,
        stdout: "pipe", stderr: "pipe"});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return {code, stdout, stderr};
}

test("Token Plan probe verifies text, usage tail and paired tools offline without logging credentials", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, ".env.qwen-token-plan"), `QWEN_TOKEN_PLAN_API_KEY=${key}\n`);
        const result = await run(cwd, ["--live", "--mode", "all", "--report", "result.json"]);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain(key);
        const raw = await readFile(join(cwd, "result.json"), "utf8");
        expect(raw).not.toContain(key);
        const report = JSON.parse(raw);
        expect(report.attempts.map((attempt: {label: string; status: string}) => [attempt.label, attempt.status])).toEqual([
            ["text", "ok"], ["stream", "ok"], ["tool_call", "ok"], ["tool_receipt", "ok"],
        ]);
        expect(report.attempts[0].result.usage.prompt_tokens_details.cached_tokens).toBe(12);
        expect(report.attempts[1].result.usage).toEqual({prompt_tokens: 40, completion_tokens: 8, total_tokens: 48});
        expect(report.credits.actual).toBeNull();
        expect(report.policy).toMatchObject({maxRequests: 4, maxTokensPerRequest: 128, automaticRetries: 0});
    });
});

test("HTTP failure is recorded and redacted, with no automatic retry", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, ".env.qwen-token-plan"), `QWEN_TOKEN_PLAN_API_KEY=${key}\n`);
        const result = await run(cwd, ["--live", "--mode", "all", "--report", "result.json"], "http-error");
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("HTTP 401");
        expect(result.stderr).not.toContain(key);
        const raw = await readFile(join(cwd, "result.json"), "utf8");
        expect(raw).not.toContain(key);
        expect(JSON.parse(raw).attempts).toHaveLength(1);
        expect(JSON.parse(raw).attempts[0]).toMatchObject({status: "failed", httpStatus: 401});
    });
});

test("Token Plan credentials are opaque and allow printable token encoding characters", async () => {
    await withTempProject(async cwd => {
        const opaque = "sk-sp-offline.fixture+token/key=";
        await writeFile(join(cwd, ".env.qwen-token-plan"), `QWEN_TOKEN_PLAN_API_KEY=${opaque}\n`);
        const result = await run(cwd, ["--live", "--report", "result.json"], "opaque-key");
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain(opaque);
        expect(await readFile(join(cwd, "result.json"), "utf8")).not.toContain(opaque);
    });
});

test("tool completion mismatch preserves response evidence and sends no receipt", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, ".env.qwen-token-plan"), `QWEN_TOKEN_PLAN_API_KEY=${key}\n`);
        const result = await run(cwd, ["--live", "--mode", "tool-call", "--report", "result.json"], "tool-stop");
        expect(result.code).toBe(1);
        const report = JSON.parse(await readFile(join(cwd, "result.json"), "utf8"));
        expect(report.policy.maxRequests).toBe(1);
        expect(report.attempts).toHaveLength(1);
        expect(report.attempts[0].received.finishReason).toBe("stop");
        expect(report.attempts[0].received.toolCalls[0].function.name).toBe("echo_probe");
        expect(report.attempts[0].received.usage.total_tokens).toBe(48);
    });
});

test.each(["qwen3.8-flash", "deepseek-v4.1-flash"])("%s streaming tools reuse the production parser and preserve wire evidence", async model => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, ".env.qwen-token-plan"), `QWEN_TOKEN_PLAN_API_KEY=${key}\n`);
        const result = await run(cwd, ["--live", "--mode", "stream-tools", "--tool-choice", "auto", "--model", model, "--report", "result.json"]);
        expect(result.code).toBe(0);
        const report = JSON.parse(await readFile(join(cwd, "result.json"), "utf8"));
        expect(report.policy.maxRequests).toBe(2);
        expect(report.attempts).toHaveLength(2);
        expect(report.attempts[0].result.toolCalls[0].function.arguments).toBe('{"value":"TOKEN_PLAN_OK"}');
        expect(report.attempts[0].wireSse).toContain('"finish_reason":"tool_calls"');
    });
});

test("stream stop/tool mismatch retains wire and API usage without sending a receipt", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, ".env.qwen-token-plan"), `QWEN_TOKEN_PLAN_API_KEY=${key}\n`);
        const result = await run(cwd, ["--live", "--mode", "stream-tools", "--tool-choice", "forced", "--report", "result.json"], "tool-stop");
        expect(result.code).toBe(1);
        const report = JSON.parse(await readFile(join(cwd, "result.json"), "utf8"));
        expect(report.attempts).toHaveLength(1);
        expect(report.attempts[0].protocolDiagnostic).toMatchObject({code: "inconsistent_completion", done: true, finishReason: "stop"});
        expect(report.attempts[0].wireSse).toContain('"finish_reason":"stop"');
        expect(report.attempts[0].reportedUsage.total_tokens).toBe(48);
    });
});

test("help, missing dedicated Key and existing report fail without making live requests", async () => {
    await withTempProject(async cwd => {
        expect((await run(cwd, [], "no-fetch")).code).toBe(0);
        const missing = await run(cwd, ["--live", "--report", "result.json"], "no-fetch");
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("缺少 QWEN_TOKEN_PLAN_API_KEY");
        await writeFile(join(cwd, ".env.qwen-token-plan"), `QWEN_TOKEN_PLAN_API_KEY=${key}\n`);
        await writeFile(join(cwd, "result.json"), "old evidence");
        expect((await run(cwd, ["--live", "--report", "result.json"], "no-fetch")).code).toBe(1);
        expect(await readFile(join(cwd, "result.json"), "utf8")).toBe("old evidence");
    });
});
