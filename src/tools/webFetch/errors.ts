export function displayWebUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = url.search ? "?[redacted]" : "";
        url.hash = "";
        return url.toString();
    } catch {return "(invalid URL)";}
}

export class WebFetchError extends Error {
    constructor(message: string, readonly stage: "dns" | "request" | "response_body", readonly codes: readonly string[],
        readonly elapsedMs: number, readonly httpStatus: number | null) {
        super(message);
        this.name = "WebFetchError";
    }
}

export function isRetryableWebFailure(error: unknown): boolean {
    return error instanceof WebFetchError && (error.httpStatus === null || error.httpStatus < 400) &&
        !error.codes.some(code => /CERT|SSL|TLS/.test(code)) && error.codes.some(code =>
        ["EAI_AGAIN", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code));
}

export function webFailureAdvice(error: unknown): string {
    if (!(error instanceof WebFetchError)) return "Check the request and response before trying again.";
    if (error.httpStatus !== null && error.httpStatus >= 400) return httpFailureAdvice(error.httpStatus);
    if (error.codes.some(code => /CERT|SSL|TLS/.test(code))) return "TLS verification failed. Check the network route, DNS and certificate chain; do not disable verification or assume that changing query terms fixes it.";
    if (error.stage === "dns") return error.codes.length ? "DNS resolution failed. Check the resolver/network setup before trying URL variants." : "DNS/address validation did not permit this target. Inspect the stated boundary; do not assume this is a connectivity failure.";
    if (error.codes.includes("ETIMEDOUT")) return "No complete response arrived within the request deadline. Reuse available sources; retry only if connectivity or the request changes.";
    return "Check connectivity and the saved error. Changing search terms does not fix a transport failure.";
}

export function httpFailureAdvice(status: number): string {
    if (status === 401) return "Authentication is required; changing query terms does not supply credentials.";
    if (status === 403) return "The server refused this request. Check access requirements; do not repeatedly change keywords or assume the body is usable source material.";
    if (status === 404) return "Check the documented endpoint or resource path before retrying; this URL did not provide the requested resource.";
    if (status === 429) return "The server rate-limited or challenged this request. Respect Retry-After/access requirements; changing keywords is not evidence that access is restored.";
    return "This HTTP response is not a successful retrieval. Inspect the status and error body before parsing it as source data.";
}

export function webFetchFailure(stage: "dns" | "request" | "response_body", cause: unknown, url: URL,
    elapsedMs = 0, httpStatus: number | null = null): WebFetchError {
    const secrets = [...url.searchParams.values(), url.hash.slice(1)].filter(Boolean);
    const sanitize = (value: string) => {
        let text = value.replace(/https?:\/\/[^\s<>"']+/gi, displayWebUrl);
        for (const secret of secrets) {
            text = text.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
        }
        return text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
    };
    const details: string[] = [];
    const codes: string[] = [];
    const seen = new Set<unknown>();
    const visit = (value: unknown): void => {
        if (details.length >= 5 || seen.has(value)) return;
        seen.add(value);
        if (!(value instanceof Error)) {details.push(sanitize(String(value))); return;}
        const code = "code" in value && typeof value.code === "string" ? ` [${sanitize(value.code)}]` : "";
        if ("code" in value && typeof value.code === "string") codes.push(sanitize(value.code));
        details.push(`${sanitize(value.name)}${code}: ${sanitize(value.message)}`);
        if (value.cause !== undefined) visit(value.cause);
        if (value instanceof AggregateError) for (const error of value.errors) visit(error);
    };
    visit(cause);
    return new WebFetchError(`web_fetch failed during ${stage} for ${displayWebUrl(url.toString())}\n${details.join("\nCaused by: ")}\n` +
        `Elapsed: ${Math.round(elapsedMs)} ms; response headers: ${httpStatus === null ? "not received" : `received (HTTP ${httpStatus})`}.`,
        stage, codes, elapsedMs, httpStatus);
}
