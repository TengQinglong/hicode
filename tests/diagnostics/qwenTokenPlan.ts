// User-invoked live diagnostic; offline tests run it with a fixture preload.
import {lstat, open, readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {parseArgs} from "node:util";
import {parse as parseEnv} from "dotenv";
import {z} from "zod";
import {consumeOpenAICompatibleSSE, OpenAICompatibleProtocolError} from "../../src/llm/providers/openAICompatibleStream.js";
import type {ToolCall} from "../../src/llm/types.js";

const BASE_URL = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1";
const KEY_ENV = "QWEN_TOKEN_PLAN_API_KEY";
const MARKER = "TOKEN_PLAN_OK";
const TOOL_NAME = "echo_probe";
const MAX_TOKENS = 128;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TOOL_INPUT = z.object({value: z.literal(MARKER)}).strict();
const usageSchema = z.object({
    prompt_tokens: z.number().int().nonnegative().safe(),
    completion_tokens: z.number().int().nonnegative().safe(),
    total_tokens: z.number().int().positive().safe(),
}).passthrough();
const toolCallSchema = z.object({id: z.string().min(1), type: z.literal("function"),
    function: z.object({name: z.string().min(1), arguments: z.string().max(8192)})});
const responseSchema = z.object({id: z.string().optional(), model: z.string().optional(),
    choices: z.array(z.object({message: z.object({role: z.literal("assistant"),
        content: z.string().nullable().optional(), tool_calls: z.array(toolCallSchema).max(1).optional()}),
        finish_reason: z.enum(["stop", "tool_calls"])})).length(1), usage: usageSchema});

type WireMessage = {role: "system" | "user" | "tool"; content: string; tool_call_id?: string}
    | {role: "assistant"; content: string | null; tool_calls?: ToolCall[]};
type Usage = z.infer<typeof usageSchema>;
type Reply = {content: string; toolCalls: ToolCall[]; usage: Usage; finishReason?: string; actualModel?: string; responseId?: string};
type Attempt = {label: string; durationMs: number; httpStatus?: number; requestId?: string; wireSse?: string} &
    ({status: "ok"; result: Reply} | {status: "failed"; error: string; received?: Reply;
        protocolDiagnostic?: OpenAICompatibleProtocolError["diagnostic"]; reportedUsage?: Usage});

const HELP = `Token Plan 手动接入诊断（默认不发送请求）
  bun tests/diagnostics/qwenTokenPlan.ts --help
  bun tests/diagnostics/qwenTokenPlan.ts --live --report /private/tmp/qwen-token-plan-probe.json
  bun tests/diagnostics/qwenTokenPlan.ts --live --mode all --report /private/tmp/qwen-token-plan-all.json

参数：
  --mode text|stream|tool-call|tools|stream-tools|all   默认 text；stream-tools 最多 2 次请求
  --model qwen3.8-flash|qwen3.8-max|deepseek-v4.1-flash   默认 qwen3.8-flash
  --tool-choice auto|forced    默认 auto；forced 用于定位强制调用的协议差异
  --env-file PATH              默认项目 .env.qwen-token-plan；只读取 ${KEY_ENV}
  --timeout-ms N               单请求硬上限 1000–120000ms，默认 60000ms
  --report PATH               必填；新建结果 JSON，不覆盖已有文件

专用 Key：${KEY_ENV}=sk-sp-...（环境变量优先，不读取普通 DASHSCOPE_API_KEY）
固定 Base URL：${BASE_URL}；不允许重定向或切换到按量计费接口。
每次请求 max_tokens=${MAX_TOKENS}，关闭思考，串行执行，无自动重试。
usage 是 API 的 token 用量；实际 Credits 扣量请对照工作台，脚本不猜换算系数。
仅供本人在当前交互式编程会话中手动验证接入，不用于后台循环或批量评测。`;

function options() {
    const values = (() => {
        try {
            return parseArgs({args: process.argv.slice(2), strict: true, options: {
            help: {type: "boolean"}, live: {type: "boolean"}, mode: {type: "string", default: "text"},
            model: {type: "string", default: "qwen3.8-flash"}, "env-file": {type: "string", default: ".env.qwen-token-plan"},
            "tool-choice": {type: "string", default: "auto"},
            "timeout-ms": {type: "string", default: "60000"}, report: {type: "string"},
            }}).values;
        } catch {throw new Error("参数无效；用 --help 查看用法。不要在命令行传 Key。");}
    })();
    if (values.help || !values.live) {console.log(HELP); return undefined;}
    return z.object({mode: z.enum(["text", "stream", "tool-call", "tools", "stream-tools", "all"]),
        model: z.enum(["qwen3.8-flash", "qwen3.8-max", "deepseek-v4.1-flash"]), envFile: z.string().min(1),
        toolChoice: z.enum(["forced", "auto"]),
        timeoutMs: z.coerce.number().int().min(1000).max(120000), report: z.string().min(1),
    }).parse({mode: values.mode, model: values.model, envFile: values["env-file"],
        timeoutMs: values["timeout-ms"], report: values.report, toolChoice: values["tool-choice"]});
}

async function credential(envFile: string): Promise<string> {
    let key = process.env[KEY_ENV];
    if (!key) {
        const path = resolve(envFile);
        let info;
        try {info = await lstat(path);} catch {throw new Error(`缺少 ${KEY_ENV}；请填入指定的专用 env 文件。`);}
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error("Key 文件必须是小型普通文件。");
        key = parseEnv(await readFile(path, "utf8"))[KEY_ENV];
    }
    if (!key?.startsWith("sk-sp-") || key.length <= 6 || key.length > 1024 || !/^[\x21-\x7e]+$/.test(key)) {
        throw new Error(`需要 Token Plan 专用 sk-sp- Key，请检查 ${KEY_ENV}。`);
    }
    return key;
}

async function boundedText(response: Response): Promise<string> {
    if (!response.body) throw new Error("API 响应缺少正文。");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new Error("API 响应超出诊断预算。");
            parts.push(next.value);
        }
        return Buffer.concat(parts).toString("utf8");
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

async function main() {
    const parsedOptions = options();
    if (!parsedOptions) return;
    const config = parsedOptions;
    const key = await credential(config.envFile);
    const redact = (text: string) => text.replaceAll(key, "[REDACTED]").replace(/sk-(?:sp-|ws-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
    const reportPath = resolve(config.report);
    const report = {date: new Date().toISOString(), baseUrl: BASE_URL, model: config.model, mode: config.mode,
        policy: {maxRequests: config.mode === "all" ? 4 : config.mode === "tools" || config.mode === "stream-tools" ? 2 : 1,
            maxTokensPerRequest: MAX_TOKENS, thinking: false, toolChoice: config.toolChoice,
            timeoutMs: config.timeoutMs, automaticRetries: 0},
        credits: {actual: null, note: "API token 用量不能直接换成 Credits；以工作台使用明细及当时转换系数为准。",
            documentation: "https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-overview"},
        attempts: [] as Attempt[],
    };
    // Reserve before sending requests, so an existing result never causes an accidental rerun.
    const handle = await open(reportPath, "wx", 0o600);
    const save = async () => {
        const text = redact(JSON.stringify(report, null, 2)) + "\n";
        await handle.truncate(0);
        await handle.write(text, 0, "utf8");
        await handle.sync();
    };
    const tools = [{type: "function", function: {name: TOOL_NAME,
        description: "Echo the supplied diagnostic value; this fixture performs no external action.",
        parameters: {type: "object", properties: {value: {type: "string", const: MARKER}},
            required: ["value"], additionalProperties: false}}}];
    const messages: WireMessage[] = [{role: "system", content: "This is a small API connectivity diagnostic. Follow the requested output format."},
        {role: "user", content: `Reply exactly ${MARKER}, without explanations.`}];

    async function request(label: string, input: WireMessage[], stream = false, callTool = false): Promise<Reply> {
        const started = performance.now();
        let httpStatus: number | undefined, requestId: string | undefined;
        let received: Reply | undefined;
        const wireChunks: Uint8Array[] = [];
        let wireBytes = 0;
        const wire = () => stream ? {wireSse: Buffer.concat(wireChunks).toString("utf8")} : {};
        try {
            const signal = AbortSignal.timeout(config.timeoutMs);
            const response = await fetch(`${BASE_URL}/chat/completions`, {method: "POST", redirect: "error",
                headers: {"Content-Type": "application/json", Authorization: `Bearer ${key}`},
                signal, body: JSON.stringify({model: config.model,
                    messages: input, max_tokens: MAX_TOKENS, enable_thinking: false, stream,
                    ...(stream ? {stream_options: {include_usage: true}} : {}),
                    ...(callTool ? {tools, tool_choice: config.toolChoice === "auto" ? "auto" :
                        {type: "function", function: {name: TOOL_NAME}}} : {}),
                })});
            httpStatus = response.status;
            requestId = response.headers.get("x-request-id")?.slice(0, 256);
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${redact(await boundedText(response)).slice(0, 1000)}`);
            let result: Reply;
            if (stream) {
                if (!response.body) throw new Error("API 响应缺少 SSE 正文。");
                const captured = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({transform(chunk, controller) {
                    wireBytes += chunk.byteLength;
                    if (wireBytes > MAX_RESPONSE_BYTES) throw new Error("SSE 响应超出诊断预算。");
                    wireChunks.push(chunk);
                    controller.enqueue(chunk);
                }}));
                const parsed = await consumeOpenAICompatibleSSE({body: captured,
                    signal, onActivity() {}});
                result = {content: parsed.content, toolCalls: parsed.toolCalls,
                    usage: usageSchema.parse(parsed.usage), finishReason: parsed.finishReason};
            } else {
                const parsed = responseSchema.parse(JSON.parse(await boundedText(response)));
                const choice = parsed.choices[0]!;
                result = {content: choice.message.content ?? "", toolCalls: choice.message.tool_calls ?? [],
                    usage: parsed.usage, finishReason: choice.finish_reason, actualModel: parsed.model, responseId: parsed.id};
            }
            received = result;
            if (callTool) {
                const call = result.toolCalls[0];
                if (result.toolCalls.length !== 1 || call?.function.name !== TOOL_NAME || result.finishReason !== "tool_calls") throw new Error("工具调用身份或完成状态不符合探针要求。");
                TOOL_INPUT.parse(JSON.parse(call.function.arguments));
            } else if (result.toolCalls.length || result.content.trim() !== MARKER || result.finishReason !== "stop") {
                throw new Error("模型回复未通过固定探针校验。");
            }
            report.attempts.push({label, status: "ok", httpStatus, requestId,
                durationMs: Math.round(performance.now() - started), result, ...wire()});
            await save();
            console.log(`${label}: OK ${redact(JSON.stringify(result.usage))}`);
            return result;
        } catch (error) {
            const message = error instanceof z.ZodError ? "响应或工具参数未通过协议校验。" :
                redact(error instanceof Error ? error.message : "请求失败。");
            report.attempts.push({label, status: "failed", httpStatus, requestId,
                durationMs: Math.round(performance.now() - started), error: message, ...(received ? {received} : {}),
                ...wire(), ...(error instanceof OpenAICompatibleProtocolError ? {
                    protocolDiagnostic: error.diagnostic, reportedUsage: {...error.usage},
                } : {})});
            await save();
            throw new Error(message);
        }
    }
    try {
        await save();
        if (config.mode === "text" || config.mode === "all") await request("text", messages);
        if (config.mode === "stream" || config.mode === "all") await request("stream", messages, true);
        if (config.mode === "tool-call" || config.mode === "tools" || config.mode === "stream-tools" || config.mode === "all") {
            const input: WireMessage[] = [messages[0]!, {role: "user", content: `Call ${TOOL_NAME} once with value ${MARKER}.`}];
            const first = await request("tool_call", input, config.mode === "stream-tools", true);
            if (config.mode === "tool-call") {
                console.log(`REPORT ${reportPath} (仅验证调用，未发送工具回执)`);
                return;
            }
            const call = first.toolCalls[0]!;
            // A pure diagnostic receipt, never execution of model-selected commands or project tools.
            await request("tool_receipt", [...input, {role: "assistant", content: first.content || null, tool_calls: first.toolCalls},
                {role: "tool", tool_call_id: call.id, content: JSON.stringify(TOOL_INPUT.parse(JSON.parse(call.function.arguments)))},
                {role: "user", content: `Reply exactly ${MARKER}, without explanations.`}], config.mode === "stream-tools");
        }
        console.log(`REPORT ${reportPath}`);
        console.log("Credits 未估算；请对照工作台本次使用明细。Key 未写入报告。");
    } finally {await handle.close();}
}

await main().catch(error => {
    console.error(error instanceof z.ZodError ? "参数或响应校验失败，请用 --help 查看用法。" :
        error instanceof Error ? error.message : "诊断失败。");
    process.exitCode = 1;
});
