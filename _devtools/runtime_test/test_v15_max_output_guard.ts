// Max output token floor: never call the model with cap 0 (MLX 512 default).
import { promptViewTokenEstimate, updatePromptView, DEFAULT_CHARS_PER_TOKEN } from '../../src/agent/contextManager';
import { OpenAiCompatClient } from '../../src/llm/openaiCompatClient';
import { OllamaClient } from '../../src/ollama/client';
import { MIN_AGENT_OUTPUT_TOKEN_FLOOR, resolveEffectiveMaxOutputTokens } from '../../src/util/config';
import { startFakeOpenAI } from './fixtures/fakeOpenAI';
import { startFakeOllama } from './fixtures/fakeOllama';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}

async function main() {
  ok(MIN_AGENT_OUTPUT_TOKEN_FLOOR === 2048, 'MIN_AGENT_OUTPUT_TOKEN_FLOOR is 2048');

  const view = [{ role: 'user', content: 'x'.repeat(9000) }];
  const fresh = Math.ceil(9000 / DEFAULT_CHARS_PER_TOKEN);
  ok(promptViewTokenEstimate(view, DEFAULT_CHARS_PER_TOKEN, 50_000) === 50_000, 'prompt estimate uses max(fresh, prior est.) when prior is larger');
  ok(promptViewTokenEstimate(view, DEFAULT_CHARS_PER_TOKEN, 100) === fresh, 'prompt estimate uses fresh when larger than prior');

  const noRoom = resolveEffectiveMaxOutputTokens(0, 131072, 0, 130_500);
  ok(noRoom === 0, 'resolve can still return 0 when window is full');
  ok(noRoom < MIN_AGENT_OUTPUT_TOKEN_FLOOR, 'zero cap is below agent floor (loop must not call model)');

  const model = {
    chat: async () => 'summary line',
  };
  const archival = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first ask' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `block ${i} `.repeat(4000) })),
    { role: 'user', content: 'latest' },
  ];
  const forced = await updatePromptView(archival, { throughIndex: 0, summary: '', maskedIdx: [], cpt: 3 }, {
    model: 'fake',
    numCtx: 8192,
    ollama: model as any,
    forceCompactionForOutput: true,
    highWaterPct: 75,
    lowWaterPct: 45,
  });
  ok(forced.event?.kind === 'compact' || forced.event?.kind === 'mask', 'forceCompactionForOutput runs mask/compact below high water');

  const fakeOx = await startFakeOpenAI();
  try {
    const mlx = new OpenAiCompatClient({ getBaseUrl: () => fakeOx.url, kind: 'mlx' });
    fakeOx.requests.length = 0;
    await mlx.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 });
    ok(fakeOx.requests[0].body.max_tokens === 64, 'OpenAI-compat sends max_tokens when > 0');
    fakeOx.requests.length = 0;
    await mlx.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 0 });
    ok(!('max_tokens' in fakeOx.requests[0].body), 'OpenAI-compat omits max_tokens when 0');
  } finally {
    fakeOx.close();
  }

  const fakeOl = await startFakeOllama();
  try {
    const ol = new OllamaClient(() => fakeOl.url);
    fakeOl.requests.length = 0;
    await ol.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 32 });
    ok(fakeOl.requests[0].body.options?.num_predict === 32, 'Ollama sends num_predict when > 0');
    fakeOl.requests.length = 0;
    await ol.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 0 });
    ok(!fakeOl.requests[0].body.options?.num_predict, 'Ollama omits num_predict when 0');
  } finally {
    fakeOl.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log('All max_output_guard tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
