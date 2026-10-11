import {createGunzip, createInflate, createBrotliDecompress} from "node:zlib";
import type {Transform} from "node:stream";
import {isRetryableWebFailure, WebFetchError, webFetchFailure} from "./errors.js";
import {lookup} from "node:dns/promises";
import {request as requestHttp, type ClientRequest, type IncomingMessage, type RequestOptions} from "node:http";
import {request as requestHttps} from "node:https";
import {BlockList, isIP, type LookupFunction, type TcpNetConnectOpts} from "node:net";

const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const WEB_FETCH_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_IDLE_MS = 10_000;
const MAX_REDIRECTS = 5;

const blockedIpv4Addresses = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as const) {
    blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

interface WebFetchResponse {
    url: string;
    status: number;
    statusText: string;
    contentType: string;
    cacheControl: string;
    body: Buffer;
    attempts: number;
    retryAfter?: string;
    redirectUrl?: string;
}

function normalizedHostname(hostname: string): string {
    return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

export function parsePublicWebUrl(value: string): URL {
    if (value.length > 2_000) throw new Error("URL must not exceed 2000 characters");
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Invalid URL format");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs are supported");
    }
    if (url.username || url.password) {
        throw new Error("URL must not contain a username or password");
    }
    const hostname = normalizedHostname(url.hostname);
    if (
        !hostname ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        hostname.endsWith(".home.arpa") ||
        (isIP(hostname) === 0 && !hostname.includes("."))
    ) {
        throw new Error("web_fetch can only access the public internet, not localhost or private hosts");
    }
    if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
        throw new Error("web_fetch blocks private, loopback, link-local and reserved addresses");
    }
    return url;
}

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    // Bun's node:net BlockList compatibility can treat an IPv4 check against
    // a mixed IPv4/IPv6 list as blocked unexpectedly, so keep families apart.
    if (family === 4) return !blockedIpv4Addresses.check(address, "ipv4");
    if (family === 6) return !blockedIpv6Addresses.check(address, "ipv6");
    return false;
}

export function validatePinnedAddresses(url: URL, addresses: readonly string[]): {address: string; family: 4 | 6}[] {
    if (url.protocol !== "https:" || isIP(normalizedHostname(url.hostname)) !== 0) throw new Error("Explicit DNS addresses require an HTTPS domain with certificate verification");
    if (addresses.length === 0 || addresses.length > 16 || addresses.some(address => !isPublicAddress(address))) {
        throw new Error("Explicit DNS addresses must contain 1-16 public IPs; private, loopback and reserved addresses are rejected");
    }
    return [...new Set(addresses)].map(address => ({address, family: isIP(address) === 4 ? 4 : 6}));
}

async function resolvePublicAddresses(hostname: string) {
    const normalized = normalizedHostname(hostname);
    if (isIP(normalized) !== 0) {
        if (!isPublicAddress(normalized)) {
            throw new Error("Target resolves to a private, loopback, link-local or reserved address");
        }
        return [{address: normalized, family: isIP(normalized) as 4 | 6}];
    }
    const addresses = await lookup(normalized, {all: true, order: "verbatim"});
    if (addresses.length === 0) throw new Error(`Cannot resolve domain: ${normalized}`);
    // CDNs, corporate DNS and local proxies may return both public and reserved addresses.
    // Filter inaccessible results and pin to remaining public addresses; deny only if none remain.
    // This avoids rejecting public sites while ensuring requests never connect to private addresses.
    const publicAddresses = addresses.filter(({address}) => isPublicAddress(address));
    if (publicAddresses.length === 0) {
        throw new Error("Target domain resolves to a private, loopback, link-local or reserved address");
    }
    return publicAddresses;
}

function createPinnedLookup(
    addresses: Awaited<ReturnType<typeof resolvePublicAddresses>>
): LookupFunction {
    return (_hostname, options, callback) => {
        const requestedFamily = typeof options.family === "number"
            ? options.family
            : options.family === "IPv4"
                ? 4
                : options.family === "IPv6"
                    ? 6
                    : 0;
        const candidates = requestedFamily === 0
            ? addresses
            : addresses.filter(({family}) => family === requestedFamily);
        if (candidates.length === 0) {
            callback(Object.assign(new Error("No public IP matches the requested address family"), {code: "ENOTFOUND"}), "", 0);
            return;
        }
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0]!.address, candidates[0]!.family);
    };
}

function requestAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("Web request cancelled");
}

// DNS lookup cannot be cancelled, but its late result must never start a request.
async function resolveWithAbort(url: URL, signal: AbortSignal, addresses?: readonly string[]) {
    if (signal.aborted) throw requestAbortError(signal);
    if (addresses) return validatePinnedAddresses(url, addresses);
    return new Promise<Awaited<ReturnType<typeof resolvePublicAddresses>>>((resolve, reject) => {
        const cleanup = () => {clearTimeout(deadline); signal.removeEventListener("abort", abort);};
        const fail = (error: unknown) => {cleanup(); reject(error);};
        const abort = () => fail(requestAbortError(signal));
        const deadline = setTimeout(() => fail(Object.assign(new Error(`DNS resolution did not complete within ${DNS_TIMEOUT_MS} ms`), {code: "ETIMEDOUT"})), DNS_TIMEOUT_MS);
        deadline.unref?.();
        signal.addEventListener("abort", abort, {once: true});
        resolvePublicAddresses(url.hostname).then(value => {cleanup(); resolve(value);}, fail);
    });
}

async function requestOnce(url: URL, signal: AbortSignal, startedAt: number, pinnedAddresses?: readonly string[]): Promise<WebFetchResponse> {
    let addresses: Awaited<ReturnType<typeof resolvePublicAddresses>>;
    try {addresses = await resolveWithAbort(url, signal, pinnedAddresses);}
    catch (error) {
        if (signal.aborted && !(signal.reason instanceof Error && "code" in signal.reason && signal.reason.code === "ETIMEDOUT")) throw requestAbortError(signal);
        throw webFetchFailure("dns", error, url, performance.now() - startedAt);
    }
    if (signal.aborted) throw requestAbortError(signal);
    const request = url.protocol === "https:" ? requestHttps : requestHttp;
    return new Promise((resolve, reject) => {
        let req: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let settled = false;
        let responseEnded = false;
        let decoder: Transform | undefined;
        const chunks: Buffer[] = [];
        let connectDeadline: ReturnType<typeof setTimeout> | undefined;
        let idleDeadline: ReturnType<typeof setTimeout> | undefined;
        let detachSocket: (() => void) | undefined;
        const cleanup = () => {
            clearTimeout(connectDeadline);
            clearTimeout(idleDeadline);
            detachSocket?.();
            signal.removeEventListener("abort", abort);
            chunks.length = 0;
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            // Keep error listeners until disposal: destroy/late transport events can emit again.
            decoder?.destroy();
            response?.destroy();
            req?.destroy();
            reject(signal.aborted && !(signal.reason instanceof Error && "code" in signal.reason && signal.reason.code === "ETIMEDOUT")
                ? requestAbortError(signal) : webFetchFailure(response ? "response_body" : "request", error, url, performance.now() - startedAt, response?.statusCode ?? null));
        };
        const abort = () => fail(requestAbortError(signal));
        const armIdle = () => {
            clearTimeout(idleDeadline);
            idleDeadline = setTimeout(() => fail(Object.assign(new Error(`Response made no progress within ${RESPONSE_IDLE_MS} ms`), {code: "ETIMEDOUT"})), RESPONSE_IDLE_MS);
            idleDeadline.unref?.();
        };
        signal.addEventListener("abort", abort, {once: true});
        try {
            const options: RequestOptions & Pick<TcpNetConnectOpts, "autoSelectFamily" | "autoSelectFamilyAttemptTimeout"> = {
                method: "GET",
                headers: {
                    Accept: "text/markdown, text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
                    "Accept-Encoding": "gzip, deflate, br",
                    "User-Agent": "hicode-agent/0.1 web_fetch",
                },
                lookup: createPinnedLookup(addresses),
                autoSelectFamily: true,
                autoSelectFamilyAttemptTimeout: 250,
                signal,
            };
            req = request(url, options, (incoming) => {
                response = incoming;
                response.on("error", fail);
                response.on("aborted", () => fail(new Error("Web response was interrupted before completion")));
                response.on("close", () => {
                    if (!settled && !responseEnded) fail(new Error("Web response closed before completion"));
                });
                if (settled) { response.destroy(); return; }
                clearTimeout(connectDeadline);
                armIdle();
                const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
                if (!["identity", "gzip", "deflate", "br"].includes(encoding)) {fail(new Error(`Unsupported Content-Encoding: ${encoding.slice(0, 80)}`)); return;}
                try {
                    decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
                } catch (error) {fail(error instanceof Error ? error : new Error(String(error))); return;}
                decoder?.on("error", fail);
                let bytes = 0;
                let decodedBytes = 0;
                const declaredLength = Number(response.headers["content-length"] ?? 0);
                if (Number.isFinite(declaredLength) && declaredLength > WEB_FETCH_MAX_BYTES) {
                    fail(new Error(`Response exceeds the ${WEB_FETCH_MAX_BYTES} byte limit`));
                    return;
                }
                response.on("data", (chunk: Buffer | string) => {
                    if (settled) return;
                    armIdle();
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += buffer.length;
                    if (bytes > WEB_FETCH_MAX_BYTES) {
                        fail(new Error(`Response exceeds the ${WEB_FETCH_MAX_BYTES} byte limit`));
                        return;
                    }
                });
                const bodyStream = decoder ?? response;
                bodyStream.on("data", (chunk: Buffer | string) => {
                    if (settled) return;
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    decodedBytes += buffer.length;
                    if (decodedBytes > WEB_FETCH_MAX_BYTES) {fail(new Error(`Decoded response exceeds the ${WEB_FETCH_MAX_BYTES} byte limit`)); return;}
                    chunks.push(buffer);
                });
                response.on("end", () => {responseEnded = true;});
                bodyStream.on("end", () => {
                    if (settled) return;
                    try {
                        const result: WebFetchResponse = {
                            url: url.toString(),
                            status: incoming.statusCode ?? 0,
                            statusText: incoming.statusMessage ?? "",
                            contentType: String(incoming.headers["content-type"] ?? ""),
                            cacheControl: String(incoming.headers["cache-control"] ?? ""),
                            body: Buffer.concat(chunks),
                            attempts: 1,
                            ...(incoming.headers["retry-after"] ? {retryAfter: String(incoming.headers["retry-after"])} : {}),
                            ...(incoming.headers.location
                                ? {redirectUrl: new URL(incoming.headers.location, url).toString()}
                                : {}),
                        };
                        settled = true;
                        cleanup();
                        resolve(result);
                    } catch (error) {
                        fail(error instanceof Error ? error : new Error(String(error)));
                    }
                });
                if (decoder) response.pipe(decoder);
            });
            req.on("error", fail);
            connectDeadline = setTimeout(() => fail(Object.assign(new Error(`Connection/TLS did not complete within ${CONNECT_TIMEOUT_MS} ms`), {code: "ETIMEDOUT"})), CONNECT_TIMEOUT_MS);
            connectDeadline.unref?.();
            req.on("socket", socket => {
                if (settled) return;
                const connected = () => {if (!settled) {clearTimeout(connectDeadline); armIdle();}};
                if (!socket.connecting && (url.protocol === "http:" || req?.reusedSocket)) connected();
                else {
                    const event = url.protocol === "https:" ? "secureConnect" : "connect";
                    socket.once(event, connected);
                    detachSocket = () => socket.removeListener(event, connected);
                }
            });
            req.on("close", () => {
                if (!response) fail(new Error("Web request closed before a response was received"));
            });
            req.end();
        } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export async function fetchPublicWebUrl(
    value: string,
    signal: AbortSignal,
    pinnedAddresses?: readonly string[]
): Promise<WebFetchResponse> {
    const startedAt = performance.now();
    if (signal.aborted) throw requestAbortError(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(requestAbortError(signal));
    signal.addEventListener("abort", abort, {once: true});
    const deadline = setTimeout(() => {
        controller.abort(Object.assign(new Error(`Request did not complete within ${WEB_FETCH_TIMEOUT_MS} ms`), {code: "ETIMEDOUT"}));
    }, WEB_FETCH_TIMEOUT_MS);
    deadline.unref?.();
    try {
        let current = parsePublicWebUrl(value);
        let attempts = 0;
        let retried = false;
        for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
            let response: WebFetchResponse;
            while (true) {
                attempts++;
                try {response = await requestOnce(current, controller.signal, startedAt, pinnedAddresses);}
                catch (error) {
                    if (!controller.signal.aborted && !retried && isRetryableWebFailure(error)) {retried = true; continue;}
                    if (error instanceof WebFetchError) throw new WebFetchError(`${error.message}\nRetrieval attempts: ${attempts}.`, error.stage, error.codes, error.elapsedMs, error.httpStatus);
                    throw error;
                }
                // One transient GET retry shares the original deadline and redirect budget.
                if (!retried && !response.retryAfter && [502, 503, 504].includes(response.status) && !controller.signal.aborted) {retried = true; continue;}
                break;
            }
            response.attempts = attempts;
            if (response.status < 300 || response.status >= 400 || !response.redirectUrl) {
                return response;
            }
            const next = parsePublicWebUrl(response.redirectUrl);
            if (next.origin !== current.origin) {
                return response;
            }
            current = next;
        }
        throw new Error(`Redirect count exceeds ${MAX_REDIRECTS} attempts`);
    } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
    }
}
