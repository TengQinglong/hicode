import {expect, test} from "bun:test";
import {createRootTurnRunnerFactory} from "../../src/runtime/turnRuntime.js";
import type {HookInput} from "../../src/hooks/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {continuityFixture, continuityHost, continuityState} from "../helpers/continuity.js";
import {createFakeLLM} from "../helpers/fakeLLM.js";

test.each([false, true])("failed Turn reports persistence accurately (saveFailure=%s) without hiding the original error", async saveFailure => {
    await withTempProject(async (cwd, storage) => {
        const fake = createFakeLLM([() => {throw new Error("original provider failure");}]);
        const fixture = continuityFixture(cwd, storage, fake.callLLM);
        const outcomes: Array<Extract<HookInput, {hook_event_name: "TurnEnd"}>> = [];
        const run = createRootTurnRunnerFactory(saveFailure ? {saveSession: async () => {throw new Error("save failed");}} : {});
        try {
            await expect(run({resources: fixture.resources, session: fixture.session, host: continuityHost,
                signal: new AbortController().signal, prompt: "test", getSnapshotState: continuityState,
                onEvent() {}, onHookResult() {}, onLifecycleIssue() {},
                onTurnFinalized(outcome) {outcomes.push(outcome); throw new Error("observer failed");},
            })).rejects.toThrow("original provider failure");
            expect(outcomes).toHaveLength(1);
            expect(outcomes[0]).toMatchObject({status: "failed", reason: "error", persistence_status: saveFailure ? "failed" : "saved"});
        } finally {await fixture.resources.close();}
    });
});

test("cancellation still finalizes exactly once after saving", async () => {
    await withTempProject(async (cwd, storage) => {
        const controller = new AbortController();
        const fake = createFakeLLM([() => {controller.abort("user-cancel"); throw new Error("cancelled provider");}]);
        const fixture = continuityFixture(cwd, storage, fake.callLLM);
        const outcomes: Array<Extract<HookInput, {hook_event_name: "TurnEnd"}>> = [];
        try {
            await expect(createRootTurnRunnerFactory()({resources: fixture.resources, session: fixture.session, host: continuityHost,
                signal: controller.signal, prompt: "test", getSnapshotState: continuityState,
                onEvent() {}, onHookResult() {}, onLifecycleIssue() {},
                onTurnFinalized(outcome) {outcomes.push(outcome);},
            })).resolves.toMatchObject({reason: "interrupted"});
            expect(outcomes).toHaveLength(1);
            expect(outcomes[0]).toMatchObject({status: "cancelled", reason: "user-cancel", persistence_status: "saved"});
        } finally {await fixture.resources.close();}
    });
});
