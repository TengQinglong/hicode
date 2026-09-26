import {expect, test} from "bun:test";
import {mkdir, writeFile, readdir, rm} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {captureProcessIdentity, processOwnerState} from "../../src/persistence/processIdentity.js";
import {withFileLock} from "../../src/persistence/fileLock.js";
import {acquireProjectActivity, activeProjectProcesses} from "../../src/persistence/projectState.js";
import {getProjectActivityDirectory} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";

const different = (value: string) => (value[0] === "a" ? "b" : "a") + value.slice(1);

test("owner identity distinguishes PID reuse from another boot/namespace", async () => {
    const local = await captureProcessIdentity();
    expect(await processOwnerState(local, local)).toBe("alive");
    expect(await processOwnerState({...local, start: different(local.start)}, local)).toBe("dead");
    expect(await processOwnerState({...local, environment: different(local.environment)}, local)).toBe("unknown");
});

test("a reused PID does not keep an old lease alive; unknown environments stay protected", async () => {
    await withTempProject(async cwd => {
        const local = await captureProcessIdentity();
        const lock = join(cwd, "state.lock"); await mkdir(lock);
        await writeFile(join(lock, `v1-${local.pid}-${local.environment}-${different(local.start)}-${randomUUID()}`), "");
        expect(await withFileLock(lock, async () => "recovered")).toBe("recovered");
        await mkdir(lock);
        const marker = `v1-${local.pid}-${different(local.environment)}-${local.start}-${randomUUID()}`;
        await writeFile(join(lock, marker), "");
        await expect(withFileLock(lock, async () => "unsafe")).rejects.toThrow("Cannot verify");
        expect(await readdir(lock)).toEqual([marker]);
    });
});

test("activity validates process identity and version before permitting maintenance", async () => {
    await withTempProject(async (cwd, storage) => {
        const release = await acquireProjectActivity(storage, cwd);
        expect(await activeProjectProcesses(storage, cwd)).toContain(process.pid);
        await release(); await release();
        const local = await captureProcessIdentity();
        const path = join(getProjectActivityDirectory(storage, cwd), `${local.pid}-${randomUUID()}.json`);
        const record = {version: 2, owner: {...local, start: different(local.start)}, startedAt: new Date().toISOString()};
        await writeFile(path, JSON.stringify(record));
        expect(await activeProjectProcesses(storage, cwd)).toEqual([]);
        await writeFile(path, JSON.stringify({...record, owner: {...local, environment: different(local.environment)}}));
        await expect(activeProjectProcesses(storage, cwd)).rejects.toThrow("Cannot verify");
        await writeFile(path, JSON.stringify({pid: local.pid}));
        await expect(activeProjectProcesses(storage, cwd)).rejects.toThrow();
        await rm(path);
    });
});
