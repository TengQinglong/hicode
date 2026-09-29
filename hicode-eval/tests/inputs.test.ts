import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareTaskInputs, profiles } from '../lib/publicTasks.js';
import { tree } from '../lib/store.js';

const content = Buffer.from([0, 255, 10, 128, 42]);
const hash = createHash('sha256').update(content).digest('hex');
const profile = { hashes: { 'environment/input.bin': hash }, inputs: [{ source: 'environment/input.bin', target: 'input.bin' }], initializer: null, directories: [], packages: [], verifierPrelude: 'none' as const };
async function fixture(run: (root: string, task: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hicode-eval-inputs-'))), task = join(root, 'task');
  try {
    await mkdir(join(task, 'environment'), { recursive: true });
    await writeFile(join(task, 'environment/input.bin'), content);
    await run(root, task);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('only declared public inputs are staged byte-for-byte, including nested destinations', async () => {
  await fixture(async (root, task) => {
    for (const name of ['tests', 'solution']) {
      await mkdir(join(task, name)); await writeFile(join(task, name, 'hidden.txt'), 'must not enter workspace');
    }
    const destination = join(root, 'inputs');
    await prepareTaskInputs(task, destination, { ...profile, inputs: [{ source: 'environment/input.bin', target: 'nested/input.bin' }] });
    expect(Object.keys(await tree(destination))).toEqual(['nested/input.bin']);
    expect(await readFile(join(destination, 'nested/input.bin'))).toEqual(content);
    expect(await readFile(join(task, 'environment/input.bin'))).toEqual(content);
  });
});

test('corrupt input and reused or symlinked staging directories are rejected', async () => {
  await fixture(async (root, task) => {
    await writeFile(join(task, 'environment/input.bin'), 'changed');
    await expect(prepareTaskInputs(task, join(root, 'changed'), profile)).rejects.toThrow('changed');
    await mkdir(join(root, 'existing'));
    await expect(prepareTaskInputs(task, join(root, 'existing'), profile)).rejects.toThrow();
    await symlink(join(root, 'existing'), join(root, 'alias'));
    await expect(prepareTaskInputs(task, join(root, 'alias'), profile)).rejects.toThrow();
    await expect(prepareTaskInputs(task, join(root, 'alias/new'), profile)).rejects.toThrow('Symlinked');
  });
});

test('manifest refuses path escapes, undeclared files, hidden test sources, and duplicate targets', async () => {
  await fixture(async (root, task) => {
    for (const input of [
      { source: '../input.bin', target: 'input.bin' },
      { source: 'environment/../input.bin', target: 'input.bin' },
      { source: 'tests/input.bin', target: 'input.bin' },
      { source: 'environment/unknown.bin', target: 'input.bin' },
      { source: 'environment/input.bin', target: '../escape' },
      { source: 'environment/input.bin', target: '/absolute' },
      { source: 'environment/input.bin', target: '.hicode/settings.json' },
    ]) await expect(prepareTaskInputs(task, join(root, 'bad'), { ...profile, inputs: [input] })).rejects.toThrow();
    await expect(prepareTaskInputs(task, join(root, 'duplicate'), { ...profile, inputs: [...profile.inputs, ...profile.inputs] })).rejects.toThrow('unique');
  });
});

test('catalog includes six reviewed tasks with the exact newly required inputs', async () => {
  const available = await profiles();
  expect(Object.keys(available)).toHaveLength(12);
  expect(available['sqlite-db-truncate']!.inputs.map(file => file.target)).toEqual(['trunc.db']);
  expect(available['code-from-image']!.inputs.map(file => file.target)).toEqual(['code.png']);
  expect(available['constraints-scheduling']!.inputs.map(file => file.target)).toEqual(['alice_calendar.ics', 'bob_calendar.ics', 'carol_calendar.ics']);
  expect(available['gcode-to-text']!.initializer).toEqual({kind:'gzip',file:'text.gcode.gz'});
  expect(available['git-leak-recovery']!.initializer).toEqual({kind:'bash',file:'challenge-setup.sh'});
  expect(available['llm-inference-batching-scheduler']!.directories).toEqual(['task_file/output_data']);
  expect(available['llm-inference-batching-scheduler']!.inputs.map(file => file.target)).toContain('task_file/scripts/cost_model.py');
  expect(available['llm-inference-batching-scheduler']!.inputs.every(file => !file.target.startsWith('environment/'))).toBe(true);
  expect(available['raman-fitting']!.packages).toEqual(['numpy==2.3.3','scipy==1.16.2']);
  expect(available['schemelike-metacircular-eval']!.inputs.some(file => file.target === 'test/y_combinator.scm')).toBe(true);
  expect(available['schemelike-metacircular-eval']!.inputs.some(file => file.target.includes('shadow_test'))).toBe(false);
});
