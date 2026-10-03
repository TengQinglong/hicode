import assert from "node:assert/strict";
import {mock} from "bun:test";
import * as network from "../../src/tools/webFetch/network.js";
import {contentText} from "../../src/images/content.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";

const mode = process.argv[2];
const target = mode === "private" ? "http://127.0.0.1/private" : "https://cdn.example.com/doc?file=page&signature=fixture-secret";
const seen: string[] = [];
mock.module("../../src/tools/webFetch/network.js", () => ({...network, fetchPublicWebUrl: async (url: string) => {
    seen.push(url);
    return {url, status: seen.length === 1 ? 302 : 200, statusText: "Fixture", cacheControl: "", contentType: "text/plain",
        body: Buffer.from("document"), ...(seen.length === 1 ? {redirectUrl: target} : {})};
}}));
const {executeToolResult} = await import("../helpers/executeTool.js");
await withTempProject(async cwd => {
    const ctx = createTestContext(cwd);
    const first = await executeToolResult("web_fetch", JSON.stringify({url: "https://docs.example.com/start"}), ctx, "first");
    if (mode === "private") {assert.equal(first.outcome, "failed"); assert.equal(seen.length, 1); return;}
    assert.equal(first.outcome, "ok");
    const text = contentText(first.modelContent);
    assert.ok(!text.includes("fixture-secret"));
    const reference = text.match(/web-redirect:\/\/[^"\s]+/)?.[0];
    assert.ok(reference);
    if (mode === "deny") ctx.permissionRules.deny.push({toolName: "web_fetch", content: "domain:cdn.example.com", source: "host"});
    const active = mode === "foreign" ? createTestContext(cwd, {sessionId: "other"}) : ctx;
    const result = await executeToolResult("web_fetch", JSON.stringify({url: reference}), active, "next");
    assert.equal(result.outcome, mode === "deny" || mode === "foreign" ? "denied" : "ok");
    assert.deepEqual(seen, mode === "deny" || mode === "foreign" ? ["https://docs.example.com/start"] : ["https://docs.example.com/start", target]);
    assert.ok(!contentText(result.modelContent).includes("fixture-secret"));
});
process.stdout.write("verified\n");
