import { join } from 'node:path';
import { z } from 'zod';
import { readJson, tree } from './store.js';
export const taskSchema = z.object({ metadata: z.object({ category: z.string().optional() }).optional(), agent: z.object({ timeout_sec: z.number().positive() }), verifier: z.object({ timeout_sec: z.number().positive() }) });
export async function profiles() {
  return readJson(join(import.meta.dir, '../public-tasks.json'), z.record(z.object({ hashes: z.record(z.string()), initializer: z.string().nullable(), verifierPrelude: z.enum(['copy-test-helper','none']) }).strict()));
}
export async function validatePublicTask(id: string, path: string) {
  const profile = (await profiles())[id]; if (!profile) throw Error('Public task has not been adapted to the shared Linux machine');
  const files = await tree(path);
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(Object.keys(profile.hashes).sort()) || Object.entries(profile.hashes).some(([name, hash]) => files[name]?.sha256 !== hash)) throw Error('Public task differs from the reviewed dataset revision');
  return profile;
}
