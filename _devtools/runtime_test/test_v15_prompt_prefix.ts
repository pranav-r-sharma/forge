// Prompt-prefix stability for KV / prompt-cache reuse (task C, 2026-09-30).
import { buildSystemPrompt, buildTurnContextPrefix } from '../../src/agent/systemPrompt';
import { isPromptPrefixExtension, serializePromptMessages, sharedPrefixLength } from '../../src/agent/promptPrefix';
import { updatePromptView } from '../../src/agent/contextManager';
import { ChatMessage } from '../../src/ollama/types';

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

function testTurnContextNotInSystem() {
  const mem = '## Memory\n- user prefers pytest';
  const sys = buildSystemPrompt('proj', 'agent', { memoryText: mem } as any);
  ok(!sys.includes('Memory'), 'memoryText must not be passed into buildSystemPrompt (would rewrite the cached system prefix every turn)');
  const prefix = buildTurnContextPrefix({ memoryText: mem, milestonesText: '## Milestones\n- step 1' });
  ok(prefix.includes('Memory') && prefix.includes('Milestones'), 'volatile context is prepended on the user turn via buildTurnContextPrefix');
}

function testMcpToolOrderStable() {
  const a = buildSystemPrompt('w', 'agent', { mcpTools: [{ name: 'z_tool', describe: 'Z', exampleArgs: {} }, { name: 'a_tool', describe: 'A', exampleArgs: {} }] });
  const b = buildSystemPrompt('w', 'agent', { mcpTools: [{ name: 'a_tool', describe: 'A', exampleArgs: {} }, { name: 'z_tool', describe: 'Z', exampleArgs: {} }] });
  ok(a === b, 'MCP tools are sorted by name so discovery order does not break the system-prompt prefix');
}

async function testConsecutiveStepsSharePrefix() {
  const sys: ChatMessage = { role: 'system', content: buildSystemPrompt('w', 'agent') };
  const task: ChatMessage = { role: 'user', content: 'do work' };
  let archival: ChatMessage[] = [sys, task];
  const ollama = { chat: async () => 'SUMMARY' };
  let state: any;
  let prevView: ChatMessage[] = [];
  for (let i = 0; i < 5; i++) {
    archival.push(
      { role: 'assistant', content: `step ${i}` },
      { role: 'user', content: `[Tool "read_file" result]\nfile ${i}\n${'x'.repeat(200)}` }
    );
    const r = await updatePromptView(archival, state, { model: 'm', numCtx: 131072, ollama, highWaterPct: 75, lowWaterPct: 45 });
    state = r.state;
    if (prevView.length) {
      ok(isPromptPrefixExtension(prevView, r.view), `append-only step ${i}: prompt view extends the previous prefix`);
      const sp = sharedPrefixLength(serializePromptMessages(prevView), serializePromptMessages(r.view));
      ok(sp === serializePromptMessages(prevView).length, `step ${i}: shared prefix covers the entire previous prompt`);
    }
    prevView = r.view;
  }
}

async function main() {
  testTurnContextNotInSystem();
  testMcpToolOrderStable();
  await testConsecutiveStepsSharePrefix();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
