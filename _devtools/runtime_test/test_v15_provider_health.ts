import { formatForgeHealthErrorToast } from '../../src/util/providerHealth';
import type { ForgeConfig } from '../../src/util/config';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}

function base(partial: Partial<ForgeConfig>): ForgeConfig {
  return {
    provider: 'ollama',
    mlxBaseUrl: 'http://127.0.0.1:8123',
    openaiCompatBaseUrl: 'http://127.0.0.1:1234',
    mlxAutoStart: true,
    ...partial,
  } as ForgeConfig;
}

function main() {
  const mlx = formatForgeHealthErrorToast(base({ provider: 'mlx' }), 'connection refused');
  ok(mlx.includes('MLX server') && mlx.includes('8123') && mlx.includes('autoStart'), 'MLX toast mentions server URL and autoStart');
  const ollama = formatForgeHealthErrorToast(base({ provider: 'ollama' }), 'down');
  ok(ollama.includes('Ollama') && ollama.includes('ollama serve'), 'Ollama toast unchanged');
  const openai = formatForgeHealthErrorToast(base({ provider: 'openai-compatible' }), '401');
  ok(openai.includes('OpenAI-compatible') && openai.includes('1234'), 'openai-compat toast uses base URL');
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.15.0 provider health tests passed.');
}

main();
