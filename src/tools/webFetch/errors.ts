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

class WebFetchError extends Error {
    constructor(message: string, readonly stage: "dns" | "request" | "response_body", readonly codes: readonly string[],
        readonly elapsedMs: number, readonly httpStatus: number | null) {
        super(message);
        this.name = "WebFetchError";
    }
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
