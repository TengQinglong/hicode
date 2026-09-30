import { mkdir, appendFile, rename, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validatePublicTask, prepareTaskInputs, taskSchema } from './publicTasks.js';
import { run, readJson, save, evidenceTree, exists } from './store.js';
import type { Config, Run } from './types.js';
import { EVAL_ROOT } from '../paths.js';

const packetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('phase'), phase: z.string() }),
  z.object({ type: z.literal('screen'), screen: z.string().max(8 * 1024 * 1024) }),
  z.object({ type: z.literal('events'), data: z.string().max(1024 * 1024) }),
  z.object({ type: z.literal('verification'), text: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('result'), execution: z.enum(['completed', 'failed', 'timeout', 'cancelled']), grading: z.enum(['passed', 'failed', 'unavailable']), uid: z.number().int().positive() }),
]);
export type LinuxResult = Extract<z.infer<typeof packetSchema>, { type: 'result' }> & { note?: string };
/** A sealed runner result remains true even when its host evidence export fails. */
export class EvidenceCollectionError extends Error {
  constructor(readonly result: LinuxResult, detail: string) {super('Final evidence export failed: ' + detail);}
}
export class LinuxMachine {
  private release = '';
  constructor(private readonly config: Config) {}
  private docker(...args: string[]) { return ['docker', '--context', this.config.context, ...args]; }
  async prepare(): Promise<void> {
    const info = JSON.parse(await run(this.docker('inspect', this.config.machine), { timeout: 15000 }));
    const machine = z.array(z.object({ State: z.object({ Running: z.literal(true) }), Config: z.object({ Labels: z.record(z.string()) }) })).length(1).parse(info)[0];
    if (machine.Config.Labels['dev.hicode.role'] !== 'eval') throw Error('Use the dedicated evaluation machine, not the development container');
    await run(this.docker('exec', this.config.machine, 'sh', '-c', 'command -v bun && command -v node && command -v tmux && command -v bwrap && command -v python3'), { timeout: 15000 });
    await run(this.docker('exec', this.config.machine, '/opt/hicode-verifier/bin/python', '-c', "import sys,importlib.metadata as m; assert sys.version_info[:2] == (3,13); assert m.version('pytest') == '8.4.1'; assert m.version('pytest-json-ctrf') == '0.3.5'"));
    const manifest = await readJson(join(this.config.payload, 'manifest.json'), z.object({ files: z.record(z.string()) }));
    const archive = await readFile(join(this.config.payload, 'source.tar.gz'));
    const hash = createHash('sha256').update(archive).digest('hex');
    if (manifest.files['source.tar.gz'] !== hash) throw Error('Source payload changed');
    await run(this.docker('exec', this.config.machine, 'mkdir', '-p', '/opt/hicode-eval', '/opt/hicode/releases', '/eval/runs'));
    for (const name of ['runner.py', 'cleanup.py', 'recovery.py', 'terminal.py', 'verifier.py', 'protocol.py', 'record.py', 'preflight.ts', 'bootstrap.py']) await run(this.docker('cp', join(EVAL_ROOT, 'src/worker', name), this.config.machine + ':/opt/hicode-eval/' + name));
    const target = '/opt/hicode-eval/source-' + hash + '.tar.gz';
    await run(this.docker('cp', join(this.config.payload, 'source.tar.gz'), this.config.machine + ':' + target));
    this.release = await run(this.docker('exec', this.config.machine, 'python3', '/opt/hicode-eval/bootstrap.py', target, hash), { timeout: 660000 });
    if (this.release !== '/opt/hicode/releases/' + hash) throw Error('Invalid prepared release');
  }
  async cancel(id: string): Promise<void> {
    await run(this.docker('exec', this.config.machine, 'sh', '-c', `test ! -d /eval/runs/${id} || touch /eval/runs/${id}/cancel`), { timeout: 10000 });
  }
  private async collect(id: string, path: string): Promise<void> {
    const stage = join(path, 'collecting'); await rm(stage, { recursive: true, force: true }); await mkdir(stage);
    await run(this.docker('cp', this.config.machine + ':/eval/runs/' + id + '/.', stage), { timeout: 60000 });
    const files = await evidenceTree(stage);
    const previous = join(path, 'evidence.previous');
    // A prior interrupted rotation may have left both generations. The new stage
    // has been fully validated before replacing either one.
    if (await exists(previous) && await exists(join(path, 'evidence'))) await rm(previous, {recursive: true});
    if (await exists(join(path, 'evidence'))) await rename(join(path, 'evidence'), previous);
    await rename(stage, join(path, 'evidence')); await rm(previous, { recursive: true, force: true });
    await save(join(path, 'collection.json'), { complete: true, files });
  }
  async recover(state: Run, path: string): Promise<LinuxResult> {
    if (!this.release || state.state !== 'needs_recovery') throw Error('Task is not eligible for recovery');
    const output = await run(this.docker('exec', this.config.machine, 'python3', '/opt/hicode-eval/recovery.py', state.id), {timeout: 30000});
    const result = packetSchema.parse({ ...JSON.parse(output), type: 'result' });
    if (result.type !== 'result') throw Error('Invalid recovery result');
    await this.collect(state.id, path);
    return { ...result, note: 'Recovered from verified durable evidence; no Agent or verifier rerun.' };
  }
  async execute(state: Run, path: string, credential: string, onPhase: (phase: string) => Promise<void>): Promise<LinuxResult> {
    if (!this.release) throw Error('Evaluation machine not initialized');
    const remote = '/eval/runs/' + state.id;
    const task = join(path, 'task', state.task);
    const inputs = join(path, 'inputs');
    const profile = await validatePublicTask(state.task, task);
    await prepareTaskInputs(task, inputs, profile);
    await run(this.docker('exec', this.config.machine, 'mkdir', '-p', remote + '/project'));
    await run(this.docker('cp', inputs + '/.', this.config.machine + ':' + remote + '/project/'));
    if (profile.initializer) await run(this.docker('cp', join(task, 'environment', profile.initializer.file), this.config.machine + ':' + remote + '/project/' + profile.initializer.file));
    await run(this.docker('cp', join(task, 'instruction.md'), this.config.machine + ':' + remote + '/instruction.md'));
    const spec = taskSchema.parse(Bun.TOML.parse(await Bun.file(join(task, 'task.toml')).text()));
    await save(join(path, 'job.json'), { model: this.config.model, release: this.release, agentSeconds: state.budget.agentSeconds, originalAgentSeconds: spec.agent.timeout_sec, verifierSeconds: spec.verifier.timeout_sec, initializer: profile.initializer, packages: profile.packages, verifierPackages: profile.verifierPackages, verifierPrelude: profile.verifierPrelude, verifierRootOverlay: profile.verifierRootOverlay });
    await run(this.docker('cp', join(path, 'job.json'), this.config.machine + ':' + remote + '/job.json'));
    if (await exists(join(path, 'cancel'))) await this.cancel(state.id);
    await mkdir(join(path, 'live'), { recursive: true });
    await save(join(path, 'container.json'), { session: state.id, id: this.config.machine, attach: 'Use hicode-linux eval-shell; each task runs under its own Linux user.' });
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'HOME', 'DOCKER_CONFIG', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
    env[this.config.model.apiKeyEnv] = credential;
    const proc = Bun.spawn(this.docker('exec', '--env', this.config.model.apiKeyEnv, this.config.machine, 'python3', '/opt/hicode-eval/runner.py', state.id), { env, stdout: 'pipe', stderr: 'pipe' });
    let result: LinuxResult | undefined, note = '', verificationSent = false;
    const stderr = new Response(proc.stderr).text();
    const setupAllowance = profile.verifierPackages.length ? 660 : profile.packages.length ? 360 : 240;
    const timer = setTimeout(() => { void this.cancel(state.id).catch(() => {}); }, (state.budget.agentSeconds + spec.verifier.timeout_sec + setupAllowance) * 1000);
    let buffer = '', lastCopy = Date.now();
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value: chunk, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 12 * 1024 * 1024) throw Error('Runner output exceeds limit');
        for (;;) {
          const index = buffer.indexOf('\n'); if (index < 0) break;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
          const packet = packetSchema.parse(JSON.parse(line));
          if (packet.type === 'phase') {
            await onPhase(packet.phase);
            if (packet.phase === 'Awaiting local verification' && !verificationSent) {
              verificationSent = true;
              await run(this.docker('cp', join(task, 'tests'), this.config.machine + ':' + remote + '/tests'));
              await run(this.docker('exec', this.config.machine, 'sh', '-c', `chmod -R a+rX /eval/runs/${state.id}/tests && touch /eval/runs/${state.id}/verify.ready`));
            }
          } else if (packet.type === 'screen') {
            await Bun.write(join(path, 'live/screen.tmp'), packet.screen);
            await rename(join(path, 'live/screen.tmp'), join(path, 'live/screen.txt'));
          }
          else if (packet.type === 'events') await appendFile(join(path, 'live/events.jsonl'), Buffer.from(packet.data, 'base64'));
          else if (packet.type === 'verification') await Bun.write(join(path, 'verification.txt'), packet.text);
          else if (packet.type === 'error') note = packet.message.replaceAll(credential, '[redacted]');
          else result = packet;
        }
        if (Date.now() - lastCopy > 30000) {
          try {await this.collect(state.id, path);}
          catch (error) {
            await Bun.write(join(path, 'collection-error.txt'), String(error).replaceAll(credential, '[redacted]').slice(-2000));
          }
          lastCopy = Date.now();
        }
      }
      const code = await proc.exited;
      if (code || !result || buffer.trim()) throw Error(note || (await stderr).replaceAll(credential, '[redacted]').slice(-1000) || 'Runner ended without confirmed completion');
      try {await this.collect(state.id, path);}
      catch (error) {throw new EvidenceCollectionError(result, String(error).replaceAll(credential, '[redacted]').slice(-2000));}
      if (note) await Bun.write(join(path, 'error.txt'), note);
      return { ...result, ...(note ? { note } : {}) };
    } catch (error) {
      if (!(error instanceof EvidenceCollectionError)) {
        if (!result) await this.cancel(state.id).catch(() => {});
        await this.collect(state.id, path).catch(() => {});
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}
