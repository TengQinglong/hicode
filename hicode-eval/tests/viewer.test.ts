import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Minimal DOM records observable rendering and requests, without a browser or network.
class Element {
  hidden = false; open = false; textContent = ''; className = ''; dataset = {}; attributes: Record<string,string> = {}; children: Element[] = []; onclick?: () => void;
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
test.each(['passed','needs_recovery','error'])('batch viewer distinguishes completion, collection and grading failures (%s)', async state => {
  const blocked=state==='needs_recovery';
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: string[] = []; const writes: string[] = [];
  const status = { concurrency: 2, schedulingBlocked: blocked, batches: [{ id: 'batch', name: '<img onerror=attack()>', createdAt: 1, model: { model: 'fixture' }, concurrency: 2, budget: { agentSeconds: 900 }, payload: { commit: 'abc12345' }, counts: { total: 1, completed: 1, active: 0, queued: 0, passed: 1, failed: 0, errors: 0, cancelled: 0 }, state: 'finished', report: { text: '<script>bad()</script>' } }], runs: [{ batchId: 'batch', id: 'one', task: 'fixture', budget: {agentSeconds: 900}, state: 'passed', displayState: 'passed', evidencePath: '/tmp/fixture', execution: 'completed', grading: 'passed', collection: 'complete' }] };
  status.batches.push({ ...status.batches[0]!, id: 'batch-two', name: 'Older batch', createdAt: 0 });
  status.runs.push({ ...status.runs[0], id: 'two', task: 'queued-task', budget: {agentSeconds: 1800}, state: 'queued', displayState: 'queued', execution: 'pending', grading: 'pending', collection: 'pending' });
  status.runs.push({ ...status.runs[0]!, batchId: 'batch-two', id: 'three', task: 'other-task' });
  if (state!=='passed') {status.runs[0]!.state=state;status.runs[0]!.displayState=state;}
  if (state==='error')status.runs[0]!.grading='unavailable';
  const sizes: number[][] = [];
  let resized: (() => void) | undefined;
  let terminalRows = 40;
  Object.assign(el('terminal-shell'), {clientHeight: 340});
  Object.assign(el('terminal'), {querySelector: () => ({getBoundingClientRect: () => ({height: terminalRows * 16})})});
  class Terminal {
    get rows() { return terminalRows; }
    resize(cols: number, rows: number) { sizes.push([cols,rows]); terminalRows=rows; }
    parser = { registerOscHandler() {} }; buffer = { active: { viewportY: 0, baseY: 0 } };
    open() {} reset() {} scrollToBottom() {} scrollToLine() {}
    write(text: string, cb: () => void) { writes.push(text); cb(); }
  }
  let finish!: () => void; const rendered = new Promise<void>(r => { finish = r; });
  runInNewContext(await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: el, createElement: () => new Element() }, Terminal,
    getComputedStyle: () => ({paddingTop:'10px',paddingBottom:'10px'}),
    ResizeObserver: class { constructor(callback: () => void) {resized=callback;} observe() {} disconnect() {} },
    window: {addEventListener() {}},
    fetch: async (url: string) => { requests.push(url); return { ok: true, status: 200, json: async () => url === '/api/status' ? status : url.includes('preparation') ? { text: 'cache hit' } : url.includes('run=two') ? { screen: '', revision: 'empty' } : { screen: 'final screen', revision: 'one' } }; },
    setTimeout: () => { finish(); }, clearTimeout: () => {},
  });
  await rendered;
  expect(el('batch-title').textContent).toBe('<img onerror=attack()>');
  expect(elements.has('report')).toBe(false);
  expect(el('batch-detail').textContent).toContain('各题独立时限');
  expect(el('batches').children[0].children[1].children[0].children[1].textContent).toContain('15 分钟');
  expect(el('batches').children[0].children[1].children[1].children[1].textContent).toContain('30 分钟');
  expect(el('detail').textContent).toContain('15 分钟');
  expect(el('batches').children[0].children[1].className).toBe('task-tree');
  expect(el('batches').children[0].children[0].attributes['aria-expanded']).toBe('true');
  expect(el('batches').children[1].children).toHaveLength(1);
  expect(el('terminal-shell').hidden).toBe(false);
  expect(el('terminal-status').textContent).toContain(blocked ? '收尾异常' : state==='error'?'任务已结束 · 判题无有效判分':'任务已结束 · 判题通过');
  if (blocked) expect(el('error').textContent).toContain('fixture');
  if (state==='error')expect(el('batches').children[0].children[1].children[0].children[1].textContent).toContain('判题异常 · 无有效判分');
  expect(el('summary').children).toHaveLength(7);
  expect(el('preparation').textContent).toBe('cache hit');
  expect(writes).toEqual(['final screen']);
  expect(sizes).toEqual([[140,20]]);
  Object.assign(el('terminal-shell'), {clientHeight:180});resized!();
  expect(sizes.at(-1)).toEqual([140,10]);
  expect(writes).toEqual(['final screen']); // Resizing never replays the recording.
  const switched = new Promise<void>(resolve => { finish = resolve; });
  el('batches').children[0].children[1].children[1].onclick!();
  await switched;
  expect(el('title').textContent).toBe('queued-task');
  expect(el('detail').textContent).toContain('30 分钟');
  expect(el('terminal-shell').hidden).toBe(true);
  expect(el('terminal-empty').textContent).toContain(blocked ? '调度暂停' : '正在排队');
  expect(el('preparation-panel').open).toBe(false);
  const collapsed = new Promise<void>(resolve => { finish = resolve; });
  el('batches').children[0].children[0].onclick!();
  await collapsed;
  expect(el('batches').children[0].children).toHaveLength(1);
  expect(el('batches').children[0].children[0].attributes['aria-expanded']).toBe('false');
  expect(el('batch-title').textContent).toBe('<img onerror=attack()>');
  const opened = new Promise<void>(resolve => { finish = resolve; });
  el('batches').children[1].children[0].onclick!();
  await opened;
  expect(el('batches').children[0].children).toHaveLength(1);
  expect(el('batches').children[1].children[1].className).toBe('task-tree');
  expect(el('batches').children[1].children[0].attributes['aria-expanded']).toBe('true');
  expect(el('batch-title').textContent).toBe('Older batch');
  expect(requests.every(r => r.startsWith('/api/status') || r.startsWith('/api/terminal') || r.startsWith('/api/preparation'))).toBe(true);
});
