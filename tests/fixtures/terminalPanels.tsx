import assert from "node:assert/strict";
import {PassThrough, Writable} from "node:stream";
import {render} from "ink";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {TerminalScreen} from "../helpers/terminalScreen.js";
import {createTerminalCursorOutput} from "../../src/ui/input/terminalCursor.js";
import {TerminalCursorAnchorProvider} from "../../src/ui/input/terminalCursorContext.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 180));
await withTempProject(async cwd => {
    const chunks: string[] = [];
    let screen = new TerminalScreen(80, 40);
    const target = Object.assign(new Writable({write(chunk, _encoding, done) {
        chunks.push(String(chunk)); screen.write(String(chunk)); done();
    }}), {columns: 80, rows: 40, isTTY: true});
    const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
    const input = Object.assign(new PassThrough(), {
        isTTY: true, setRawMode() {return this;}, ref() {return this;}, unref() {return this;},
    });
    const stdin = new Proxy(process.stdin, {get(object, property) {
        const source = property in input ? input : object;
        const value = Reflect.get(source, property, source);
        return typeof value === "function" ? value.bind(source) : value;
    }});
    const resources = createTestRuntimeResources(cwd);
    let calls = 0;
    const app = render(<TerminalCursorAnchorProvider enabled><AppForTest resources={resources}
        runAgentImpl={async (_text, _history, emit) => {
            calls++;
            await emit({type: "assistant_text", phase: "final", content: "HISTORY_MARKER " + "retained evidence ".repeat(60)});
            return {reply: "done", reason: "completed", iterations: 1};
        }}/></TerminalCursorAnchorProvider>, {stdout, stderr: stdout, stdin, patchConsole: false, exitOnCtrlC: false});
    try {
        await tick(); input.write("seed"); await tick(); input.write("\r"); await tick();
        assert.equal(calls, 1);
        for (const command of ["/permissions", "/model", "/skills"]) {
            input.write(command); await tick(); input.write("\r"); await tick();
            for (const width of [40, 160, 40]) {
                if (target.columns !== width) screen = new TerminalScreen(width, 40);
                target.columns = width; target.emit("resize"); await tick(); await tick();
                const display = screen.allLines.join("\n");
                assert.equal(display.split("HISTORY_MARKER").length - 1, 1, `history duplicated or lost after ${command} resize`);
                assert(!display.includes("hicode-cursor://"));
                assert(screen.lines.some(line => line.includes("Esc") || line.includes("esc")), `actions missing after ${command} resize`);
                const count = chunks.length; await tick();
                assert.equal(chunks.length, count, "idle panel must not redraw");
                assert.equal(calls, 1, "panels must not call the model");
            }
            input.write("\x1b"); await tick();
            assert(!screen.lines.some(line => line.includes("◆ Access & approval") || line.includes("◆ MODEL") || line.includes("◆ Skills")),
                "closed panel left stale content");
            input.write("draft"); await tick();
            assert(screen.lines[screen.cursor.y]?.includes("draft"), "input cursor lost after panel close");
            input.write("\x03"); await tick();
        }
    } finally {
        app.unmount(); app.cleanup(); stdout.disposeCursorOutput(); input.destroy(); await resources.close();
    }
});
process.stdout.write("responsive-panels-ok\n");
