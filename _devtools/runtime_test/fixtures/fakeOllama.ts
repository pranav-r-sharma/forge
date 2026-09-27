// A fake Ollama HTTP server for tests (Node http, no deps). Speaks the subset of the API Forge uses.
import * as http from 'http';

export interface FakeOllama {
  url: string;
  close: () => Promise<void>;
  /** Every request seen, in order: { method, path, body }. */
  requests: { method: string; path: string; body: any }[];
}

export async function startFakeOllama(): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body: any = undefined;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* ignore */ }
      const p = (req.url || '').split('?')[0];
      requests.push({ method: req.method || '', path: p, body });
      const json = (code: number, obj: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && p === '/api/tags') return json(200, { models: [{ name: 'm1', model: 'm1', size: 123, digest: 'd', details: { family: 'qwen', parameter_size: '9B', quantization_level: 'Q4_K_M' } }] });
      if (req.method === 'GET' && p === '/api/ps') return json(200, { models: [{ name: 'm1', model: 'm1', size: 5_000_000_000, size_vram: 5_000_000_000 }] });
      if (req.method === 'POST' && p === '/api/embeddings') return body?.model === 'no-embed' ? json(404, { error: 'model not found' }) : json(200, { embedding: [0.1, 0.2, 0.3] });
      if (req.method === 'POST' && (p === '/api/chat' || p === '/api/generate')) {
        if (body?.model === 'boom') return json(500, { error: 'server exploded' });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const isChat = p === '/api/chat';
        const slow = body?.model === 'slow-model';
        const toks = slow ? Array.from({ length: 60 }, (_, i) => `t${i} `) : ['Hello', ' ', 'world'];
        for (const t of toks) {
          if (slow) await new Promise((r) => setTimeout(r, 60));
          if (res.destroyed) return;
          res.write(JSON.stringify(isChat ? { model: body?.model, message: { role: 'assistant', content: t }, done: false } : { model: body?.model, response: t, done: false }) + '\n');
        }
        const tail = { model: body?.model, done: true, done_reason: 'stop', eval_count: toks.length, prompt_eval_count: 42, eval_duration: 100_000_000, prompt_eval_duration: 200_000_000, total_duration: 400_000_000, load_duration: 5_000_000 };
        res.end(JSON.stringify(isChat ? { ...tail, message: { role: 'assistant', content: '' } } : { ...tail, response: '' }) + '\n');
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
