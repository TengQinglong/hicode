import {afterEach, describe, expect, mock, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {PermissionsDialog} from "../../src/ui/dialogs/PermissionsDialog.js";

afterEach(() => cleanup());

const ENTER = "\r";
const DOWN = "\u001B[B";
const UP = "\u001B[A";

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("PermissionsDialog", () => {
    test("展示实际审批行为，修改前确认可直接切换", async () => {
        const onSelect = mock(() => {});
        const instance = render(
            <PermissionsDialog allowFullAccess={true}
                current="ask"
                onSelect={onSelect}
                onClose={() => {}}
            />
        );
        await flush();

        const frame = instance.lastFrame() ?? "";
        expect(frame).toContain("◆ Access & approval");
        expect(frame).toContain("Ask me");
        expect(frame).toContain("Agent review");
        expect(frame).toContain("Full Access");
        expect(frame).toContain("› Ask me  (current)");
        expect(frame).not.toContain("●");
        const lines = frame.split("\n");
        const title = lines.find(line => line.includes("Ask me"))!;
        const description = lines.find(line => line.includes("You approve requests"))!;
        expect(title.indexOf("Ask")).toBe(description.indexOf("You"));
        const text = frame.replace(/\s+/g, " ");
        expect(text).toContain("You approve requests for extra access.");
        expect(text).toContain("An independent Agent reviews requests for extra access");
        expect(text).toContain("Ordinary commands run outside HiCode's sandbox as your OS account");
        expect(text).toContain("/sandbox controls network access for sandboxed commands.");
        expect(frame).not.toContain("Read Only");
        expect(frame).not.toContain("Bypass");

        instance.stdin.write(DOWN);
        await flush();
        expect(instance.lastFrame()).toContain("› Agent review");
        expect(instance.lastFrame()).toContain("Ask me  (current)");
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).toHaveBeenCalledWith("auto-review");
    });

    test("自动批准普通操作必须二次确认且默认返回", async () => {
        const onSelect = mock(() => {});
        const instance = render(
            <PermissionsDialog allowFullAccess={true}
                current="ask"
                onSelect={onSelect}
                onClose={() => {}}
            />
        );
        await flush();
        instance.stdin.write(DOWN);
        instance.stdin.write(DOWN);
        await flush();
        instance.stdin.write(ENTER);
        await flush();

        expect(instance.lastFrame()).toContain("◆ Enable Full Access?");
        expect(instance.lastFrame()).toContain("Commands will run outside HiCode sandbox isolation");
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).not.toHaveBeenCalled();
        expect(instance.lastFrame()).toContain("◆ Access & approval");

        instance.stdin.write(ENTER);
        await flush();
        instance.stdin.write(UP);
        await flush();
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).toHaveBeenCalledWith("full-access");
    });
});
