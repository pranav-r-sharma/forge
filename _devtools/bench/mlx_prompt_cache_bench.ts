// Task D (2026-09-30): prompt-cache benchmark after bcee0dc — gpt-oss-20b MXFP4-Q8, Forge server args.
// usage: node _devtools/run-ts.js _devtools/bench/mlx_prompt_cache_bench.ts <snapshot-dir> <out.json> [port]
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { MlxServerManager, buildServerArgs } from '../../src/llm/mlxServer';
import { OpenAiCompatClient } from '../../src/llm/openaiCompatClient';
import { readMemorySample } from '../../src/util/hwSampler';
import { buildSystemPrompt } from '../../src/agent/systemPrompt';
import { ChatMessage } from '../../src/ollama/types';

const snapshot = process.argv[2];
const outFile = process.argv[3];
const port = Number(process.argv[4] || 8127);
const repo = path.resolve(__dirname, '..', '..');
const MODEL_SNAPSHOT =
  snapshot ||
  '/Users/pranavsharma/.cache/huggingface/hub/models--mlx-community--gpt-oss-20b-MXFP4-Q8/snapshots/773a7da77e569019bb0fd17a554b263738d669a3';

const lorem = (chars: number, seed: number) => {
  let s = '';
  let i = 0;
  while (s.length < chars) {
    i++;
    s += `def h${seed}_${(i * 7919) % 99991}(req, ctx):\n    return {'id': ${(i * 104729) % 99991}, 'ok': ctx.get('k${i}', ${i % 13}) > ${i % 7}}\n`;
  }
  return s;
};

const serverProcs = () => {
  try {
    return execFileSync('pgrep', ['-f', `mlx_lm.server.*--port ${port}`])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const memBefore = await readMemorySample();
  const freePctBefore = memBefore ? (memBefore.availableGB / memBefore.totalGB) * 100 : 0;
  if (freePctBefore < 50) {
    console.error('ABORT: free memory', freePctBefore.toFixed(1), '% < 50%');
    process.exit(2);
  }

  const prefixCheck = {
    step1: buildSystemPrompt('bench-ws', 'agent', { terse: true, environmentText: 'python3: /usr/bin/python3' }),
    step2: buildSystemPrompt('bench-ws', 'agent', { terse: true, environmentText: 'python3: /usr/bin/python3' }),
    identical: false,
  };
  prefixCheck.identical = prefixCheck.step1 === prefixCheck.step2;

  const logs: string[] = [];
  const mgr = new MlxServerManager({
    log: (l) => logs.push(l),
    availableGB: async () => (await readMemorySample())?.availableGB,
  });
  const promptCacheBytes = 32 * 1024 ** 3;
  const cfg = {
    pythonPath: path.join(repo, '_devtools/mlx-venv/bin/python'),
    model: MODEL_SNAPSHOT,
    port,
    promptCacheBytes,
    startupTimeoutMs: 600_000,
  };
  const serverArgs = buildServerArgs({ port, promptCacheBytes }, MODEL_SNAPSHOT);

  const rows: any[] = [];
  const client = new OpenAiCompatClient({
    getBaseUrl: () => `http://127.0.0.1:${port}`,
    kind: 'mlx',
    getResident: async () => mgr.resident(),
  });

  const runChat = async (label: string, messages: ChatMessage[]) => {
    let m: any;
    const t0 = Date.now();
    await client.chat({
      model: 'x',
      messages,
      thinking: false,
      maxTokens: 32,
      temperature: 0,
      onMetrics: (mm) => (m = mm),
    });
    const prefillMs = m.promptEvalDurationMs ?? 0;
    const evaluated = m.promptTokens ?? 0;
    const prefillTps = prefillMs > 0 && evaluated > 0 ? Math.round((evaluated / prefillMs) * 1000) : undefined;
    const row = {
      label,
      promptTotal: m.promptTotalTokens,
      cached: m.cachedTokens ?? 0,
      evaluated,
      prefillMs,
      prefillTokPerSec: prefillTps,
      decodeTokPerSec: m.tokensPerSecond,
      hitPct: m.promptTotalTokens ? Math.round(100 * (m.cachedTokens ?? 0) / m.promptTotalTokens) : 0,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    return row;
  };

  try {
    if (serverProcs().length) throw new Error('mlx_lm.server already on port ' + port);
    const tStart = Date.now();
    await mgr.ensure(cfg);
    console.log('server ready in', (Date.now() - tStart) / 1000, 's');
    console.log('server argv tail:', serverArgs.slice(-4).join(' '));

    const sys: ChatMessage = { role: 'system', content: buildSystemPrompt('bench-ws', 'agent', { terse: true }) };
    const toolsStub = lorem(7500, 1);

    for (let rep = 1; rep <= 3; rep++) {
      let hist: ChatMessage[] = [
        sys,
        { role: 'user', content: toolsStub + '\n\nTask: inspect the codebase.' },
      ];
      await runChat(`R${rep}-req1 cold+history`, hist);
      const reply1 = 'Understood. I will inspect.';
      hist = [...hist, { role: 'assistant', content: reply1 }, { role: 'user', content: `[Tool "read_file" result]\n${lorem(400, rep * 10 + 1)}` }];
      await runChat(`R${rep}-req2 append tool1`, hist);
      hist = [
        ...hist,
        { role: 'assistant', content: 'Read complete.' },
        { role: 'user', content: `[Tool "list_dir" result]\n${lorem(350, rep * 10 + 2)}` },
      ];
      await runChat(`R${rep}-req3 append tool2`, hist);

      const earlyEdit = hist.map((m, i) => (i === 1 ? { ...m, content: m.content + '\n# edited early line' } : m));
      await runChat(`R${rep}-control early-msg edit (cache miss)`, earlyEdit);
    }
  } catch (e: any) {
    console.error('FAIL', e?.message || e);
    rows.push({ label: 'ERROR', error: String(e?.message || e) });
    process.exitCode = 1;
  } finally {
    try {
      await mgr.stop();
    } catch {
      /* ignore */
    }
    await sleep(2000);
    const procsAfter = serverProcs();
    const memAfter = await readMemorySample();
    const out = {
      hardware: 'Apple M5, 32 GB',
      model: 'gpt-oss-20b MXFP4-Q8',
      snapshot: MODEL_SNAPSHOT,
      commit: 'bcee0dc',
      memBefore,
      freePctBefore,
      memAfter,
      serverArgs,
      prefixCheck,
      logsTail: logs.slice(-5),
      procsAfter,
      rows,
    };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    if (procsAfter.length) {
      console.error('ORPHAN procs:', procsAfter);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
