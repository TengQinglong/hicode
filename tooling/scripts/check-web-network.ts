import {createHash} from "node:crypto";
import {z} from "zod";
import {displayWebUrl} from "../../src/tools/webFetch/errors.js";
import {fetchPublicWebUrl} from "../../src/tools/webFetch/network.js";

// This is an explicit operator transport check, not an Agent tool or an offline test.
const entries = z.array(z.object({id: z.string().regex(/^[a-z0-9-]{1,40}$/), url: z.string().url().max(2_000), resolved_addresses: z.array(z.string().ip()).min(1).max(16).optional()}).strict()).min(1).max(12);
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--live" || args[1] !== "--urls") {
    process.stderr.write("Usage: bun tooling/scripts/check-web-network.ts --live --urls FILE.json\nExplicit public-network check; no model calls. Input: [{id, url}].\n");
    process.exit(2);
}
const targets = entries.parse(await Bun.file(args[2]!).json());
let cursor = 0;
let failed = false;
await Promise.all(Array.from({length: 2}, async () => {
    while (cursor < targets.length) {
        const target = targets[cursor++]!;
        const started = performance.now();
        try {
            const response = await fetchPublicWebUrl(target.url, AbortSignal.timeout(35_000), target.resolved_addresses);
            if (response.status >= 400) failed = true;
            process.stdout.write(JSON.stringify({id: target.id, url: displayWebUrl(target.url), status: response.status,
                attempts: response.attempts, milliseconds: Math.round(performance.now() - started), bytes: response.body.length,
                contentType: response.contentType, sha256: createHash("sha256").update(response.body).digest("hex"),
                ...(response.redirectUrl ? {redirect: displayWebUrl(response.redirectUrl)} : {})}) + "\n");
        } catch (error) {
            failed = true;
            process.stdout.write(JSON.stringify({id: target.id, url: displayWebUrl(target.url),
                milliseconds: Math.round(performance.now() - started), error: error instanceof Error ? error.message : "Request failed"}) + "\n");
        }
    }
}));
if (failed) process.exitCode = 1;
