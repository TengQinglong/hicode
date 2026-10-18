import {getPermissionModeDescription, getPermissionModeShortLabel} from "../../permissions/index.js";
import type {SlashCommand} from "../types.js";

export const permissionsCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "permissions",
    description: "Choose who approves extra access",
    async execute(args, context) {
        if (args.trim()) {
            await context.onEvent({
                type: "assistant_text",
                content: "Usage: /permissions",
            });
            return;
        }
        if (context.openPermissions) {
            context.openPermissions();
            return;
        }
        await context.onEvent({
            type: "assistant_text",
            content: [
                `Access & approval: ${getPermissionModeShortLabel(context.ctx.permissionMode)}`,
                getPermissionModeDescription(context.ctx.permissionMode),
            ].join("\n"),
        });
    },
};
