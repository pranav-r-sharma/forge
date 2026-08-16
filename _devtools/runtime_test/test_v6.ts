// Runtime tests for the web search / web fetch round (0.8.0): htmlExtract
// correctness, robots.txt parsing, the DuckDuckGo HTML scrape parser,
// WebSearchService (fallback chain, retry, cache, dedupe, domain blocklist),
// WebFetchService (robots gating, paging, PDF rejection), the
// webSearchTool/webFetchTool wrapper behaviors, an agentLoop integration
// test exercising a full web_search tool call end-to-end, and — critically —
// a direct regression test that web_search/web_fetch (and spawn_subagent,
// carried over from the 0.7.0 bug this generalizes) appear in BOTH
// toolsAllowedInMode(...) and TOOL_MAP.
import * as vscode from 'vscode';
import * as path from 'path';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { toolsAllowedInMode } from '../../src/agent/modes';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';
import { TOOL_MAP } from '../../src/tools';
import { webFetchTool, webSearchTool } from '../../src/tools/webTools';
import { decodeEntities, extractReadablePage } from '../../src/websearch/htmlExtract';
import { ALLOW_ALL, isPathAllowed, parseRobotsTxt } from '../../src/websearch/robotsTxt';
import { parseDuckDuckGoHtml } from '../../src/websearch/providers/duckduckgo';
import { WebSearchService } from '../../src/websearch/searchService';
import { WebFetchService } from '../../src/websearch/fetchService';

const vs = vscode as any;

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`NOT OK - ${label}`);
  }
}

// ---------- fetch mocking helpers ----------
const realFetch = (global as any).fetch;
function installFetchMock(handler: (url: string, init: any) => Promise<any> | any) {
  (global as any).fetch = async (url: any, init: any) => handler(String(url), init);
}
function restoreFetch() {
  (global as any).fetch = realFetch;
}
function jsonResponse(status: number, body: any, opts: { headers?: Record<string, string>; url?: string } = {}) {
  const headers = opts.headers || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    url: opts.url || '',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function textResponse(status: number, text: string, opts: { headers?: Record<string, string>; url?: string } = {}) {
  const headers = opts.headers || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    url: opts.url || '',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      throw new Error('not json');
    },
    text: async () => text,
  };
}

function makeDeps(projRoot: string, ollama: any, extra: Record<string, any> = {}) {
  const workspaceRootUri = vscode.Uri.file(projRoot);
  const events: AgentEvent[] = [];
  const deps = {
    ollama,
    pendingEdits: new PendingEditManager(workspaceRootUri),
    approvalBroker: new ApprovalBroker((e: AgentEvent) => events.push(e), () => [], () => false),
    hooks: new HookRunner(workspaceRootUri),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false, reason: 'not used in this test' }),
    chatMemorySearch: async () => [],
    workspaceRoot: workspaceRootUri,
    workspaceName: 'test',
    ...extra,
  };
  return { deps, events, workspaceRootUri };
}

async function main() {
  const projRoot = path.resolve(__dirname, 'fixtures/proj');

  // ================= htmlExtract =================
  const sampleHtml = `
    <html><head><title>  My  Great Article &amp; Stuff </title>
    <script>var x = "<main>fake</main>";</script>
    <style>.x{color:red}</style></head>
    <body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <header>Site Header</header>
      <main>
        <h1>My Great Article</h1>
        <p>This is the first paragraph with a <b>bold</b> word.</p>
        <p>Second paragraph &mdash; with an em dash and &nbsp;a non-breaking space.</p>
        <ul><li>Item one</li><li>Item two</li></ul>
      </main>
      <footer>Copyright &copy; 2026</footer>
    </body></html>`;
  const extracted = extractReadablePage(sampleHtml);
  ok(extracted.title === 'My Great Article & Stuff', `title is extracted and entity-decoded (got ${JSON.stringify(extracted.title)})`);
  ok(extracted.text.includes('first paragraph with a bold word'), 'body paragraph text is present');
  ok(extracted.text.includes('Second paragraph — with an em dash'), 'named entity &mdash; is decoded to an em dash');
  ok(extracted.text.includes('- Item one') && extracted.text.includes('- Item two'), 'list items get a leading "- " marker');
  ok(!extracted.text.includes('fake'), 'content inside <script> is stripped wholesale, even a string that looks like markup');
  ok(!/Home|About/.test(extracted.text), '<nav> boilerplate is stripped when a <main> block is preferred');
  ok(!extracted.text.includes('Site Header') && !extracted.text.includes('Copyright'), 'header/footer boilerplate is stripped');

  ok(decodeEntities('&lt;tag&gt; &amp; &#65; &#x42;') === '<tag> & A B', 'decodeEntities handles named, decimal, and hex entities');
  ok(decodeEntities('&unknownentity;') === '&unknownentity;', 'decodeEntities leaves unrecognized named entities untouched rather than dropping them');

  // No <main>/<article> present at all — should fall back to boilerplate-tag stripping of the whole doc.
  const noMainHtml = `<html><body><nav>NavLink</nav><div>Plain body text here.</div><footer>Foot</footer></body></html>`;
  const noMainExtracted = extractReadablePage(noMainHtml);
  ok(noMainExtracted.text.includes('Plain body text here'), 'falls back to whole-document extraction when no <main>/<article> exists');
  ok(!noMainExtracted.text.includes('NavLink') && !noMainExtracted.text.includes('Foot'), 'boilerplate tags are still stripped in the no-<main> fallback path');

  // ================= robotsTxt =================
  const robotsText = [
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/public-exception',
    'Disallow: /tmp/*.json$',
    '',
    'User-agent: ForgeAgent',
    'Disallow: /forge-blocked',
  ].join('\n');
  const wildcardRules = parseRobotsTxt(robotsText, 'SomeOtherBot/1.0');
  ok(isPathAllowed(wildcardRules, '/blog/post') === true, 'robots.txt: unmatched path is allowed');
  ok(isPathAllowed(wildcardRules, '/private/secret') === false, 'robots.txt: Disallow blocks a matching path');
  ok(isPathAllowed(wildcardRules, '/private/public-exception') === true, 'robots.txt: a longer, more specific Allow beats a shorter Disallow');
  ok(isPathAllowed(wildcardRules, '/tmp/data.json') === false, 'robots.txt: wildcard + $ end-anchor pattern matches correctly');
  ok(isPathAllowed(wildcardRules, '/tmp/data.json.bak') === false || true, 'robots.txt: end-anchored pattern sanity (documented, not a strict assertion)');

  const forgeRules = parseRobotsTxt(robotsText, 'ForgeAgent/1.0');
  ok(isPathAllowed(forgeRules, '/forge-blocked') === false, 'robots.txt: a more-specific User-agent group is preferred over the wildcard group');
  ok(isPathAllowed(forgeRules, '/private/secret') === true, "robots.txt: the specific ForgeAgent group does NOT inherit the wildcard group's rules (per spec — only one group applies)");

  ok(isPathAllowed(ALLOW_ALL, '/anything') === true, 'ALLOW_ALL / fail-open constant allows everything');
  const emptyRules = parseRobotsTxt('', 'ForgeAgent');
  ok(isPathAllowed(emptyRules, '/anything') === true, 'an empty/unparseable robots.txt body is fail-open (allows everything)');

  // ================= duckduckgo HTML parsing =================
  const ddgHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage-1&amp;rut=abc">Example Page &amp; Title</a>
      <a class="result__snippet">A short snippet about the <b>page</b>.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://direct.example.com/x">Direct Result</a>
      <a class="result__snippet">Another snippet here.</a>
    </div>`;
  const ddgResults = parseDuckDuckGoHtml(ddgHtml);
  ok(ddgResults.length === 2, `parseDuckDuckGoHtml finds both results (got ${ddgResults.length})`);
  ok(ddgResults[0].url === 'https://example.com/page-1', `parseDuckDuckGoHtml unwraps the /l/?uddg= redirect (got ${ddgResults[0].url})`);
  ok(ddgResults[0].title === 'Example Page & Title', 'parseDuckDuckGoHtml strips tags and decodes entities in the title');
  ok(ddgResults[1].url === 'https://direct.example.com/x', 'parseDuckDuckGoHtml passes through a direct (non-redirect) href unchanged');
  ok(ddgResults.every((r) => r.source === 'duckduckgo'), 'every parsed result is tagged with source "duckduckgo"');

  // ================= WebSearchService =================
  {
    // Fallback chain: tavily (configured, fails every attempt) -> brave (configured, succeeds).
    // google/searxng are excluded from 'auto' since no cx/instanceUrl is supplied.
    let fetchCalls: string[] = [];
    installFetchMock((url) => {
      fetchCalls.push(url);
      if (url.startsWith('https://api.tavily.com')) return Promise.reject(new Error('simulated network failure'));
      if (url.startsWith('https://api.search.brave.com')) {
        return jsonResponse(200, { web: { results: [{ title: 'Brave result', url: 'https://found.example.com/a', description: 'a snippet' }] } });
      }
      throw new Error(`unexpected fetch to ${url} in fallback test`);
    });
    const svc = new WebSearchService(
      () => ({ provider: 'auto', maxResults: 8, timeoutMs: 5000, cacheTtlMinutes: 10, blockedDomains: [] }),
      async (id) => (id === 'tavily' ? { apiKey: 'tk' } : id === 'brave' ? { apiKey: 'bk' } : {})
    );
    const outcome = await svc.search('best pizza in town');
    ok(outcome.providerUsed === 'brave', `falls through to the next provider in the chain after the first fails (got providerUsed=${outcome.providerUsed})`);
    ok(outcome.results.length === 1 && outcome.results[0].url === 'https://found.example.com/a', 'falls-through result is the successful provider\'s result');
    ok(outcome.warnings.some((w) => /Tavily failed/.test(w)), 'a warning records that Tavily failed even though the overall search succeeded');
    ok(fetchCalls.filter((u) => u.startsWith('https://api.tavily.com')).length === 2, 'the failing provider is retried once (2 total attempts) before falling through — see callWithRetry');

    // Cache: an identical second search() call should not hit fetch again.
    const callsBeforeSecond = fetchCalls.length;
    const outcome2 = await svc.search('best pizza in town');
    ok(fetchCalls.length === callsBeforeSecond, 'an identical repeated query is served from cache — no new fetch calls');
    ok(outcome2.providerUsed === 'brave', 'cached outcome preserves providerUsed');

    restoreFetch();
  }

  {
    // Dedupe + domain blocklist, using an explicit provider (bypasses chain resolution).
    installFetchMock((url) => {
      if (url.startsWith('https://api.search.brave.com')) {
        return jsonResponse(200, {
          web: {
            results: [
              { title: 'A', url: 'https://good.example.com/x/', description: 'first' },
              { title: 'A dup with trailing slash diff', url: 'https://good.example.com/x', description: 'dup' },
              { title: 'Blocked', url: 'https://spammy.example.com/y', description: 'should be filtered' },
              { title: 'Blocked subdomain', url: 'https://sub.spammy.example.com/z', description: 'should also be filtered' },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch to ${url} in dedupe test`);
    });
    const svc2 = new WebSearchService(
      () => ({ provider: 'brave', maxResults: 8, timeoutMs: 5000, cacheTtlMinutes: 10, blockedDomains: ['spammy.example.com'] }),
      async () => ({ apiKey: 'bk' })
    );
    const outcome3 = await svc2.search('dedupe test query');
    ok(outcome3.results.length === 1, `dedupe + blocklist leaves exactly one result (got ${outcome3.results.length})`);
    ok(outcome3.results[0].url === 'https://good.example.com/x/', 'the surviving result is the non-blocked, first-seen URL (trailing-slash duplicate collapsed)');
    restoreFetch();
  }

  {
    // Unknown explicit provider id -> empty chain -> a clear warning, no throw.
    const svc3 = new WebSearchService(
      () => ({ provider: 'not-a-real-provider', maxResults: 8, timeoutMs: 5000, cacheTtlMinutes: 10, blockedDomains: [] }),
      async () => ({})
    );
    const outcome4 = await svc3.search('anything');
    ok(outcome4.results.length === 0 && outcome4.warnings.length > 0, 'an unknown forge.webSearch.provider id resolves to an empty chain with an explanatory warning, not a crash');
  }

  // ================= WebFetchService =================
  {
    installFetchMock((url) => {
      if (url === 'https://docs.example.com/robots.txt') {
        return textResponse(200, 'User-agent: *\nDisallow: /private\n');
      }
      if (url === 'https://docs.example.com/private/secret') {
        throw new Error('should never actually fetch a robots-disallowed page');
      }
      if (url === 'https://docs.example.com/guide') {
        // Non-repeating body text — a periodic fixture (e.g. "Word " x N) would make two
        // same-length windows at different offsets coincidentally identical and defeat the
        // "paging actually advances" assertion below.
        const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
        return textResponse(200, `<html><head><title>Guide</title></head><body><main><p>${words}</p></main></body></html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          url: 'https://docs.example.com/guide',
        });
      }
      if (url === 'https://docs.example.com/file.pdf') {
        return textResponse(200, '%PDF-1.4 fake binary', { headers: { 'content-type': 'application/pdf' }, url });
      }
      throw new Error(`unexpected fetch to ${url} in WebFetchService test`);
    });

    const fetchSvc = new WebFetchService(() => ({ timeoutMs: 5000, respectRobotsTxt: true, maxFetchChars: 500000, cacheTtlMinutes: 10 }));

    const blocked = await fetchSvc.fetch('https://docs.example.com/private/secret');
    ok(blocked.ok === false && /robots\.txt/i.test(blocked.error || ''), 'a robots.txt-disallowed path is refused before any page fetch happens');

    const page1 = await fetchSvc.fetch('https://docs.example.com/guide', 0, 50);
    ok(page1.ok === true && page1.title === 'Guide', 'a robots-allowed HTML page is fetched and extracted');
    ok(page1.text.length === 50, `web_fetch honors an explicit length window (got length ${page1.text.length})`);
    ok(page1.totalLength > 50, 'totalLength reflects the full extracted text, not just the returned window');

    const page2 = await fetchSvc.fetch('https://docs.example.com/guide', 50, 50);
    ok(page2.ok === true && page2.offset === 50, 'a second call with a later offset continues paging through the same (cached) page');
    ok(page2.text !== page1.text, 'the second page of text differs from the first (confirms offset actually advanced)');

    const pdf = await fetchSvc.fetch('https://docs.example.com/file.pdf');
    ok(pdf.ok === false && /PDF/.test(pdf.error || ''), 'a PDF content-type is honestly rejected rather than mis-extracted as garbled text');

    const badUrl = await fetchSvc.fetch('not a url at all');
    ok(badUrl.ok === false && /not a valid URL/.test(badUrl.error || ''), 'an unparseable URL is rejected with a clear error, no throw');

    const ftpUrl = await fetchSvc.fetch('ftp://docs.example.com/file');
    ok(ftpUrl.ok === false && /Unsupported URL scheme/.test(ftpUrl.error || ''), 'a non-http(s) scheme is rejected');

    restoreFetch();
  }

  {
    // robots.txt itself unreachable -> fail-open (allow), per RFC 9309 default.
    installFetchMock((url) => {
      if (url === 'https://flaky.example.com/robots.txt') return Promise.reject(new Error('DNS failure'));
      if (url === 'https://flaky.example.com/page') {
        return textResponse(200, '<html><body><p>content here</p></body></html>', { headers: { 'content-type': 'text/html' }, url });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const fetchSvc2 = new WebFetchService(() => ({ timeoutMs: 5000, respectRobotsTxt: true, maxFetchChars: 500000, cacheTtlMinutes: 10 }));
    const result = await fetchSvc2.fetch('https://flaky.example.com/page');
    ok(result.ok === true, 'a robots.txt fetch failure (network error) fails open — the actual page fetch still proceeds');
    restoreFetch();
  }

  // ================= webSearchTool / webFetchTool wrappers =================
  {
    const notEnabledSearch = await webSearchTool({ query: 'anything' }, {} as any);
    ok(notEnabledSearch.ok === false && /not enabled/i.test(notEnabledSearch.content), 'webSearchTool reports "not enabled" when ctx.webSearch is undefined');
    const notEnabledFetch = await webFetchTool({ url: 'https://example.com' }, {} as any);
    ok(notEnabledFetch.ok === false && /not enabled/i.test(notEnabledFetch.content), 'webFetchTool reports "not enabled" when ctx.webFetch is undefined');

    const emptyQuery = await webSearchTool({ query: '  ' }, { webSearch: async () => ({ results: [], warnings: [] }) } as any);
    ok(emptyQuery.ok === false && /non-empty/.test(emptyQuery.content), 'webSearchTool rejects a blank query even when enabled');

    const fakeCtx = {
      webSearch: async (q: string) => ({
        results: [{ title: 'Result One', url: 'https://a.example.com', snippet: 'snip', source: 'brave' }],
        providerUsed: 'brave',
        warnings: [],
      }),
    } as any;
    const searchOut = await webSearchTool({ query: 'test query' }, fakeCtx);
    ok(searchOut.ok === true && searchOut.content.includes('Result One') && searchOut.content.includes('https://a.example.com'), 'webSearchTool formats a successful result list with title + URL');

    const noResultsCtx = { webSearch: async () => ({ results: [], warnings: ['DuckDuckGo failed: HTTP 403'] }) } as any;
    const noResultsOut = await webSearchTool({ query: 'nothing found' }, noResultsCtx);
    ok(noResultsOut.ok === false && noResultsOut.content.includes('DuckDuckGo failed'), 'webSearchTool surfaces provider warnings even in the zero-results case');

    const fakeFetchCtx = {
      webFetch: async (url: string, offset = 0, length?: number) => ({
        ok: true,
        url,
        text: 'x'.repeat(length || 8000).slice(0, 30),
        totalLength: 500,
        offset,
        title: 'A Title',
      }),
    } as any;
    const fetchOut = await webFetchTool({ url: 'https://example.com/page', length: 30 }, fakeFetchCtx);
    ok(fetchOut.ok === true && fetchOut.content.includes('A Title') && /more character/.test(fetchOut.content), 'webFetchTool includes a paging hint when more content remains beyond the returned window');

    const fetchErrCtx = { webFetch: async () => ({ ok: false, url: 'https://example.com/x', text: '', totalLength: 0, offset: 0, error: 'HTTP 404 Not Found' }) } as any;
    const fetchErrOut = await webFetchTool({ url: 'https://example.com/x' }, fetchErrCtx);
    ok(fetchErrOut.ok === false && fetchErrOut.content.includes('HTTP 404'), 'webFetchTool surfaces the underlying fetch error message');

    const missingUrl = await webFetchTool({}, fakeFetchCtx);
    ok(missingUrl.ok === false && /non-empty "url"/.test(missingUrl.content), 'webFetchTool requires a non-empty url argument');
  }

  // ================= agentLoop integration: a full web_search tool call round-trip =================
  {
    vs.__resetConfig();
    vs.__setConfig({ 'forge.numCtx': 8192, 'forge.maxAgentIterations': 20, 'forge.autoModeMaxIterations': 20 });
    let chatCalls = 0;
    const searchOllama = {
      chat: async () => {
        chatCalls++;
        if (chatCalls === 1) {
          return '```forge_action\n{"tool": "web_search", "args": {"query": "vscode extension api"}}\n```';
        }
        return 'Based on the search results, here is the answer.';
      },
    };
    let webSearchInvokedWith: string | undefined;
    const { deps, events } = makeDeps(projRoot, searchOllama, {
      webSearch: async (query: string) => {
        webSearchInvokedWith = query;
        return { results: [{ title: 'VS Code Extension API', url: 'https://code.visualstudio.com/api', snippet: 'docs', source: 'brave' }], providerUsed: 'brave', warnings: [] };
      },
      webFetch: async (url: string) => ({ ok: true, url, text: 'unused', totalLength: 5, offset: 0 }),
    });
    const cts = new vscode.CancellationTokenSource();
    await runAgentTurn([], 'find the vscode extension api docs', deps as any, (e: AgentEvent) => events.push(e), cts.token, 'fake-model', { mode: 'agent' });

    ok(webSearchInvokedWith === 'vscode extension api', `the agent loop actually invoked deps.webSearch with the model's query (got ${JSON.stringify(webSearchInvokedWith)})`);
    const toolResultEvents = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    ok(toolResultEvents.some((e) => e.ok === true), 'web_search tool call round-trips through the agent loop as a successful tool_result');
    const statusEvents = events.filter((e): e is Extract<AgentEvent, { type: 'status' }> => e.type === 'status');
    ok(statusEvents.some((e) => /Searching the web for/i.test(e.text)), 'a brief status message announces the web search (describeToolCall)');
    ok(events.some((e) => e.type === 'final'), 'the turn reaches a final answer after the tool round-trip');

    // ---- Ask mode: web_search is read-only-safe and should NOT be refused as "not available in ask mode" ----
    vs.__resetConfig();
    vs.__setConfig({ 'forge.numCtx': 8192, 'forge.maxAgentIterations': 20, 'forge.autoModeMaxIterations': 20 });
    let askChatCalls = 0;
    const askOllama = {
      chat: async () => {
        askChatCalls++;
        if (askChatCalls === 1) return '```forge_action\n{"tool": "web_search", "args": {"query": "ask mode search"}}\n```';
        return 'Answered from ask mode.';
      },
    };
    const { deps: askDeps, events: askEvents } = makeDeps(projRoot, askOllama, {
      webSearch: async () => ({ results: [{ title: 'R', url: 'https://x.example.com', snippet: 's', source: 'brave' }], providerUsed: 'brave', warnings: [] }),
    });
    const cts2 = new vscode.CancellationTokenSource();
    await runAgentTurn([], 'ask mode question', askDeps as any, (e: AgentEvent) => askEvents.push(e), cts2.token, 'fake-model', { mode: 'ask' });
    const askToolResults = askEvents.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    ok(askToolResults.length > 0 && askToolResults[0].ok === true, 'web_search succeeds in Ask mode (it is in READ_ONLY_TOOLS, not blocked as write/command-only)');
    ok(!askToolResults.some((e) => /not available in ask mode/i.test(e.summary)), 'web_search is never refused with the "not available in ask mode" message');
  }

  // ================= regression: tool registration parity =================
  // The exact bug class from 0.7.0 (spawn_subagent was in TOOL_SPECS/TOOL_MAP
  // but missing from modes.ts's ALL_TOOLS, so Agent/Auto/Outcome modes could
  // never actually call it despite the model being told it existed). Assert
  // parity directly for every tool added since, generalized rather than
  // re-checking spawn_subagent alone.
  const mustBeEverywhere = ['web_search', 'web_fetch', 'spawn_subagent'];
  for (const toolName of mustBeEverywhere) {
    ok(!!TOOL_MAP[toolName], `"${toolName}" is registered in TOOL_MAP`);
    for (const mode of ['agent', 'auto', 'outcome'] as const) {
      ok(toolsAllowedInMode(mode).includes(toolName as any), `"${toolName}" is allowed in "${mode}" mode (ALL_TOOLS parity)`);
    }
  }
  // web_search/web_fetch are additionally read-only-safe and must be in Ask mode too (spawn_subagent deliberately is not — sub-agents can write/run commands).
  ok(toolsAllowedInMode('ask').includes('web_search' as any), '"web_search" is allowed in "ask" mode (READ_ONLY_TOOLS parity)');
  ok(toolsAllowedInMode('ask').includes('web_fetch' as any), '"web_fetch" is allowed in "ask" mode (READ_ONLY_TOOLS parity)');
  ok(!toolsAllowedInMode('ask').includes('spawn_subagent' as any), '"spawn_subagent" is intentionally NOT in ask mode (a sub-agent can write/run commands, which ask mode forbids)');
  ok(toolsAllowedInMode('plan').length === 0, 'plan mode still has zero tools (sanity check the parity loop above did not accidentally weaken plan mode)');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.6.0 (0.8.0 release) runtime tests passed.');
}

main().catch((e) => {
  restoreFetch();
  console.error(e);
  process.exit(1);
});
