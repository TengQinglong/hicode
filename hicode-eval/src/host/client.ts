import { z } from 'zod';
import { batchSchema, runSchema, liveSchema, containerSchema } from './types.js';

const statusSchema = z.object({
  batches: z.array(batchSchema.extend({ state: z.enum(['running', 'finished', 'blocked']), counts: z.record(z.number()), analysis: z.string(), finishedAt: z.number().optional() })),
  runs: z.array(runSchema.extend({ evidencePath: z.string().optional(), displayState: z.string(), live: liveSchema.optional(), container: containerSchema.optional(), preparation: z.object({ phase: z.string(), cached: z.boolean().optional(), image: z.string().optional(), updatedAt: z.number() }).optional() })),
  tasks: z.array(z.object({ id: z.string(), category: z.string(), seconds: z.number() })),
  schedulingBlocked: z.boolean(),
});
export class Client {
  private cookie = '';
  constructor(private readonly port: number) {}
  async request(path: string, body?: unknown): Promise<unknown> {
    const url = `http://127.0.0.1:${this.port}`;
    const connect = async () => {
      const home = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      this.cookie = home.headers.get('set-cookie')?.split(';')[0] ?? '';
      if (!home.ok || !this.cookie) throw Error('Evaluation service did not establish a local session');
      await home.body?.cancel();
    };
    if (!this.cookie) await connect();
    const send = () => fetch(url + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: this.cookie, 'X-Eval-Request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === 'submit' ? 300000 : 30000), redirect: 'error' });
    let response = await send();
    if (response.status === 403) { await response.body?.cancel(); await connect(); response = await send(); }
    const result: unknown = await response.json();
    if (!response.ok) throw Error(z.object({ error: z.string() }).parse(result).error);
    return result;
  }
  async status(batch?: string) {
    const status = statusSchema.parse(await this.request('status'));
    if (!batch) return status;
    const selected = status.batches.find(b => b.id === batch); if (!selected) throw Error('Unknown batch');
    return { ...status, batches: [selected], runs: status.runs.filter(r => r.batchId === batch) };
  }
}
