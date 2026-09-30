import {z} from "zod";

const requestSchema = z.object({model: z.enum(["qwen3.8-flash", "qwen3.8-max", "deepseek-v4.1-flash"]),
    messages: z.array(z.object({role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().nullable(), tool_call_id: z.string().optional(), tool_calls: z.array(z.unknown()).optional()})),
    max_tokens: z.literal(128), enable_thinking: z.literal(false), stream: z.boolean(),
    stream_options: z.object({include_usage: z.literal(true)}).optional(),
    tools: z.array(z.unknown()).optional(), tool_choice: z.unknown().optional(),
});
const mode = process.env.QWEN_TOKEN_PLAN_FIXTURE_CASE ?? "ok";
const key = mode === "opaque-key" ? "sk-sp-offline.fixture+token/key=" : "sk-sp-offline-fixture-key";
const usage = {prompt_tokens: 40, completion_tokens: 8, total_tokens: 48,
    prompt_tokens_details: {cached_tokens: 12}, completion_tokens_details: {reasoning_tokens: 0}};
let requests = 0;

globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (mode === "no-fetch") throw new Error("Unexpected live request from offline preflight");
    if (String(input) !== "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/chat/completions" ||
        init?.redirect !== "error" || new Headers(init.headers).get("Authorization") !== `Bearer ${key}` ||
        typeof init.body !== "string" || !init.signal) throw new Error("Invalid probe endpoint, credentials or request boundary");
    requests++;
    if (requests > 4) throw new Error("Probe exceeded request budget");
    const body = requestSchema.parse(JSON.parse(init.body));
    if (mode === "http-error") return new Response(JSON.stringify({error: {message: `Rejected ${key}`}}), {status: 401});
    if (body.stream) {
        if (!body.stream_options?.include_usage) throw new Error("Missing usage tail request");
        const data = [
            {choices: [{delta: body.tools ? {tool_calls: [{index: 0, id: "probe-call", type: "function",
                function: {name: "echo_probe", arguments: '{"value":"TOKEN_'}}]} : {content: "TOKEN_"}, finish_reason: null}], usage: null},
            {choices: [{delta: body.tools ? {tool_calls: [{index: 0, function: {arguments: 'PLAN_OK"}'}}]} : {content: "PLAN_OK"},
                finish_reason: body.tools && mode !== "tool-stop" ? "tool_calls" : "stop"}], usage: null},
            {choices: [], usage},
        ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(data, {headers: {"Content-Type": "text/event-stream"}});
    }
    const tool = body.tools !== undefined;
    const receipt = body.messages.find(message => message.role === "tool");
    if (receipt && (receipt.tool_call_id !== "probe-call" || receipt.content !== '{"value":"TOKEN_PLAN_OK"}')) throw new Error("Incorrect paired tool receipt");
    return Response.json({id: `fixture-${requests}`, model: body.model, choices: [{index: 0,
        message: {role: "assistant", content: tool ? null : "TOKEN_PLAN_OK",
            ...(tool ? {tool_calls: [{id: "probe-call", type: "function", function: {name: "echo_probe", arguments: '{"value":"TOKEN_PLAN_OK"}'}}]} : {})},
        finish_reason: tool && mode !== "tool-stop" ? "tool_calls" : "stop"}], usage});
}, {preconnect() {}});
