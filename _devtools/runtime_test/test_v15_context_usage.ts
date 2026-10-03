// ============================================================================
// Context meter: src/util/contextUsage.ts. The meter must count the FULL prompt (cached prefix included), not only the tokens the
// runtime re-evaluated — with a warm cache the evaluated count is ~2% of the real prompt (real trace: promptTokens 96, cached 5131).
// ============================================================================
import { contextUsedTokens } from '../../src/util/contextUsage';

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
const M = (o: object) => ({ model: 'm', ...o });

ok(contextUsedTokens(undefined) === undefined, 'no metrics -> undefined');
ok(contextUsedTokens(M({})) === undefined, 'metrics with no token counts -> undefined');
ok(contextUsedTokens(M({ promptTokens: 96, promptTotalTokens: 5227, cachedTokens: 5131, evalTokens: 40 })) === 5267, 'MLX: uses promptTotalTokens + reply (real trace numbers)');
ok(contextUsedTokens(M({ promptTokens: 96, cachedTokens: 5131, evalTokens: 40 })) === 5267, 'no total: evaluated + cached + reply');
ok(contextUsedTokens(M({ promptTokens: 96, evalTokens: 40, estPromptTokens: 5166 })) === 5206, 'Ollama warm cache (no cached count): falls back to the estimate');
ok(contextUsedTokens(M({ promptTokens: 6000, evalTokens: 40, estPromptTokens: 5166 })) === 6040, 'estimate never undercuts the evaluated count');
ok(contextUsedTokens(M({ promptTokens: 3537, evalTokens: 200 })) === 3737, 'cold call, nothing else known: evaluated + reply');
ok(contextUsedTokens(M({ promptTotalTokens: 8000, estPromptTokens: 100 })) === 8000, 'runtime total wins over the estimate');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
