import type {Message} from "../llm/types.js";

// History stores real user/assistant/tool conversation, not userContext.
// Before each callLLM, insert userContext as a transient user message after system:
// [system, userContext, firstUser, assistant/tool/later user...]
// This keeps real user input separate from system-reminder messages in prompt logs,
// while userContext remains in the stable prefix for provider caching.
export function buildInvokeMessages(
    history: Message[],
    userContextBlocks: string[]
): Message[] {
    // Keep rejected input for recovery/display, without replaying its text or pixels as a task.
    const projected = history.map((message): Message => message.role === "user" && message.origin === "hook_rejected"
        ? {role: "user", origin: "runtime", content: "An earlier request was rejected by UserPromptSubmit. Its contents were not accepted as instructions and are omitted from this model request."}
        : message);
    const system = projected[0];
    if (!system || system.role !== "system") {
        return projected;
    }

    if (history.length <= 1 || userContextBlocks.length === 0) {
        return projected;
    }

    const userContextMessage: Message = {
        role: "user", origin: "runtime" as const,
        content: userContextBlocks.join("\n\n"),
    };

    return [system, userContextMessage, ...projected.slice(1)];
}
