import {displayWebUrl} from "./errors.js";
import {z} from "zod";
import TurndownService from "turndown";
import {matchPattern} from "../../permissions/index.js";
import type {Tool} from "../types.js";
import {fetchPublicWebUrl, parsePublicWebUrl} from "./network.js";
import {buildPersistFailureMessage, createPreview} from "../../toolResults/format.js";

const DEFAULT_MAX_CHARS = 50_000;
const MAX_CHARS = 100_000;

const inputSchema = z.object({
    refresh: z.boolean().default(false).describe("Fetch again instead of reusing this Session\'s complete result from the last five minutes. Domain permission is checked for every call."),
    url: z.string().trim().min(1).describe("Public HTTP(S) URL or a web-redirect reference returned by this tool."),
    max_chars: z
        .number()
        .int()
        .min(1_000)
        .max(MAX_CHARS)
        .default(DEFAULT_MAX_CHARS)
        .describe("Body preview character limit, default 50000, maximum 100000; excess content is saved for line-based reading."),
});

export function htmlToReadableText(html: string): string {
    const converter = new TurndownService({
        headingStyle: "atx",
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
        emDelimiter: "*",
    });
    converter.remove([
        "script",
        "style",
        "noscript",
        "template",
        "canvas",
    ]);
    return converter
        .turndown(
            html.replace(/<(svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
        )
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/^(\s*)-\s+/gm, "$1- ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function isTextContentType(contentType: string): boolean {
    const normalized = contentType.toLowerCase();
    return normalized.startsWith("text/") ||
        normalized.includes("json") ||
        normalized.includes("xml") ||
        normalized.includes("yaml") ||
        normalized.includes("javascript") ||
        normalized === "";
}

function permissionContent(url: string): string {
    const target = url.startsWith("web-redirect:") ? `https://${new URL(url).host}/` : url;
    return `domain:${parsePublicWebUrl(target).hostname.toLowerCase()}`;
}

export const webFetchTool: Tool<typeof inputSchema> = {
    name: "web_fetch",
    description: "Fetch a supplied or reliably known public HTTP(S) page/document/text API using GET and convert HTML to readable text. This is not a search engine or browser. No login state, cookies, localhost/private networks or binary downloads. Interactive pages require an actually provided browser capability; do not invent one. Domain access follows runtime approval; cross-domain redirects require a separate request. Read long saved results with read_file using line-based offset/limit.",
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async checkPermissions({url}, ctx) {
        try {
            const parsed = parsePublicWebUrl(ctx.webSources.resolveUrl(url));
            return {
                behavior: "ask",
                message: `Network access required to read public content from ${parsed.hostname} .`,
            };
        } catch (error) {
            return {
                behavior: "deny",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    },
    async preparePermissionMatcher({url}) {
        let target: string;
        try {
            target = permissionContent(url);
        } catch {
            target = `input:${url}`;
        }
        return (pattern) => matchPattern(pattern, target);
    },
    async execute({url, max_chars, refresh}, ctx, invocation) {
        ctx.signal.throwIfAborted();
        url = ctx.webSources.resolveUrl(url);
        if (refresh) ctx.webSources.forget(url);
        const cached = ctx.webSources.get(url);
        const saved = cached && await ctx.toolResultStore.resolveFile(cached.result.path).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (cached && saved) {
            ctx.signal.throwIfAborted();
            const notice = `Reused the complete response fetched at ${cached.fetchedAt}. No network request was made. Set refresh=true for current content.`;
            return {content: notice,
                persisted: {...saved, preview: createPreview(saved.preview, Math.max(0, Math.min(max_chars, ctx.toolResultStore.previewChars) - notice.length))}, outcome: "ok"};
        }
        ctx.webSources.forget(url);
        const startedAt = performance.now();
        const failureNote = () => ctx.webFailures.record(url, performance.now() - startedAt);
        let response: Awaited<ReturnType<typeof fetchPublicWebUrl>>;
        try {response = await fetchPublicWebUrl(url, ctx.signal);}
        catch (error) {
            ctx.signal.throwIfAborted();
            return {content: `${error instanceof Error ? error.message : "Web request failed"}\n${failureNote()}`, outcome: "failed"};
        }
        if (
            response.status >= 300 && response.status < 400 &&
            response.redirectUrl
        ) {
            const target = parsePublicWebUrl(response.redirectUrl).toString();
            const reference = ctx.webSources.rememberRedirect(target);
            return [
                `Cross-domain redirect was not followed automatically (HTTP ${response.status}).`,
                `Original URL: ${displayWebUrl(response.url)}`,
                `Target URL: ${displayWebUrl(response.redirectUrl)}`,
                `To continue, call web_fetch with url=${JSON.stringify(reference)} to check and authorize the new domain separately. This Session reference preserves the exact target without exposing query values.`,
            ].join("\n");
        }
        const octetStream = response.contentType.split(";", 1)[0]!.trim().toLowerCase() === "application/octet-stream";
        let decoded: string | undefined;
        if (octetStream) {
            try {
                const text = new TextDecoder("utf-8", {fatal: true}).decode(response.body);
                if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) decoded = text;
            } catch { /* Binary or malformed UTF-8 must not be presented as a document. */ }
        }
        if (!isTextContentType(response.contentType) && decoded === undefined) {
            return {
                content: `Unsupported response type: ${response.contentType || "unknown"}(${response.body.length} bytes); HTTP ${response.status}. Only valid text is supported.\n${failureNote()}`,
                outcome: "failed",
            };
        }

        const raw = decoded ?? response.body.toString("utf8");
        const body = response.contentType.toLowerCase().includes("html")
            ? htmlToReadableText(raw)
            : raw.trim();
        const truncated = body.length > max_chars;
        const visibleBody = truncated ? body.slice(0, max_chars) : body;
        const fetchedAt = new Date().toISOString();
        const header = [
            `URL: ${displayWebUrl(response.url)}`,
            `HTTP: ${response.status} ${response.statusText}`.trim(),
            `Content-Type: ${response.contentType || "unknown"}`,
            `Fetched at: ${fetchedAt}`,
        ];
        const httpFailure = response.status >= 400 ? failureNote() : undefined;
        if (!httpFailure) ctx.webFailures.clear(url);
        const content = [
            ...header,
            "",
            visibleBody || "(empty response body)",
            ...(httpFailure ? [httpFailure] : []),
        ].join("\n");
        if (truncated || response.status < 300) {
            try {
                const persisted = await ctx.toolResultStore.persistText({
                    toolCallId: invocation.toolCallId,
                    toolName: "web_fetch",
                    content: [...header, "", body].join("\n"),
                });
                const cacheControl = response.cacheControl ?? "";
                const maxAge = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i)?.[1];
                if (response.status < 300 && !/(?:^|,)\s*(?:no-store|no-cache|private)(?:,|$|\s)/i.test(cacheControl) && maxAge !== "0") {
                    ctx.webSources.remember(url, persisted, fetchedAt, maxAge === undefined ? 300_000 : Number(maxAge) * 1000);
                }
                return {
                    content: httpFailure ?? "",
                    displayContent: content,
                    persisted: {...persisted, preview: createPreview(persisted.preview, Math.max(0, Math.min(max_chars, ctx.toolResultStore.previewChars) - (httpFailure?.length ?? 0)))},
                    outcome: response.status >= 400 ? "failed" : "ok",
                };
            } catch (error) {
                return {
                    content: buildPersistFailureMessage("web_fetch", content.slice(0, Math.min(max_chars, ctx.toolResultStore.previewChars)), error),
                    outcome: response.status >= 400 ? "failed" : "output_failed",
                };
            }
        }
        return response.status >= 400
            ? {content, outcome: "failed"}
            : content;
    },
};
