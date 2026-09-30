import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInteractiveEventLog } from '../../src/cli/interactiveEventLog.js';

test('the real CLI event exporter acknowledges execution before any model output', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hicode-eval-events-')));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const path = join(root, 'events.jsonl');
    const log = createInteractiveEventLog(path, workspace, () => { throw Error('Event export failed'); });
    try {
      log.emit({ type: 'ready', sessionId: 'fixture' });
      log.emit({ type: 'state', sessionId: 'fixture', busy: true, waitingForApproval: false });
      log.emit({ type: 'agent_event', sessionId: 'fixture', event: { type: 'iteration', current: 1 } });
      log.emit({ type: 'agent_event', sessionId: 'fixture', event: { type: 'model_stream_start' } });
    } finally { log.close(); }
    const proc = Bun.spawnSync(['python3', '-c', `
import json,sys
from protocol import Events
stream=Events(); states=[]
for line in open(sys.argv[1], 'rb'):
    # Replay fragmented transport, not hand-made Python event objects.
    stream.accept(line[:9]);stream.accept(line[9:]);states.append(stream.started)
print(json.dumps(states))
`, path], { env: { ...process.env, PYTHONPATH: resolve(import.meta.dir, '../src/worker') }, stdout: 'pipe', stderr: 'pipe' });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual([false, false, false, true]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
