import {createHash} from "node:crypto";
import type {PersistedToolResult} from "../../toolResults/index.js";

function sourceKey(value: string): string {
    const url = new URL(value);
    url.hash = "";
    return createHash("sha256").update(url.toString()).digest("hex");
}

interface WebSource {
    result: PersistedToolResult;
    fetchedAt: string;
    expiresAt: number;
}

/** Session-owned references only; bodies remain in the existing result store. */
export class WebSources {
    private readonly entries = new Map<string, WebSource>();

    get(url: string): WebSource | undefined {
        const key = sourceKey(url);
        const entry = this.entries.get(key);
        if (entry && entry.expiresAt > performance.now()) return entry;
        this.entries.delete(key);
        return undefined;
    }

    remember(url: string, result: PersistedToolResult, fetchedAt: string, ttlMs: number): void {
        if (!result.complete) return;
        const key = sourceKey(url);
        this.entries.delete(key);
        if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, {result, fetchedAt, expiresAt: performance.now() + Math.min(300_000, ttlMs)});
    }

    forget(url: string): void {this.entries.delete(sourceKey(url));}
}

/** One Turn owns repeated-failure accounting; a new Turn starts empty. */
export class WebFailures {
    private readonly entries = new Map<string, {count: number; elapsedMs: number}>();

    record(url: string, elapsedMs: number): string {
        const key = sourceKey(url);
        const previous = this.entries.get(key);
        const next = {count: (previous?.count ?? 0) + 1, elapsedMs: (previous?.elapsedMs ?? 0) + elapsedMs};
        if (!previous && this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, next);
        return `This URL has failed ${next.count} time(s) in this turn (${Math.round(next.elapsedMs)} ms total). ` +
            "No automatic retry was made. Retry only with a corrected request or new evidence; switching to Bash does not by itself fix TLS or connectivity.";
    }

    clear(url: string): void {this.entries.delete(sourceKey(url));}
}
