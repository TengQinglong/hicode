import type {PermissionMode} from "./types.js";

const PERMISSION_MODE_SET = new Set<PermissionMode>([
    "ask",
    "auto-review",
    "full-access",
]);

const SHORT_LABELS: Record<PermissionMode, string> = {
    ask: "Ask me",
    "auto-review": "Agent review",
    "full-access": "Full Access",
};

const DESCRIPTIONS: Record<PermissionMode, string> = {
    ask: "You approve requests for extra access. Authorized workspace actions run directly; commands use the sandbox unless host execution is approved.",
    "auto-review": "An independent Agent reviews requests for extra access, using the same access boundaries as Ask me. You are asked when your input is needed.",
    "full-access": "Ordinary commands run outside HiCode's sandbox as your OS account, without per-request access approval. OS permissions and explicit deny rules still apply.",
};

export function parsePermissionMode(value: string): PermissionMode | null {
    const candidate = value.trim();
    return isPermissionMode(candidate) ? candidate : null;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === "string" &&
        PERMISSION_MODE_SET.has(value as PermissionMode);
}

export function getPermissionModeShortLabel(mode: PermissionMode): string {
    return SHORT_LABELS[mode];
}

export function getPermissionModeDescription(mode: PermissionMode): string {
    return DESCRIPTIONS[mode];
}
