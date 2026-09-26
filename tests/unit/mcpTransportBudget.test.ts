import {expect, test} from "bun:test";
import {boundMcpResponse, MCP_MAX_MESSAGE_BYTES, McpTransportLimitError} from "../../src/mcp/transportBudget.js";

async function consume(response: Response): Promise<number> {
    const reader = response.body!.getReader();
    let bytes = 0;
    try {for (;;) {const result = await reader.read(); if (result.done) return bytes; bytes += result.value.byteLength;}}
    finally {reader.releaseLock();}
}

for (const type of ["application/json", "text/event-stream"]) {
    test(`MCP ${type} rejects an oversized incomplete message and cancels upstream`, async () => {
        const chunk = new Uint8Array(1024 * 1024).fill(120);
        let cancelled = false, errors = 0;
        const stream = new ReadableStream<Uint8Array>({pull(controller) {controller.enqueue(chunk);}, cancel() {cancelled = true;}});
        const response = boundMcpResponse(new Response(stream, {headers: {"content-type": type}}), () => {errors++;});
        await expect(consume(response)).rejects.toBeInstanceOf(McpTransportLimitError);
        await Bun.sleep(0);
        expect(cancelled).toBe(true);
        expect(errors).toBe(1);
    }, 10000);
}

for (const newline of ["\n", "\r\n", "\r"]) {
    test(`MCP SSE ${JSON.stringify(newline)} keeps a long connection alive across bounded events`, async () => {
        const payload = Buffer.from("data: " + "x".repeat(1024 * 1024));
        const separator = Buffer.from(newline + newline);
        let step = 0;
        const events = MCP_MAX_MESSAGE_BYTES / payload.length + 2;
        const stream = new ReadableStream<Uint8Array>({pull(controller) {
            if (step >= Math.ceil(events) * (separator.length + 1)) {controller.close(); return;}
            const part = step++ % (separator.length + 1);
            controller.enqueue(part === 0 ? payload : separator.subarray(part - 1, part));
        }});
        let failed = false;
        const response = boundMcpResponse(new Response(stream, {headers: {"content-type": "text/event-stream"}}), () => {failed = true;});
        expect(await consume(response)).toBeGreaterThan(MCP_MAX_MESSAGE_BYTES);
        expect(failed).toBe(false);
    }, 10000);
}
