import {expect, test} from "bun:test";
import {resolve} from "node:path";

// Isolate module mocks and bound the FIFO regression so a blocked open cannot hang the suite.
test.each(["save", "fifo"])("MCP approval boundary: %s", async mode => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../fixtures/mcp/approvalBoundary.ts"), mode], {
        stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
    try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stdout, stderr}).toEqual({code: 0, stdout: "", stderr: ""});
    } finally {clearTimeout(timer); child.kill();}
}, 9000);
