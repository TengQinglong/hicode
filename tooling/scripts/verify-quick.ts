import {statSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const files = process.argv.slice(2);

if (files.length === 0 || files.some(file =>
    !/^(tests|tooling)\/(?!.*\.\.)[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?$/.test(file)
    || !statSync(resolve(root, file), {throwIfNoEntry: false})?.isFile()
)) {
    console.error("Usage: bun run verify:quick tests/unit/example.test.ts [more test files]");
    process.exit(2);
}

async function run(args: string[]): Promise<void> {
    const child = Bun.spawn([process.execPath, ...args], {cwd: root, stdout: "inherit", stderr: "inherit"});
    const code = await child.exited;
    if (code !== 0) process.exit(code);
}

await run(["test", ...files]);
await run(["run", "check"]);
