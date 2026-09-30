import { mkdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { save, readJson, run } from './store.js';

export async function lease(data: string, name: string): Promise<() => Promise<void>> {
  const path = join(data, '.' + name + '.lock');
  const owner = { pid: process.pid, host: hostname(), start: await run(['ps', '-p', String(process.pid), '-o', 'lstart=']) };
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const previous = await readJson(join(path, 'owner.json'), z.object({ pid: z.number().int().positive(), host: z.string(), start: z.string() }));
    if (previous.host !== owner.host) throw Error('Lock belongs to another environment');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ESRCH') alive = false; else throw e; }
    if (alive) { const start = await run(['ps', '-p', String(previous.pid), '-o', 'lstart=']); if (start === previous.start) throw Error(name + ' is already running'); }
    // Claim stale lock by atomic rename before removal; concurrent claimers fail.
    const { rename } = await import('node:fs/promises');
    const stale = path + '.stale-' + process.pid;
    await rename(path, stale); await mkdir(path, { mode: 0o700 }); await rm(stale, { recursive: true });
  }
  await save(join(path, 'owner.json'), owner);
  return async () => { const current = await readJson(join(path, 'owner.json'), z.object({ pid: z.number(), start: z.string() })); if (current.pid === owner.pid && current.start === owner.start) await rm(path, { recursive: true }); };
}
