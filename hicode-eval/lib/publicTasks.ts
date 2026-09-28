import { dirname, join, resolve } from 'node:path';
import { mkdir, copyFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { readJson, tree } from './store.js';
export const taskSchema = z.object({ metadata: z.object({ category: z.string().optional() }).optional(), agent: z.object({ timeout_sec: z.number().positive() }), verifier: z.object({ timeout_sec: z.number().positive() }) });
const inputPath = z.string().max(256).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const profileSchema = z.object({
  hashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  inputs: z.array(z.object({ source: inputPath.refine(path => path.startsWith('environment/')), target: inputPath }).strict()).max(256),
  initializer: z.string().nullable(), verifierPrelude: z.enum(['copy-test-helper','none'])
}).strict().superRefine((profile, ctx) => {
  const targets = new Set<string>();
  for (const input of profile.inputs) {
    if (!profile.hashes[input.source] || targets.has(input.target) || input.target === profile.initializer)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inputs must have reviewed hashes and unique destinations' });
    targets.add(input.target);
  }
});
export async function profiles() {
  return readJson(join(import.meta.dir, '../public-tasks.json'), z.record(profileSchema));
}
export async function validatePublicTask(id: string, path: string) {
  const profile = (await profiles())[id]; if (!profile) throw Error('Public task has not been adapted to the shared Linux machine');
  const files = await tree(path);
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(Object.keys(profile.hashes).sort()) || Object.entries(profile.hashes).some(([name, hash]) => files[name]?.sha256 !== hash)) throw Error('Public task differs from the reviewed dataset revision');
  return profile;
}

/** Only explicitly reviewed public inputs enter the Agent workspace, never the whole task. */
export async function prepareTaskInputs(task: string, destination: string, input: z.infer<typeof profileSchema>): Promise<void> {
  const profile = profileSchema.parse(input);
  if (await realpath(dirname(destination)) !== resolve(dirname(destination))) throw Error('Symlinked input parent');
  await mkdir(destination, { mode: 0o700 });
  for (const input of profile.inputs) {
    const target = join(destination, input.target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(task, input.source), target, constants.COPYFILE_EXCL);
  }
  const files = await tree(destination);
  if (Object.keys(files).length !== profile.inputs.length || profile.inputs.some(input => files[input.target]?.sha256 !== profile.hashes[input.source]))
    throw Error('Task inputs changed during preparation');
}
