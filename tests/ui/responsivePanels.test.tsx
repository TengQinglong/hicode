import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import stringWidth from "string-width";
import {PermissionsDialog} from "../../src/ui/dialogs/PermissionsDialog.js";
import {PanelSelect} from "../../src/ui/dialogs/PanelSelect.js";
import {ModelDialog} from "../../src/ui/model/ModelDialog.js";
import {SkillsDialog} from "../../src/ui/skills/SkillsDialog.js";
import {ResumePicker} from "../../src/ui/resume/ResumePicker.js";
import {TerminalSizeProvider} from "../../src/ui/terminalSize.js";
import {wrapPanelText} from "../../src/ui/panelLayout.js";
import type {ModelTargetSettings} from "../../src/settings/types.js";
import type {SessionIndexEntry} from "../../src/session/types.js";

afterEach(cleanup);
const tick = () => new Promise(resolve => setTimeout(resolve, 110));
const down = "\x1b[B";
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
async function resize(view: ReturnType<typeof render>, width: number, height = 40) {
    Object.defineProperties(view.stdout, {
        columns: {configurable: true, value: width},
        rows: {configurable: true, value: height},
    });
    view.stdout.emit("resize"); await tick();
    const frame = view.lastFrame() ?? "";
    expect(frame.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
    return frame;
}

test("permission descriptions expand on wide terminals and keep the selected approval mode", async () => {
    const saved: string[] = [];
    const view = render(<TerminalSizeProvider><PermissionsDialog current="ask" allowFullAccess
        onSelect={mode => saved.push(mode)} onClose={() => {}}/></TerminalSizeProvider>);
    await tick(); view.stdin.write(down); await tick();
    let narrowRows = 0;
    for (const width of [40, 80, 160, 40]) {
        const frame = await resize(view, width);
        expect(frame).toContain("› Agent review");
        expect(normalize(frame)).toContain("An independent Agent reviews requests for extra access, using the same access boundaries as Ask me.");
        if (width === 40) narrowRows = frame.split("\n").length;
        if (width === 160) {
            expect(Math.max(...frame.split("\n").map(line => stringWidth(line.trimEnd())))).toBeGreaterThan(110);
            expect(frame.split("\n").length).toBeLessThan(narrowRows);
        }
        expect(saved).toEqual([]);
    }
    const small = await resize(view, 24, 24);
    expect(small).toContain("› Agent review");
    expect(small.split("\n").length).toBeLessThanOrEqual(24);
    expect(normalize(small)).toContain("enter switch");
    view.stdin.write("\r"); await tick(); expect(saved).toEqual(["auto-review"]);
});

test("long model names reflow without truncation and resize never saves a reasoning draft", async () => {
    const label = "Long model display name for a regional deployment with an explicitly named account and routing policy END_MARKER";
    const models: ModelTargetSettings[] = [
        {source: "qwen", model: "qwen3.8-flash", label: "First"},
        {source: "qwen-token-plan", model: "deepseek-v4.1-flash", label, reasoning: "max"},
    ];
    const saved: ModelTargetSettings[] = [];
    const view = render(<ModelDialog models={models} current={models[0]!} onSelect={async model => {saved.push(model);}} onClose={() => {}}/>);
    await tick(); view.stdin.write(down); await tick();
    for (const width of [40, 80, 160, 40]) {
        const frame = await resize(view, width);
        expect(normalize(frame)).toContain(label);
        if (width === 160) expect(frame.split("\n").some(line => line.includes(label))).toBe(true);
    }
    view.stdin.write("\r"); await tick();
    expect(normalize(view.lastFrame()!.replaceAll("│", ""))).toContain(label);
    expect(view.lastFrame()).toContain("› ● max");
    view.stdin.write("\x1b[A"); await tick();
    for (const width of [160, 40]) {
        const frame = await resize(view, width);
        expect(frame).toContain("›   high"); expect(saved).toEqual([]);
    }
    view.stdin.write("\r"); await tick();
    expect(saved[0]).toMatchObject({source: "qwen-token-plan", model: "deepseek-v4.1-flash", reasoning: "high"});
});

test("skills use added width, retain full descriptions and page unusually tall entries", async () => {
    const description = "Review the complete implementation across multiple packages and explain the observable outcome END_MARKER";
    const view = render(<SkillsDialog skills={[{name: "review", source: "host", id: "review", description, content: "private"}]}
        projectDirectory="/project" userDirectory="/user" onClose={() => {}}/>);
    for (const width of [40, 80, 160, 40]) {
        const frame = await resize(view, width, 24);
        expect(normalize(frame)).toContain(description);
        expect(frame.split("\n").length).toBeLessThanOrEqual(24);
        if (width === 160) expect(frame.split("\n").some(line => line.includes(description))).toBe(true);
    }
    view.rerender(<SkillsDialog skills={[{name: "review", source: "host", id: "review",
        description: "Read all of this. ".repeat(100) + "FINAL_DESCRIPTION", content: "private"}]}
        projectDirectory="/project" userDirectory="/user" onClose={() => {}}/>);
    await tick();
    expect(view.lastFrame()).toContain("PgUp/PgDn");
    for (let i = 0; i < 12; i++) {view.stdin.write("\x1b[6~"); await tick();}
    expect(view.lastFrame()).toContain("FINAL_DESCRIPTION");
    expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(24);
});

test("selection stays on the same item across row-window changes and all text is reachable", async () => {
    const items = Array.from({length: 20}, (_, i) => ({value: String(i), label: `Item ${i} 中文👨‍👩‍👧‍👦`,
        description: i === 19 ? "A long description with meaningful words. ".repeat(20) + "FINAL_DETAIL" : "Description"}));
    const chosen: string[] = [];
    const tree = (width: number, rows: number) => <PanelSelect items={items} width={width} rows={rows} onSelect={item => chosen.push(item.value)}/>;
    const view = render(tree(40, 12));
    await tick();
    for (let i = 0; i < 19; i++) {view.stdin.write(down); await new Promise(resolve => setTimeout(resolve, 15));}
    expect(view.lastFrame()).toContain("Item 19");
    for (const width of [160, 32, 80]) {
        view.rerender(tree(width, 12)); await tick();
        expect(view.lastFrame()).toContain("Item 19");
        expect(view.lastFrame()!.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
        expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(12);
    }
    view.stdin.write("\x1b[6~"); await tick();
    expect(view.lastFrame()).toContain("FINAL_DETAIL");
    view.stdin.write("\r"); await tick(); expect(chosen).toEqual(["19"]);
});

test("resume changes between columns and stacked rows without changing session identity", async () => {
    const summary = "Review 中文 👨‍👩‍👧‍👦 " + "a long repository path and implementation ".repeat(2) + "END_MARKER";
    const sessions: SessionIndexEntry[] = Array.from({length: 12}, (_, i) => ({sessionId: `session-${i}`, cwd: "/project",
        model: "test", createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T01:00:00Z", messageCount: 12,
        summary: i === 1 ? summary : `Session ${i}`}));
    const chosen: string[] = [];
    const view = render(<ResumePicker sessions={sessions} onSelect={id => chosen.push(id)} onCancel={() => {}}/>);
    await tick(); view.stdin.write(down); await tick();
    for (const width of [40, 160, 40]) {
        const frame = await resize(view, width, 40);
        expect(normalize(frame)).toContain(summary);
        expect(frame).toContain("END_MARKER");
    }
    view.stdin.write("\r"); await tick(); expect(chosen).toEqual(["session-1"]);
});

test("wrapped text preserves explicit paragraph breaks and Unicode graphemes", () => {
    const source = "测试👨‍👩‍👧‍👦é/very-long-unbroken-path\n\nsecond paragraph";
    const rows = wrapPanelText(source, 12);
    expect(rows).toContain("");
    expect(rows.every(line => stringWidth(line) <= 12)).toBe(true);
    expect(rows.join("").replaceAll(" ", "")).toBe(source.replace(/[\s]/g, ""));
    expect(rows.join("\n")).toContain("👨‍👩‍👧‍👦");
    expect(wrapPanelText(source, 160)).toEqual(source.split("\n"));
});
