import {AsyncLocalStorage} from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {createHiCodeStorageLayout, type HiCodeStorageLayout} from "../../src/persistence/index.js";

const cleanups = new AsyncLocalStorage<Array<() => Promise<void>>>();

export function registerTempCleanup(cleanup: () => Promise<void>): void {
  const current = cleanups.getStore();
  if (!current) throw new Error("Fixture cleanup requires withTempProject");
  current.push(cleanup);
}

export function createTestStorage(
  cwd: string,
  name = ".hicode-test-storage"
): HiCodeStorageLayout {
  return createHiCodeStorageLayout({hicodeHome: join(cwd, name)});
}

export async function withTempProject<T>(
  run: (cwd: string, storage: HiCodeStorageLayout) => Promise<T>
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "hicode-test-"));
  return cleanups.run([], async () => {
    try {return await run(cwd, createTestStorage(cwd));}
    finally {
      try {for (const cleanup of cleanups.getStore()!.reverse()) await cleanup();}
      finally {await rm(cwd, {recursive: true, force: true});}
    }
  });
}
