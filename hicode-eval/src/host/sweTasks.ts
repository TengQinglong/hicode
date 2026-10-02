import { z } from 'zod';
import { join } from 'node:path';
import { readdir, realpath, lstat } from 'node:fs/promises';
import { readJson, tree, evidenceTree, contained } from './store.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const sweTaskSchema = z.object({
  kind: z.literal('swe-bench-verified'), instanceId: z.string().regex(/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_.-]+-\d+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/), repo: z.enum(['django/django', 'sympy/sympy', 'pytest-dev/pytest', 'pydata/xarray', 'sphinx-doc/sphinx']),
  version: z.enum(['0.12', '1.0', '1.1', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10', '1.11', '1.12', '3.1', '3.2', '3.3', '3.4', '3.5', '4.3', '7.1', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2', '5.4', '6.0', '6.2', '7.2', '2022.03', '2022.06', '2022.09']),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/), harnessVersion: z.literal('4.1.0'),
  environment: z.string().regex(/^\/opt\/hicode-swe\/cache\/[a-f0-9]{64}$/),
  python: z.enum(['3.6', '3.8', '3.9', '3.10', '3.11']), verifierSeconds: z.number().int().min(60).max(7200),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.record(sha), evaluationMode: z.literal('shared-linux-development'),
}).strict();
export type SweTask = z.infer<typeof sweTaskSchema>;
function checkPythonVersion(task: SweTask): void {
  const expected = task.repo === 'django/django'
    ? task.version === '3.2' ? '3.6'
      : task.version === '4.0' ? '3.8'
      : task.version === '4.1' || task.version === '4.2' ? '3.9'
      : task.version === '5.0' ? '3.11' : undefined
    : task.repo === 'sympy/sympy'
      ? ['1.0', '1.1', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10', '1.11', '1.12'].includes(task.version) ? '3.9' : undefined
      : task.repo === 'pytest-dev/pytest'
        ? ['5.0', '5.1', '5.2', '5.4', '6.0', '6.2', '7.2'].includes(task.version) ? '3.9' : undefined
        : task.repo === 'sphinx-doc/sphinx'
          ? ['3.1', '3.2', '3.3', '3.4', '3.5', '4.0', '4.1', '4.2', '4.3', '5.0', '5.1', '5.2', '7.1', '7.2'].includes(task.version) ? '3.9' : undefined
        : ['0.12', '2022.03', '2022.06', '2022.09'].includes(task.version) ? '3.10' : undefined;
  if (!expected || task.python !== expected ||
      !task.instanceId.startsWith(task.repo.replace('/', '__') + '-'))
    throw Error('SWE task identity differs from the supported repository environment');
}
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
  checkPythonVersion(task);
  const actual = await datasetTree(path,'swe-bench-verified');
  delete actual['swe-task.json'];
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(task.files).sort()) ||
    Object.entries(actual).some(([name, file]) => task.files[name] !== file.sha256)) throw Error('SWE task differs from its prepared snapshot');
  // Frozen bundle separates inputs from host-only grading material; no gold patch is stored.
  if (!task.files['instruction.md'] || !task.files['hidden/evaluation.json'] || !Object.keys(task.files).some(p => p.startsWith('repository/'))) throw Error('Incomplete SWE bundle');
  if (task.repo === 'pydata/xarray') {
    await readJson(join(path,'repository/.git/hicode-env-preflight.json'), z.object({
      sourceCommit:z.literal(task.baseCommit),environment:z.literal(task.environment),
      passed:z.literal(true),checked:z.number().int().positive(),
    }).strict());
  }
  return task;
}
export async function sweCatalog(root?: string) {
  if (!root) return [];
  const result = [];
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const task = await readJson(join(root, entry.name, 'swe-task.json'), sweTaskSchema);
    if (task.instanceId !== entry.name) throw Error('SWE directory identity mismatch');
    checkPythonVersion(task);
    result.push({id:task.instanceId,category:'SWE-bench Verified',seconds:1800,dataset:'swe-bench-verified' as const});
  }
  return result;
}
