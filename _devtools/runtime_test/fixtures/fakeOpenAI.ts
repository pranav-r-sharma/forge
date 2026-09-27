// A fake OpenAI-compatible server (mlx_lm.server flavour) for tests. Node http, no deps.
// Behaviour is selected by the LAST user message's content so tests can steer it: FAIL → HTTP 500, SLOW → slow stream, STREAMERR → in-stream error
// object, MALFORMED → a garbage `data:` line mid-stream. Anything else → a normal streamed reply.
import * as http from 'http';

export interface FakeOpenAI {
  url: string;
  close: () => Promise<void>;
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }[];
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const requests: FakeOpenAI['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* ignore */ }
      const p = (req.url || '').split('?')[0];
      requests.push({ method: req.method || '', path: p, headers: req.headers, body });
      const json = (code: number, obj: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && p === '/health') return json(200, { status: 'ok' });
      if (req.method === 'GET' && p === '/v1/models') return json(200, { object: 'list', data: [{ id: 'ornith-ai/Ornith-1.5-9B-MLX-4bit', object: 'model', created: 1 }] });
      if (req.method === 'POST' && p === '/v1/embeddings') return json(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });
      if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/completions')) {
        const isChat = p === '/v1/chat/completions';
        const last = isChat ? String(body?.messages?.[body.messages.length - 1]?.content ?? '') : String(body?.prompt ?? '');
        if (last === 'FAIL') return json(500, { error: 'server exploded' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        // writes a frame in TWO pieces so the client must reassemble across network chunks
        const frame = async (obj: any) => {
          const s = `data: ${JSON.stringify(obj)}\n\n`;
          const mid = Math.floor(s.length / 2);
          res.write(s.slice(0, mid)); await sleep(2); res.write(s.slice(mid));
        };
        const chunk = (delta: any, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', model: body?.model, choices: [{ index: 0, delta, finish_reason: finish }] });
        if (!isChat) {
          for (const t of ['foo', 'bar']) await frame({ id: 'c', object: 'text_completion', choices: [{ index: 0, text: t, finish_reason: null }] });
          await frame({ id: 'c', object: 'text_completion', choices: [{ index: 0, text: '', finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n'); return res.end();
        }
        res.write(': keep-alive\n\n');
        await frame(chunk({ role: 'assistant' }));
        await frame(chunk({ reasoning: 'Let me think. ' }));
        if (last === 'SLOW') {
          for (let i = 0; i < 60; i++) { await sleep(60); if (res.destroyed) return; await frame(chunk({ content: `t${i} ` })); }
        } else {
          await sleep(20); await frame(chunk({ content: 'Hello' }));
          if (last === 'MALFORMED') res.write('data: {this is not json\n\n');
          if (last === 'STREAMERR') { await frame({ error: { message: 'kaboom' } }); return res.end(); }
          await sleep(20); await frame(chunk({ content: ' ' }));
          await sleep(20); await frame(chunk({ content: 'world' }));
        }
        await frame(chunk({}, 'stop'));
        if (body?.stream_options?.include_usage) await frame({ id: 'c1', object: 'chat.completion', choices: [], usage: { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53, prompt_tokens_details: { cached_tokens: 8 } } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
