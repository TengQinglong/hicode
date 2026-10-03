import {contentText} from "../images/content.js";
import type {Message} from "../llm/types.js";

const MAX_EVIDENCE_BYTES = 32 * 1024;

/** Freeze only reviewable evidence; never retain mutable History or provider reasoning. */
export function captureApprovalEvidence(history: readonly Message[]): Message[] {
    const latestUser = history.findLastIndex(message => message.role === "user" && (!message.origin || message.origin === "user"));
    const selected: Array<{index: number; message: Message}> = [];
    let bytes = 0;
    const select = (index: number) => {
        const source = history[index];
        if (!source || source.role === "system" || (source.role === "user" && source.origin === "hook_rejected")) return;
        const content = contentText(source.content);
        const message: Message = source.role === "assistant"
            ? {role: "assistant", content, ...(source.tool_calls ? {tool_calls: source.tool_calls} : {})}
            : source.role === "user" ? {role: "user", origin: source.origin, content}
                : {role: "tool", tool_call_id: source.tool_call_id, content};
        const size = Buffer.byteLength(JSON.stringify(message));
        // Keep the latest request intact so the reviewer can fail closed if it is oversized.
        // Its text is immutable; retaining it does not clone the rest of the conversation.
        if (bytes + size > MAX_EVIDENCE_BYTES && index !== latestUser) return;
        bytes += size;
        selected.push({index, message: message.role === "assistant" && message.tool_calls
            ? {...message, tool_calls: message.tool_calls.map(call => ({...call, function: {...call.function}}))} : message});
    };
    if (latestUser >= 0) select(latestUser);
    for (let index = history.length - 1; index >= 0; index--) {
        if (index !== latestUser) select(index);
    }
    return selected.sort((left, right) => left.index - right.index).map(item => item.message);
}
