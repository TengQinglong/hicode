import {expect, test} from "bun:test";
import {mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {withTempProject} from "../helpers/tempProject.js";

const writeTemporaryFile = `temp_file=$(mktemp "$TMPDIR/hicode-shell-temp.XXXXXX") || exit
trap 'rm -f "$temp_file"' EXIT
printf '%s\\n' "$TMPDIR"
printf verified > "$temp_file" && cat "$temp_file"`;

for (const value of [undefined, "", "   "]) {
    test(`host shell supplies a usable TMPDIR when inherited value is ${JSON.stringify(value)}`, async () => {
        await withTempProject(async cwd => {
            const inherited = process.env.TMPDIR;
            const environment = createChildProcessEnvironment({PATH: process.env.PATH, TMPDIR: value}, []);
            const runner = createShellRunner(createDisabledSandboxRuntime(), environment);
            const result = await runner.run({command: writeTemporaryFile, cwd,
                signal: AbortSignal.timeout(5_000), sandboxPermissions: "require_escalated"});
            expect(result.termination).toMatchObject({kind: "exit", code: 0});
            expect(result.stdout).toBe(`${tmpdir()}\nverified`);
            expect(result.stderr).toBe("");
            expect(environment.base.TMPDIR).toBe(value);
            expect(process.env.TMPDIR).toBe(inherited);
        });
    });
}

test("host shell preserves configured TMPDIR and explicit command overrides", async () => {
    await withTempProject(async cwd => {
        const inherited = join(cwd, "inherited temp");
        const explicit = join(cwd, "explicit ' temp");
        await Promise.all([mkdir(inherited), mkdir(explicit)]);
        const environment = createChildProcessEnvironment({PATH: process.env.PATH, TMPDIR: inherited}, []);
        const runner = createShellRunner(createDisabledSandboxRuntime(), environment);
        for (const override of [undefined, explicit, ""]) {
            const result = await runner.run({command: writeTemporaryFile, cwd,
                signal: AbortSignal.timeout(5_000), sandboxPermissions: "require_escalated",
                ...(override === undefined ? {} : {env: {TMPDIR: override}})});
            expect(result.termination).toMatchObject({kind: "exit", code: 0});
            expect(result.stdout).toBe(`${override === "" ? tmpdir() : override ?? inherited}\nverified`);
            expect(result.stderr).toBe("");
        }
        expect(environment.base.TMPDIR).toBe(inherited);
    });
});
