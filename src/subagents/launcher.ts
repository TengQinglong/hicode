import type {Message} from "../llm/types.js";
import type {AgentTaskSnapshot} from "../tasks/index.js";
import type {ToolContext} from "../tools/types.js";
import {buildForkContextSnapshot} from "./fork.js";
import type {SubagentRequest} from "./types.js";

import {resolveSubagentDirectory} from "./workspace.js";

type SubagentLaunchInput = Omit<SubagentRequest, "contextSnapshot"> & {
    context: "fresh" | "inherit";
};

export interface SubagentLauncher {
    launch(input: SubagentLaunchInput): Promise<AgentTaskSnapshot>;
}

export function createSubagentLauncher({
    parentContext,
    getHistory,
}: {
    parentContext: ToolContext;
    getHistory(): readonly Message[];
}): SubagentLauncher {
    return {
        async launch(input) {
            const cwd = await resolveSubagentDirectory(parentContext, input.cwd);
            const {context, ...assignment} = input;
            const request: SubagentRequest = {
                ...assignment, cwd,
                ...(context === "inherit" ? {
                    contextSnapshot: buildForkContextSnapshot(getHistory(), input.parentToolCallId),
                } : {}),
            };

            parentContext.signal.throwIfAborted();
            if (!parentContext.tasks || !("startAgent" in parentContext.tasks)) {
                throw new Error("This entry point does not support managed Agent Tasks");
            }
            const task = await parentContext.tasks.startAgent({request, parentContext});
            parentContext.taskJoin?.register(task);
            return task;
        },
    };
}
