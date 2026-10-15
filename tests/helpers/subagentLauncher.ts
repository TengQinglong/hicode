import type {Message} from "../../src/llm/types.js";
import {createSubagentLauncher} from "../../src/subagents/launcher.js";
import type {SubagentRequest, SubagentResult, CreateSubagentThread} from "../../src/subagents/types.js";
import type {SubagentRegistry} from "../../src/subagents/registry.js";
import type {ToolContext} from "../../src/tools/types.js";
import {TaskJoin} from "../../src/tasks/taskJoin.js";
import {createTaskRuntimeForTest} from "./taskRuntime.js";
import {registerTempCleanup} from "./tempProject.js";

type FixtureRunner = ((request: SubagentRequest) => Promise<SubagentResult>) & {
    registry?: SubagentRegistry;
    createThread?: CreateSubagentThread;
};

/** Keep tool fixtures on the production managed-task path; direct thread tests use subagent.ts. */
export function attachSubagentLauncher(
    context: ToolContext,
    runSubagent: FixtureRunner,
    getHistory: () => readonly Message[] = () => []
): void {
    if (!context.tasks) {
        const runtime = createTaskRuntimeForTest(context.cwd, context.shellRunner,
            runSubagent.createThread ?? ((options, request) => ({agentId: options.agentId,
                async close() {}, async run() {return runSubagent(request);}})),
            undefined, runSubagent.registry);
        const tasks = runtime.forSession({sessionId: context.sessionId, toolResultStore: context.toolResultStore});
        registerTempCleanup(async () => {try {await tasks.close();} finally {await runtime.close();}});
        context.tasks = tasks;
        context.taskJoin = new TaskJoin(tasks);
    }
    context.subagentLauncher = createSubagentLauncher({parentContext: context, getHistory});
}
