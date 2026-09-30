import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {InteractiveEvents, type InteractiveEvent} from "../../src/ui/interactiveEvents.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";

afterEach(cleanup);
async function until(check: () => boolean) {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
    expect(check()).toBe(true);
}

test.each(["completed", "error"] as const)("interactive %s emits exactly one persisted terminal observation", async mode => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        const events: InteractiveEvent[] = [];
        const view = render(<InteractiveEvents.Provider value={{singleTask: true, emit(event) {events.push(event);}}}>
            <AppForTest resources={resources} runAgentImpl={async () => {
                if (mode === "error") throw new Error("Provider rejected fixture request");
                return {reason: "completed", reply: "done", iterations: 1};
            }}/>
        </InteractiveEvents.Provider>);
        try {
            await until(() => events.some(event => event.type === "ready"));
            view.stdin.write("probe"); await Bun.sleep(20); view.stdin.write("\r");
            await until(() => events.some(event => event.type === "settled"));
            const settled = events.filter(event => event.type === "settled");
            expect(settled).toHaveLength(1);
            expect(settled[0]).toMatchObject({status: mode === "error" ? "failed" : "completed", reason: mode,
                persistenceStatus: "saved", sealed: true, runningAgents: 0});
            expect(events.findIndex(event => event.type === "settled")).toBeGreaterThan(
                events.findIndex(event => event.type === "agent_event" && event.event.type === "turn_end"));
        } finally {view.unmount(); await resources.close();}
    });
});
