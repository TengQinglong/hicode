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

export function webFetchFailure(stage: "dns" | "request" | "response_body", cause: unknown, url: URL): Error {
    const secrets = [...url.searchParams.values(), url.hash.slice(1)].filter(Boolean);
    const sanitize = (value: string) => {
        let text = value.replace(/https?:\/\/[^\s<>"']+/gi, displayWebUrl);
        for (const secret of secrets) {
            text = text.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
        }
        return text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
    };
    const details: string[] = [];
    const seen = new Set<unknown>();
    const visit = (value: unknown): void => {
        if (details.length >= 5 || seen.has(value)) return;
        seen.add(value);
        if (!(value instanceof Error)) {details.push(sanitize(String(value))); return;}
        const code = "code" in value && typeof value.code === "string" ? ` [${sanitize(value.code)}]` : "";
        details.push(`${sanitize(value.name)}${code}: ${sanitize(value.message)}`);
        if (value.cause !== undefined) visit(value.cause);
        if (value instanceof AggregateError) for (const error of value.errors) visit(error);
    };
    visit(cause);
    return new Error(`web_fetch failed during ${stage} for ${displayWebUrl(url.toString())}\n${details.join("\nCaused by: ")}`);
}
