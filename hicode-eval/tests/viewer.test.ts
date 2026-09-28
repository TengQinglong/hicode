import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Minimal DOM records observable rendering and requests, without a browser or network.
class Element {
  hidden = false; open = false; textContent = ''; className = ''; dataset = {}; children: Element[] = []; onclick?: () => void;
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
}
test('batch viewer nests tasks beneath a batch, omits analysis and shows a saved terminal without replay', async () => {
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: string[] = []; const writes: string[] = [];
  const status = { concurrency: 2, schedulingBlocked: false, batches: [{ id: 'batch', name: '<img onerror=attack()>', createdAt: 1, model: { model: 'fixture' }, concurrency: 2, budget: { agentSeconds: 900 }, payload: { commit: 'abc12345' }, counts: { total: 1, completed: 1, active: 0, queued: 0, passed: 1, failed: 0, errors: 0, cancelled: 0 }, state: 'finished', report: { text: '<script>bad()</script>' } }], runs: [{ batchId: 'batch', id: 'one', task: 'fixture', state: 'passed', displayState: 'passed', evidencePath: '/tmp/fixture', execution: 'completed', grading: 'passed', collection: 'complete' }] };
  status.runs.push({ ...status.runs[0], id: 'two', task: 'queued-task', state: 'queued', displayState: 'queued', execution: 'pending', grading: 'pending', collection: 'pending' });
  class Terminal {
    parser = { registerOscHandler() {} }; buffer = { active: { viewportY: 0, baseY: 0 } };
    open() {} reset() {} scrollToBottom() {} scrollToLine() {}
    write(text: string, cb: () => void) { writes.push(text); cb(); }
  }
  let finish!: () => void; const rendered = new Promise<void>(r => { finish = r; });
  runInNewContext(await readFile(new URL('../web/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: el, createElement: () => new Element() }, Terminal,
    fetch: async (url: string) => { requests.push(url); return { ok: true, status: 200, json: async () => url === '/api/status' ? status : url.includes('preparation') ? { text: 'cache hit' } : url.includes('run=two') ? { screen: '', revision: 'empty' } : { screen: 'final screen', revision: 'one' } }; },
    setTimeout: () => { finish(); }, clearTimeout: () => {},
  });
  await rendered;
  expect(el('batch-title').textContent).toBe('<img onerror=attack()>');
  expect(elements.has('report')).toBe(false);
  expect(el('batches').children[0].children[1].className).toBe('task-tree');
  expect(el('terminal-shell').hidden).toBe(false);
  expect(el('terminal-status').textContent).toContain('任务已结束 · 判题通过');
  expect(el('summary').children).toHaveLength(7);
  expect(el('preparation').textContent).toBe('cache hit');
  expect(writes).toEqual(['final screen']);
  const switched = new Promise<void>(resolve => { finish = resolve; });
  el('batches').children[0].children[1].children[1].onclick!();
  await switched;
  expect(el('title').textContent).toBe('queued-task');
  expect(el('terminal-shell').hidden).toBe(true);
  expect(el('terminal-empty').textContent).toContain('正在排队');
  expect(el('preparation-panel').open).toBe(false);
  expect(requests.every(r => r.startsWith('/api/status') || r.startsWith('/api/terminal') || r.startsWith('/api/preparation'))).toBe(true);
});
