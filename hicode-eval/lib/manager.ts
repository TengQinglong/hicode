import { mkdir, readdir, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { taskSchema, profiles, validatePublicTask } from './publicTasks.js';
import { LinuxMachine } from './linux.js';
import { readJson, save, exists, tree, contained } from './store.js';
import { runSchema, done, liveSchema, containerSchema, batchSchema, submissionSchema } from './types.js';
import type { Config, Run, Batch, Submission } from './types.js';

export const ROOT = resolve(import.meta.dir, '..');
export function classify(error: string | undefined, rewards: Record<string, number> | null | undefined): Pick<Run, 'state' | 'execution' | 'grading'> {
  const grading = rewards && Object.keys(rewards).length ? (Object.values(rewards).every(x => x === 1) ? 'passed' : 'failed') : 'unavailable';
  return { execution: error ? (error === 'timeout' ? 'timeout' : 'failed') : 'completed', grading, state: error || grading === 'unavailable' ? 'error' : grading === 'passed' ? 'passed' : 'failed' };
}
export class Lab {
  readonly batches = new Map<string, Batch>();
  private submissions: Promise<unknown> = Promise.resolve();
  readonly runs = new Map<string, Run>();
  private machine: LinuxMachine | undefined;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private closed = false;
  private halted = false;
  private readonly attempted = new Set<string>();
  private pumping = false;
  constructor(readonly config: Config, private readonly credential: string) { }
  path(id: string): string { if (!this.runs.has(id)) throw Error('Unknown run'); return join(this.config.data, 'runs', id); }
  async init(): Promise<void> {
    if (contained(resolve(ROOT, '..'), this.config.data)) throw Error('Run data must be outside checkout');
    await mkdir(join(this.config.data, 'runs'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.config.data, 'batches'), { recursive: true, mode: 0o700 });
    for (const name of await readdir(join(this.config.data, 'batches'))) {
      if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
      const batch = await readJson(join(this.config.data, 'batches', name), batchSchema);
      if (name !== batch.id + '.json' || batch.tasks.length !== batch.runIds.length || new Set(batch.runIds).size !== batch.runIds.length) throw Error('Invalid batch identity');
      this.batches.set(batch.id, batch);
    }
    for (const name of await readdir(join(this.config.data, 'runs'))) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const state = await readJson(join(this.config.data, 'runs', name, 'state.json'), runSchema);
      if (state.id !== name) throw Error('Run identity mismatch');
      const batch = this.batches.get(state.batchId);
      if (!batch || batch.runIds.indexOf(name) < 0 || batch.tasks[batch.runIds.indexOf(name)] !== state.task) throw Error('Orphan or mismatched run');
      this.runs.set(name, state);
      if (!done(state.state)) await this.update(name, { state: 'needs_recovery', collection: 'retained', note: 'Service restarted; inspect retained evidence before scheduling more work' });
    }
    for (const batch of this.batches.values()) if (batch.runIds.some(id => !this.runs.has(id))) throw Error('Batch has missing run evidence');
  }
  async prepareMachine(): Promise<void> { this.machine = new LinuxMachine(this.config); await this.machine.prepare(); }
  async catalog(): Promise<{ id: string; category: string; seconds: number }[]> {
    const result = [];
    const supported = await profiles();
    for (const entry of await readdir(this.config.tasks, { withFileTypes: true })) {
      if (!supported[entry.name] || !entry.isDirectory() || entry.isSymbolicLink() || !await exists(join(this.config.tasks, entry.name, 'task.toml'))) continue;
      const text = await Bun.file(join(this.config.tasks, entry.name, 'task.toml')).text();
      if (text.length > 65536) throw Error('Task metadata too large');
      const task = taskSchema.parse(Bun.TOML.parse(text));
      result.push({ id: entry.name, category: task.metadata?.category ?? 'task', seconds: task.agent.timeout_sec });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async update(id: string, changes: Partial<Run>): Promise<void> {
    const write = (this.writes.get(id) ?? Promise.resolve()).then(async () => {
      const previous = this.runs.get(id); if (!previous) throw Error('Unknown run');
      const next = runSchema.parse({ ...previous, ...changes, updatedAt: Date.now() / 1000 });
      await save(join(this.path(id), 'state.json'), next); this.runs.set(id, next);
    });
    this.writes.set(id, write); await write;
  }

  async submit(input: Submission): Promise<Batch> {
    const operation = this.submissions.then(() => this.createBatch(submissionSchema.parse(input)));
    this.submissions = operation.catch(() => {});
    return operation;
  }
  private async createBatch(input: Submission): Promise<Batch> {
    if (this.closed || this.halted) throw Error('Service closing or scheduling blocked');
    if ([...this.runs.values()].some(r => r.state === 'needs_recovery')) throw Error('Recover retained runs before submitting more');
    if (new Set(input.tasks).size !== input.tasks.length) throw Error('Choose distinct tasks');
    if (input.concurrency > this.config.concurrency) throw Error('Batch exceeds service concurrency');
    const catalog = await this.catalog();
    if (input.tasks.some(id => !catalog.some(t => t.id === id))) throw Error('Unknown task');
    const payload = await readJson(join(this.config.payload, 'manifest.json'), z.record(z.unknown()));
    if (this.closed || this.halted) throw Error('Service closing or scheduling blocked');
    const id = randomBytes(8).toString('hex'), now = Date.now() / 1000;
    const budget = input.budget ?? this.config.budget;
    const batch = batchSchema.parse({ ...input, budget, version: 1, id, createdAt: now, runIds: input.tasks.map(() => randomBytes(8).toString('hex')), model: this.config.model, payload });
    const states = input.tasks.map((task, i) => runSchema.parse({ version: 2, id: batch.runIds[i], batchId: id, task, state: 'queued', createdAt: now, updatedAt: now, model: this.config.model.model, budget }));
    // Publish the batch only after all children are durable; no worker sees a partial submission.
    try {
      for (const state of states) {
        const root = join(this.config.data, 'runs', state.id), source = join(this.config.tasks, state.task), target = join(root, 'task', state.task);
        await validatePublicTask(state.task, source);
        const hashes = await tree(source);
        await cp(source, target, { recursive: true, errorOnExist: true, force: false });
        if (JSON.stringify(await tree(target)) !== JSON.stringify(hashes)) throw Error('Task changed during submission');
        await save(join(root, 'task-files.json'), hashes);
        await save(join(root, 'state.json'), state);
      }
      await save(join(this.config.data, 'batches', id + '.json'), batch);
    } catch (error) {
      for (const state of states) await rm(join(this.config.data, 'runs', state.id), { recursive: true, force: true });
      throw error;
    }
    this.batches.set(id, batch);
    for (const state of states) this.runs.set(state.id, state);
    void this.pump(); return batch;
  }
  async cancelBatch(id: string): Promise<void> {
    const operation = this.submissions.then(async () => {
      const batch = this.batches.get(id); if (!batch) throw Error('Unknown batch');
      const next = { ...batch, cancelledAt: Date.now() / 1000 };
      await save(join(this.config.data, 'batches', id + '.json'), next); this.batches.set(id, next);
      await Promise.all(batch.runIds.map(run => this.cancel(run)));
    });
    this.submissions = operation.catch(() => {}); await operation;
  }
  async report(id: string, text: string): Promise<void> {
    const operation = this.submissions.then(async () => {
      const batch = this.batches.get(id); if (!batch) throw Error('Unknown batch');
      if (batch.runIds.some(run => !done(this.runs.get(run)!.state))) throw Error('Wait for every attempt to finish before publishing analysis');
      const next = batchSchema.parse({ ...batch, report: { text, updatedAt: Date.now() / 1000 } });
      await save(join(this.config.data, 'batches', id + '.json'), next); this.batches.set(id, next);
    });
    this.submissions = operation.catch(() => {}); await operation;
  }
  batchView(batch: Batch) {
    const runs = batch.runIds.map(id => this.runs.get(id)!);
    const completed = runs.filter(r => done(r.state)).length;
    const counts = { total: runs.length, completed, queued: runs.filter(r => r.state === 'queued').length, active: runs.filter(r => !done(r.state) && r.state !== 'queued').length, passed: runs.filter(r => r.state === 'passed').length, failed: runs.filter(r => r.state === 'failed').length, errors: runs.filter(r => r.state === 'error' || r.state === 'needs_recovery').length, cancelled: runs.filter(r => r.state === 'cancelled').length };
    const blocked = runs.some(r => r.state === 'needs_recovery') || this.halted;
    return { ...batch, counts, state: blocked ? 'blocked' : completed === runs.length ? 'finished' : 'running', analysis: batch.report ? 'published' : completed === runs.length ? 'pending' : 'waiting', finishedAt: completed === runs.length ? Math.max(...runs.map(r => r.finishedAt ?? r.updatedAt)) : undefined };
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed || this.halted) return; this.pumping = true;
    try {
      if ([...this.runs.values()].some(r => r.state === 'needs_recovery')) return;
      for (const r of this.runs.values()) {
        if (this.jobs.size >= this.config.concurrency) break;
        if (r.state !== 'queued' || this.jobs.has(r.id) || this.attempted.has(r.id)) continue;
        const batch = this.batches.get(r.batchId)!;
        if (batch.cancelledAt || [...this.jobs.keys()].filter(id => this.runs.get(id)?.batchId === r.batchId).length >= batch.concurrency) continue;
        this.attempted.add(r.id);
        const job = this.execute(r.id).catch(() => {
          this.halted = true;
          console.error('Run state could not be persisted; scheduling stopped. Inspect retained evidence.');
        }).finally(() => { this.jobs.delete(r.id); void this.pump(); }); this.jobs.set(r.id, job);
      }
    } finally { this.pumping = false; }
  }
  async cancel(id: string): Promise<void> {
    const r = this.runs.get(id); if (!r) throw Error('Unknown run'); if (done(r.state)) return;
    await save(join(this.path(id), 'cancel'), { at: Date.now() });
    if (r.state === 'queued' && !this.jobs.has(id)) { await this.update(id, { state: 'cancelled', execution: 'cancelled', finishedAt: Date.now() / 1000 }); return; }
    await this.update(id, { state: 'cancelling' });
    await this.machine?.cancel(id);
  }
  private async execute(id: string): Promise<void> {
    const path = this.path(id);
    try {
      if (await exists(join(path, 'cancel'))) { await this.update(id, { state: 'cancelled', execution: 'cancelled', finishedAt: Date.now() / 1000 }); return; }
      await this.update(id, { state: 'preparing', startedAt: Date.now() / 1000 });
      const current = this.runs.get(id)!;
      const frozen = await readJson(join(path, 'task-files.json'), z.record(z.object({ bytes: z.number(), sha256: z.string() })));
      if (JSON.stringify(await tree(join(path, 'task', current.task))) !== JSON.stringify(frozen)) throw Error('Frozen task changed');
      const payload = await readJson(join(this.config.payload, 'manifest.json'), z.record(z.unknown()));
      if (JSON.stringify(payload) !== JSON.stringify(this.batches.get(current.batchId)!.payload)) throw Error('Payload changed after submission');
      await save(join(path, 'manifest.json'), { model: this.config.model, payload, task: current.task, task_files: frozen, machine: this.config.machine, entry: 'tui', budget: current.budget });
      if (!this.machine) throw Error('Initialize the evaluation machine before running tasks');
      const result = await this.machine.execute(current, path, this.credential, async phase => {
        await appendPhase(path, phase);
        const state = phase === 'Running HiCode' ? 'running' : phase.includes('verif') || phase.includes('Verif') ? 'verifying' : 'preparing';
        if (this.runs.get(id)?.state !== 'cancelling') await this.update(id, { state });
      });
      const execution = result.execution;
      const classified = classify(execution === 'completed' ? undefined : execution, result.grading === 'unavailable' ? null : { reward: result.grading === 'passed' ? 1 : 0 });
      await this.update(id, { state: execution === 'cancelled' ? 'cancelled' : classified.state, execution, grading: result.grading, note: result.note, reward: result.grading === 'unavailable' ? undefined : result.grading === 'passed' ? 1 : 0, collection: 'complete', finishedAt: Date.now() / 1000 });
    } catch (error) {
      const retained = await exists(join(path, 'container.json'));
      await this.update(id, { state: retained ? 'needs_recovery' : 'error', execution: 'failed', collection: retained ? 'retained' : 'pending', note: error instanceof Error ? error.message : 'Run failed', finishedAt: Date.now() / 1000 });
    }
  }
  async snapshot(): Promise<unknown> {
    const runs = [];
    for (const r of this.runs.values()) {
      const path = this.path(r.id);
      const live = await exists(join(path, 'live.json')) ? await readJson(join(path, 'live.json'), liveSchema) : undefined;
      const container = await exists(join(path, 'container.json')) ? await readJson(join(path, 'container.json'), containerSchema) : undefined;
      const preparation = await exists(join(path, 'preparation.json')) ? await readJson(join(path, 'preparation.json'), z.object({ phase: z.string(), cached: z.boolean().optional(), image: z.string().optional(), updatedAt: z.number() })) : undefined;
      runs.push({ ...r, preparation, evidencePath: path, displayState: done(r.state) ? r.state : live?.phase ?? r.state, live, container });
    }
    return { batches: [...this.batches.values()].sort((a,b) => b.createdAt - a.createdAt).map(b => this.batchView(b)), runs: runs.sort((a, b) => b.createdAt - a.createdAt), tasks: await this.catalog(), concurrency: this.config.concurrency, budget: this.config.budget, schedulingBlocked: this.halted || [...this.runs.values()].some(r => r.state === 'needs_recovery') };
  }
  async close(): Promise<void> { this.closed = true; await this.submissions; await Promise.all([...this.runs.values()].filter(r => !done(r.state)).map(r => this.cancel(r.id))); await Promise.all(this.jobs.values()); }
}

async function appendPhase(path: string, phase: string): Promise<void> {
  const { appendFile } = await import('node:fs/promises');
  await save(join(path, 'preparation.json'), { phase, updatedAt: Date.now() / 1000 });
  await appendFile(join(path, 'preparation.log'), phase + '\n');
}
