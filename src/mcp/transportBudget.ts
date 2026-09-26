// Enough for a 20 MiB image's base64 and multi-block results; applied before JSON parsing.
export const MCP_MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

export class McpTransportLimitError extends Error {
    constructor() {super("MCP response exceeds the 128 MiB transport limit; reduce the server response size");}
}

/** Limit each SSE event rather than the lifetime of a healthy notification stream. */
export function boundMcpResponse(response: Response, onLimit: (error: McpTransportLimitError) => void): Response {
    if (!response.body) return response;
    const sse = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
    let bytes = 0;
    let lineBytes = 0;
    let afterCR = false;
    let pendingBoundary = false;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            const reject = () => {
                const error = new McpTransportLimitError();
                controller.error(error);
                onLimit(error);
            };
            if (!sse) {
                bytes += chunk.byteLength;
                if (bytes > MCP_MAX_MESSAGE_BYTES) {reject(); return;}
            } else {
                // Count wire bytes across chunks, respecting LF, CRLF and CR.
                // Delay a CR boundary until its optional LF has been counted.
                for (const byte of chunk) {
                    if (afterCR) {
                        afterCR = false;
                        if (byte === 10) {
                            if (++bytes > MCP_MAX_MESSAGE_BYTES) {reject(); return;}
                            if (pendingBoundary) bytes = 0;
                            pendingBoundary = false;
                            continue;
                        }
                        if (pendingBoundary) bytes = 0;
                        pendingBoundary = false;
                    }
                    if (++bytes > MCP_MAX_MESSAGE_BYTES) {reject(); return;}
                    if (byte === 13) {afterCR = true; pendingBoundary = lineBytes === 0; lineBytes = 0;}
                    else if (byte === 10) {if (lineBytes === 0) bytes = 0; lineBytes = 0;}
                    else lineBytes++;
                }
            }
            controller.enqueue(chunk);
        },
    }));
    return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}
