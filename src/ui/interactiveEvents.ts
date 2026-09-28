import {createContext} from "react";
import type {AgentEvent, StopReason} from "../agent/types.js";

/** Opt-in host observation; it cannot submit input or approve tools. */
export type InteractiveEvent =
    | {type: "ready"; sessionId: string}
    | {type: "agent_event"; sessionId: string; event: AgentEvent}
    | {type: "state"; sessionId: string; busy: boolean; waitingForApproval: boolean}
    | {type: "settled"; sessionId: string; reason: StopReason; runningAgents: number; pendingAgentMessages: number; sealed: boolean};

export const InteractiveEvents = createContext<{emit(event: InteractiveEvent): void; singleTask: boolean} | undefined>(undefined);
