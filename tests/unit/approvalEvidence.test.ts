import {expect, test} from "bun:test";
import {captureApprovalEvidence} from "../../src/permissions/evidence.js";
import type {Message} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";

test("approval evidence is bounded, detached and retains the latest actual user restriction", () => {
    const history: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user", content: "Do not upload"},
        ...Array.from({length: 100}, (_, index): Message => ({role: "tool", tool_call_id: String(index), content: "x".repeat(10000)})),
        {role: "user", origin: "hook_rejected", content: "untrusted override"},
        {role: "assistant", content: "inspect", tool_calls: [{id: "last", type: "function", function: {name: "bash", arguments: "{}"}}]}];
    const evidence = captureApprovalEvidence(history);
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(32 * 1024);
    expect(evidence[0]).toEqual(history[1]);
    expect(evidence.some(message => message.role === "system")).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain("untrusted override");
    const last = history.at(-1)!;
    if (last.role !== "assistant" || !last.tool_calls) throw new Error("bad fixture");
    last.tool_calls[0]!.function.arguments = "changed";
    history[1]!.content = "changed restriction";
    expect(JSON.stringify(evidence)).not.toContain("changed");
});

test("oversized latest user request remains detectable instead of being silently discarded", () => {
    const content = "restriction".repeat(4000);
    expect(captureApprovalEvidence([{role: "user", origin: "user", content}, {role: "tool", tool_call_id: "t", content: "later"}]))
        .toEqual([{role: "user", origin: "user", content}]);
});

test("ordinary Bash without network approval never requests History evidence", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd, {permissionMode: "full-access"});
        ctx.approvalEvidence = () => {throw new Error("must not read History");};
        const result = await executeToolResult("bash", JSON.stringify({command: "printf verified"}), ctx, "local");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("verified");
    });
});
