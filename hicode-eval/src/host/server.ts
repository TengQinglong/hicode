import { join } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Lab } from './manager.js';
import { EVAL_ROOT } from '../paths.js';
import { submissionSchema, idSchema } from './types.js';
import { exists } from './store.js';

export function serve(lab: Lab, port: number): ReturnType<typeof Bun.serve> {
  const token = randomBytes(32).toString('hex');
  const response = (body: BodyInit, status = 200, type = 'application/json', cookie = false) => new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'", ...(cookie ? { 'Set-Cookie': `eval_session=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}) } });
  const json = (body: unknown, status = 200) => response(JSON.stringify(body), status);
  const server = Bun.serve({
hostname: '127.0.0.1', port, maxRequestBodySize: 256 * 1024, async fetch(request) {
      const actualPort = server.port; const allowed = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      const url = new URL(request.url); const origin = request.headers.get('origin');
      if (!allowed.has(request.headers.get('host') ?? '') || (origin && !['http://127.0.0.1:' + actualPort, 'http://localhost:' + actualPort].includes(origin))) return json({ error: 'Local request required' }, 403);
      if (request.method === 'GET' && url.pathname === '/') return response(Bun.file(join(EVAL_ROOT, 'src/web/index.html')), 200, 'text/html; charset=utf-8', true);
      const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)eval_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (!cookie || !timingSafeEqual(Buffer.from(cookie), Buffer.from(token))) return json({ error: 'Local session required' }, 403);
      try {
        if (request.method === 'GET') {
          const assets: Record<string, string> = { '/app.js': 'text/javascript', '/style.css': 'text/css', '/vendor/xterm.js': 'text/javascript', '/vendor/xterm.css': 'text/css' };
          if (assets[url.pathname]) return response(Bun.file(join(EVAL_ROOT, 'src/web', url.pathname)), 200, assets[url.pathname]);
          if (url.pathname === '/api/status') return json(await lab.snapshot());
          if (url.pathname === '/api/preparation') {
            const path = join(lab.path(url.searchParams.get('run') ?? ''), 'preparation.log');
            if (!await exists(path)) return json({ text: '' });
            const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try { const stat = await fd.stat(); if (!stat.isFile()) throw Error('Invalid log'); const length = Math.min(stat.size, 64000), buffer = Buffer.alloc(length); await fd.read(buffer, 0, length, stat.size - length); return json({ text: buffer.toString('utf8'), truncated: stat.size > length }); } finally { await fd.close(); }
          }
          if (url.pathname === '/api/terminal') {
            const path = join(lab.path(url.searchParams.get('run') ?? ''), 'live/screen.txt');
            if (!await exists(path)) return json({ screen: '', revision: 'empty' });
            const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try { const stat = await fd.stat(); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error('Invalid terminal snapshot'); const revision = `${stat.mtimeMs}:${stat.size}`; if (url.searchParams.get('revision') === revision) return json({ revision }); return json({ revision, screen: await fd.readFile('utf8') }); } finally { await fd.close(); }
          }
        }
        if (request.method === 'POST') {
          if (request.headers.get('X-Eval-Request') !== '1') return json({ error: 'Local request required' }, 403);
          const body: unknown = await request.json();
          if (url.pathname === '/api/submit') { const args = submissionSchema.parse(body); return json({ batch: await lab.submit(args) }); }
          if (url.pathname === '/api/cancel-batch') { const args = z.object({ batch: idSchema }).strict().parse(body); await lab.cancelBatch(args.batch); return json({ ok: true }); }
          if (url.pathname === '/api/resume-batch') { const args = z.object({ batch: idSchema }).strict().parse(body); await lab.resume(args.batch); return json({ ok: true }); }
          if (url.pathname === '/api/recover-run') { const args = z.object({ run: idSchema }).strict().parse(body); return json({run: await lab.recover(args.run)}); }
          if (url.pathname === '/api/report') { const args = z.object({ batch: idSchema, text: z.string().trim().min(1).max(200000) }).strict().parse(body); await lab.report(args.batch, args.text); return json({ ok: true }); }
          if (url.pathname === '/api/cancel') { const args = z.object({ run: z.string() }).strict().parse(body); await lab.cancel(args.run); return json({ ok: true }); }
        }
        return json({ error: 'Not found' }, 404);
      } catch (error) { return json({ error: error instanceof Error ? error.message.slice(0, 250) : 'Invalid request' }, 400); }
    }
});
  return server;
}
