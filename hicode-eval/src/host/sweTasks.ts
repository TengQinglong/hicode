import { z } from 'zod';
import { join } from 'node:path';
import { readdir, realpath, lstat } from 'node:fs/promises';
import { readJson, tree, evidenceTree, contained } from './store.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const sweTaskSchema = z.object({
  kind: z.literal('swe-bench-verified'), instanceId: z.string().regex(/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_.-]+-\d+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/), repo: z.literal('django/django'), version: z.literal('4.2'),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/), harnessVersion: z.literal('4.1.0'),
  environment: z.string().regex(/^\/opt\/hicode-swe\/cache\/[a-f0-9]{64}$/),
  python: z.literal('3.9'), verifierSeconds: z.number().int().min(60).max(7200),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.record(sha), evaluationMode: z.literal('shared-linux-development'),
}).strict();
export type SweTask = z.infer<typeof sweTaskSchema>;
export async function datasetTree(path: string, dataset: string) {
  if(dataset !== 'swe-bench-verified') return tree(path);
  const files = await evidenceTree(path);
  for(const [name,file] of Object.entries(files)) {
    if(file.symlink !== undefined && (!name.startsWith('repository/') || !contained(join(path,'repository'),await realpath(join(path,name))))) throw Error('SWE source link escapes its repository');
    // Git tracks link identity and executable bits, not host symlink permissions.
    // macOS cp creates links under the CLI's private umask; Linux ignores these bits.
    Object.assign(file,{mode:file.symlink !== undefined ? 0o120000 :
      ((await lstat(join(path,name))).mode & 0o111 ? 0o100755 : 0o100644)});
  }
  return files;
}
export async function validateSweTask(id: string, path: string): Promise<SweTask> {
  const task = await readJson(join(path, 'swe-task.json'), sweTaskSchema);
  if (task.instanceId !== id) throw Error('SWE task identity mismatch');
  const actual = await datasetTree(path,'swe-bench-verified');
  delete actual['swe-task.json'];
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(task.files).sort()) ||
    Object.entries(actual).some(([name, file]) => task.files[name] !== file.sha256)) throw Error('SWE task differs from its prepared snapshot');
  // Frozen bundle separates inputs from host-only grading material; no gold patch is stored.
  if (!task.files['instruction.md'] || !task.files['hidden/evaluation.json'] || !Object.keys(task.files).some(p => p.startsWith('repository/'))) throw Error('Incomplete SWE bundle');
  return task;
}
export async function sweCatalog(root?: string) {
  if (!root) return [];
  const result = [];
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const task = await readJson(join(root, entry.name, 'swe-task.json'), sweTaskSchema);
    if (task.instanceId !== entry.name) throw Error('SWE directory identity mismatch');
    result.push({id:task.instanceId,category:'SWE-bench Verified',seconds:1800,dataset:'swe-bench-verified' as const});
  }
  return result;
}
