import { test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, Lab } from '../lib/manager.js';
import { save, tree } from '../lib/store.js';
import { runSchema, configSchema, batchSchema } from '../lib/types.js';
import { serve } from '../lib/server.js';

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hicode-eval-')));
  await mkdir(join(dir, 'tasks')); await mkdir(join(dir, 'runs'));
  const config = configSchema.parse({ version: 3, data: dir, tasks: join(dir, 'tasks'), payload: join(dir, 'payload'), context: 'test', machine: 'test-machine', concurrency: 2, budget: {}, model: { source: 'qwen', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', baseUrl: 'http://127.0.0.1:1' } });
  return { dir, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function finished(id = '0123456789abcdef') {
  return runSchema.parse({ version: 2, id, batchId: 'fedcba9876543210', task: 'alpha', state: 'passed', createdAt: 1, updatedAt: 1, model: 'fixture', budget: {}, execution: 'completed', grading: 'passed', collection: 'complete' });
}

async function persist(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof finished>) {
  await save(join(f.dir, 'batches', s.batchId + '.json'), batchSchema.parse({ version: 1, id: s.batchId, name: 'fixture', budget: f.config.budget, tasks: [s.task], runIds: [s.id], concurrency: 1, createdAt: 1, model: f.config.model, payload: {} }));
  await save(join(f.dir, 'runs', s.id, 'state.json'), s);
}

test('timeout and grade remain independent', () => {
  expect(classify('timeout', { reward: 1 })).toEqual({ execution: 'timeout', grading: 'passed', state: 'error' });
  expect(classify(undefined, null)).toEqual({ execution: 'completed', grading: 'unavailable', state: 'error' });
  expect(classify(undefined, {reward: 0}).state).toBe('failed');
});
test('persisted payloads reject symlink parents and snapshot symlinks', async () => {
  const f = await fixture(); try {
    await mkdir(join(f.dir, 'real')); await symlink(join(f.dir, 'real'), join(f.dir, 'link'));
    await expect(save(join(f.dir, 'link/x.json'), {})).rejects.toThrow('Symlink');
    await expect(tree(f.dir)).rejects.toThrow('Symlink');
  } finally { await f.cleanup(); }
});
test('restart retains interrupted task and prevents new submissions', async () => {
  const f = await fixture(); try {
    const s = runSchema.parse({ ...finished(), state: 'running' });
    await persist(f, s);
    const lab = new Lab(f.config, 'fake'); await lab.init();
    expect(lab.runs.get(s.id)?.state).toBe('needs_recovery');
    await expect(lab.submit({ name: 'test', tasks: ['alpha'], concurrency: 1, budget: f.config.budget })).rejects.toThrow('Recover');
  } finally { await f.cleanup(); }
});



test('viewer returns one current snapshot, not offset replay; rejects cross origin', async () => {
  const f = await fixture(); const lab = new Lab(f.config, 'fake'); const s = finished(); await persist(f, s); await lab.init();
  await save(join(f.dir, 'placeholder.json'), {}); await mkdir(join(f.dir, 'runs', s.id, 'live')); await writeFile(join(f.dir, 'runs', s.id, 'live/screen.txt'), 'final screen\n');
  // Bind then use the real local HTTP protocol. Port is test-local, no user server touched.
  const server = serve(lab, 0); const port = server.port;
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`); const cookie = home.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal?run=${s.id}`, { headers: { cookie } }); expect(await response.json()).toMatchObject({ screen: 'final screen\n' });
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie, origin: 'https://example.com' } }); expect(forbidden.status).toBe(403);
  } finally { server.stop(true); await f.cleanup(); }
});





test('catalog exposes only public tasks with an explicit reviewed adapter', async () => {
  const f = await fixture(); try {
    for (const name of ['cancel-async-tasks','unsupported']) {
      await mkdir(join(f.dir,'tasks',name));
      await writeFile(join(f.dir,'tasks',name,'task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=900\n');
    }
    const lab=new Lab(f.config,'fake');
    expect((await lab.catalog()).map(t=>t.id)).toEqual(['cancel-async-tasks']);
  } finally { await f.cleanup(); }
});

test('batch analysis survives restart without changing scores; mismatched ownership fails closed', async () => {
  const f = await fixture(); const state = finished();
  try {
    await persist(f, state);
    const lab = new Lab(f.config, 'fake'); await lab.init();
    await lab.report(state.batchId, '# Analysis\nObserved a framework issue.');
    const restored = new Lab(f.config, 'fake'); await restored.init();
    expect(restored.batches.get(state.batchId)?.report?.text).toContain('framework');
    expect(restored.runs.get(state.id)?.grading).toBe('passed');
    expect(restored.batchView(restored.batches.get(state.batchId)!).counts).toMatchObject({ total: 1, completed: 1, passed: 1 });
    await save(join(f.dir, 'runs', state.id, 'state.json'), { ...state, task: 'other' });
    await expect(new Lab(f.config, 'fake').init()).rejects.toThrow('mismatched');
  } finally { await f.cleanup(); }
});

test('submission validates all tasks and concurrency before publishing a batch', async () => {
  const f = await fixture(); const lab = new Lab(f.config, 'fake');
  try {
    await lab.init();
    await expect(lab.submit({ name: 'invalid', tasks: ['missing'], concurrency: 1, budget: f.config.budget })).rejects.toThrow('Unknown task');
    await expect(lab.submit({ name: 'invalid', tasks: ['a'], concurrency: 3, budget: f.config.budget })).rejects.toThrow('concurrency');
    expect(lab.batches.size).toBe(0); expect(lab.runs.size).toBe(0);
  } finally { await lab.close(); await f.cleanup(); }
});

test('CLI client reads a batch and publishes a bounded report over the authenticated protocol', async () => {
  const { Client } = await import('../lib/client.js');
  const f = await fixture(), s = finished(); await persist(f, s);
  const lab = new Lab(f.config, 'fake'); await lab.init();
  const server = serve(lab, 0); const client = new Client(server.port!);
  try {
    const status = await client.status(s.batchId);
    expect(status.batches[0].state).toBe('finished'); expect(status.runs).toHaveLength(1);
    await client.request('report', { batch: s.batchId, text: 'Verified logs, no task correction.' });
    expect((await client.status(s.batchId)).batches[0].report?.text).toContain('Verified');
    await expect(client.request('report', { batch: s.batchId, text: 'x'.repeat(200001) })).rejects.toThrow();
    await expect(client.status('1111111111111111')).rejects.toThrow('Unknown batch');
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    expect(html).not.toContain('id="submit"'); expect(html).toContain('id="batches"');
  } finally { server.stop(true); await f.cleanup(); }
});

test('queued batch cancellation prevents execution and premature reporting is rejected', async () => {
  const f = await fixture(); const lab = new Lab(f.config, 'fake');
  try {
    await persist(f, finished()); await lab.init();
    const previous = finished(), queued = runSchema.parse({ ...previous, state: 'queued', execution: 'pending', grading: 'pending' });
    lab.runs.set(queued.id, queued);
    await expect(lab.report(queued.batchId, 'too soon')).rejects.toThrow('finish');
    await lab.cancelBatch(queued.batchId);
    expect(lab.runs.get(queued.id)?.state).toBe('cancelled');
    expect(lab.batches.get(queued.batchId)?.cancelledAt).toBeDefined();
    expect(await Bun.file(join(lab.path(queued.id), 'job.json')).exists()).toBe(false);
  } finally { await lab.close(); await f.cleanup(); }
});

test('new batches default to thirty minutes and preserve an explicit budget', async () => {
  const { budgetSchema } = await import('../lib/types.js');
  expect(budgetSchema.parse({}).agentSeconds).toBe(1800);
  expect(budgetSchema.parse({agentSeconds: 2400}).agentSeconds).toBe(2400);
});
