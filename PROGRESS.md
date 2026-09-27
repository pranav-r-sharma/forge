# PROGRESS

**Goal:** Make Forge a fast, thoroughly vetted, MLX-first coding harness for multi-file repos, verified on Ornith-1.5-9B only.

**Status:** **DEVELOPMENT STARTED 2026-09-26.** Owner: "go start"; MLX install approved; efficiency is paramount; test/monitor/iterate; final acceptance test = harness writes a multi-file program in a test repo inside this repo.
**Branch:** `v0.15.0-work` (commits allowed here). **Plan and reasons:** `v0.15.0 suggestions.md`.

## Plan (small steps; each a few minutes; split further if it runs long)

Phase 0 (first). Section numbers refer to `v0.15.0 suggestions.md`.

1. **P0-1** Restore a runnable test setup: create the `vscode` stub for `_devtools/runtime_test`, make one existing test (`test_v14_indent_hardening.ts`) run here. (§0.4.1)
2. **P0-2** Add `npm test` that runs all existing `test_*.ts` scripts; record which pass/fail today.
3. **P0-3** Hardware readout, memory: sampler that reads `sysctl hw.memsize`, `kern.memorystatus_level`, `vm.swapusage`, and `vm_stat` (page size read from its header). Fixture-based unit tests. (§1.4)
4. **P0-4** Hardware readout, GPU: parse `ioreg -c IOAccelerator` (`Device Utilization %`, `In use system memory`); fixture tests; `n/a` on failure. (§1.4)
5. **P0-5** Wire the sampler into the composer footer / HW panel: replace the `os.freemem()`-based RAM number; add free memory + GPU %. (§1.4)
6. **P0-6** Trace log: per-iteration JSONL writer under `.forge/traces/` (tool, sizes, prompt tokens, eval tokens, tok/s, timings). (§1.1)
7. **P0-7** Trace log: add hardware sample (memory low-point, swap change, GPU avg/peak) to each record. (§1.1, §1.4)
8. **P0-8** `LlmProvider` interface + `OllamaProvider` wrapping today's client; **no behavior change**; all tests still pass. Split per call site (16 files). (§0.1a)
9. **P0-9** Provider capabilities + per-role routing (chat / sub-agent / compaction / autocomplete / embeddings). (§0.1a)
10. **P0-10** OpenAI-compatible streaming client with fake-server tests (streaming, abort, malformed SSE, tool_calls, usage, crash). (§0.1b, §0.1f)
11. **P0-11** MLX server lifecycle manager (start/ready/stop/crash, output channel). **Needs the MLX venv (approval).** (§0.1c)
12. **P0-12** MLX setup wizard + `doctor` / runtime check; MLX model picker; context limit read from model config. (§0.1d)
13. **P0-13** Headless bench runner + `--json` events; first 10–15 eval tasks on a fixture repo. (§0.3, §8.2)
14. **P0-14** Baseline report on Ornith: O-Q4 vs M-4 vs M-8 × harness arms A / B1 / B2. (§0.2c, §0.3)
15. **P0-15** Truncation detection + real-token counting (§2.1b) — needed before trusting any long-context result.
16. **P0-16** KV/prompt-cache experiments on Ornith: in-session reuse (Ollama, then MLX), MLX save/load + identical-output check, hybrid-trim behavior, KV quantization, disk speed. Needs the MLX venv (approval). (§2.1c)
17. **P0-17** Keep the prompt append-only (stop rewriting the prefix each step) and re-measure cache hit rate — likely the biggest single speed win. (§2.1, §2.1c)

Then 0.15.0 items (see "Suggested release slicing" in the plan) once Phase 0 numbers exist.

## Done
- Wrote `v0.15.0 suggestions.md`: Phase 0 (MLX, Ornith-only testing, A/B matrix), cross-spec review, hardware-readout requirement (§1.4), truncation finding (§2.1b), release slicing.
- Measured (Ollama 0.34.3, this Mac M5 32 GB): speed vs model size for 6 models (kept as scaling reference; **closed — Ornith only from now on**). Results are in the plan §0.2b.
- Created branch `v0.15.0-work`; added `CLAUDE.md` (standing rules + dev cycle) and this file.
- Added Directive 6 / standing rule 6: **no sudo in anything that ships** (removed `powermetrics` from the product plan; GPU working-set limit is read, never changed). Audited the plan: only the `powermetrics` mention needed privileges.
- Measured cold prefill cost vs prompt size on Ornith (6.6k→29 s, 13k→62 s, 26k→143 s, 52k→449 s) and wrote the KV/prompt-cache hot-warm-cold plan (§2.1c; owner idea).
- **P0-1/P0-2 DONE:** runnable test setup — `_devtools/stubs/vscode` (fs-backed stub with `__setConfig/__resetConfig`), `_devtools/run-ts.js` (type-strip runner), `_devtools/run-tests.js` + `npm test`. Baseline: **23/23 files, 782 checks pass**, typecheck 0 errors, `npm run compile` OK. Fixed 2 real type errors in `chatSession.ts` (`Thenable.catch`) that the old sandbox shim hid — `tsc` did not build on a normal machine before. Dev deps installed with `npm install --no-save` (typescript 5.4, @types/node 20, @types/vscode 1.85; declared in package.json already).
- **P0-3 DONE:** `src/util/hwSampler.ts` — accurate memory readout (Activity-Monitor definition: used = anon−purgeable+wired+compressed; page size read from `vm_stat` header; pressure via `kern.memorystatus_vm_pressure_level`; n/a on failure; exec errors never throw; non-macOS labelled approximation). 36 checks in `test_v15_hwsampler.ts` incl. a real 16 KB-page fixture and a live check (old method said 24.3 GB used vs accurate 11.2 GB). Corrected plan §1.4: `kern.memorystatus_level` is a pressure heuristic, NOT free memory. `npm test`: 24/24 files, 818 checks.
- **P0-4 DONE:** GPU readout in `hwSampler.ts` — `parseIoregAccelerator` (device/renderer/tiler %, in-use/alloc GB, model, cores), `readGpuSamples`, `readGpuWiredLimitMB` (read-only). Real ioreg fixture (trimmed, no identifiers). 52 checks in `test_v15_hwsampler.ts`. **Live validation while MLX ran a 7.5k-token prompt:** GPU 0→67→100%, GPU memory 0.2→6–7 GB (MLX peak 6.7 GB), used 11.2→~18 GB, used+available=32 GB throughout, pressure normal. GPU % is jumpy at start (67,10,1,20) → display must smooth. Metal recommended working set here = 24.96 GB, max buffer 18.72 GB.
- **P0-5a DONE:** `HwSampler` class in `hwSampler.ts` (single timer, no overlapping reads, coalesced `sampleOnce`, GPU moving average over ~4 s + per-turn peak with `resetPeak()`, failed source → n/a not stale). **Test-runner hardening:** `run-tests.js` now requires a completion line — Node exits 0 silently when the event loop empties mid-await (an unref'd timer did this), which previously passed with checks unrun; verified it reports `INCOMPLETE`. `npm test`: 24/24, 849 checks (hwsampler file: 67).
- **P0-5b DONE:** accurate readout wired end to end. `chatViewProvider.ts` owns one `HwSampler` (2 s idle / 1 s while busy, `resetPeak()` on turn start, pushes `hwStatus` itself — the footer used to refresh only on click, which was a second cause of stale numbers), `ollama.ps()` cached 4 s, `dispose()` registered in `extension.ts`; `protocol.ts` `HwStatus.memory`/`gpus`; `media/webview.js` footer shows `Mem used/total · free · pressure · swap · GPU avg% · GB` with `n/a` when missing and a tooltip defining each number + age; NVIDIA path kept only as non-mac fallback. Pure mapping `hwFieldsForUi()` tested. `npm test` 24/24 (854 checks), typecheck 0, compile OK. **Not verified visually** (no VS Code GUI run from this environment) — Owner: please glance at the footer after installing; the tooltip should match Activity Monitor.
- **P0-6 DONE:** trace log. `src/agent/readCoverage.ts` (pure range tracker → `redundantRead`), `src/agent/traceLog.ts` (`TraceWriter` JSONL to `.forge/traces/<session>.jsonl`, ordered, rotates at 5 MB, best-effort — never throws; `argsHash`; no file/command contents stored), Ollama metrics now carry `promptEvalDurationMs`/`evalDurationMs`, `forge.trace.enabled` (default true), hooked into `agentLoop.ts` (per iteration: prompt chars/msgs, stale-read stubs, compaction flag, model ms, tokens, tok/s, tool, args hash, path/range, tool ms, result chars, redundantRead, final/notes) and `chatSession.ts`. 52 checks in `test_v15_trace.ts` incl. the real loop with a scripted model. `npm test` 25/25 files.
- **P0-7 DONE:** hardware in every trace record (`hw`: used/available/swap/pressure/GPU avg+peak/GPU mem) via `AgentDeps.hw` ← `ChatSessionServices.hwSnapshot` ← provider's sampler; a failing/absent provider drops only the `hw` key, never the record or the turn. 59 checks in `test_v15_trace.ts`.
- **P0-8 DONE:** `_devtools/bench/trace_report.py` (stdlib; per-session summary: iterations, tools, redundant reads %, prompt growth, tokens evaluated vs sent estimate → cache saved ~%, prefill tok/s, model vs tool time, stale stubs, compactions, hardware low-points) + `test_trace_report.py` (13 checks); `npm test` now also runs `_devtools/bench/test_*.py`.
- **P0-9 DONE:** `src/llm/provider.ts` (`LlmProvider`, `ProviderCapabilities`, `OLLAMA_CAPABILITIES`); `OllamaClient implements LlmProvider` (no behavior change); 14 files' `OllamaClient` type annotations → `LlmProvider` (agent loop, sub-agents, compaction, planFirst/critique/bestOfN, memoryReview, inline edit, autocomplete, both indexes, status bar, commands, session, provider). Call-site map: all traffic uses 6 methods (`health, listModels, ps, embed, chat, generate`). New reusable contract `_devtools/runtime_test/provider_contract.ts` + `fixtures/fakeOllama.ts` (fake HTTP server) + `test_v15_provider.ts` (16 checks incl. abort mid-stream, error surfacing, embed-never-throws, unchanged request wire shape).
- **MLX installed** (project venv `_devtools/mlx-venv`, pinned in `_devtools/mlx-requirements.txt`: mlx 0.32.2, mlx-lm 0.31.3; `qwen3_5` supported; offline, no remote code). Raw smoke on Ornith: **4-bit prefill 455 tok/s @2.5k and 445 @16k, decode 18.2/16.4 tok/s, peak 6.6/7.0 GB; 8-bit prefill 386/384, decode 11.1/9.9, peak 11.0/11.4 GB**. vs Ollama Q4_K_M: MLX-4bit is ~1.4× faster prefill at 2.5k, ~2.1× at ~13–16k (Ollama slows with length, MLX did not in this range), and ~1.3× faster decode. Single runs — repeat for medians. Results: `_devtools/bench/results/2026-09-26-m5-32gb-ornith-mlx-raw-smoke.json`.
- Verified the RAM number is wrong: `os.freemem()` says 7.7 GB free (harness would show 24.3 GB used) while macOS reports 61% free.
- Ornith context-limit probe (Ollama Q4_K_M, memory-gated), **stopped by the owner after the 64k step**: full 262,144-token context loads at 15.1 GB (~35 KB/token), no swap growth; cold prefill of 6.6k/13k/26k/52k tokens took 29/62/143/449 s (231/212/183/116 tok/s), decode 13.8→10.5 tok/s; free memory dipped to 28% at 52k though Ollama reported 8.5 GB. Results: `_devtools/bench/results/2026-09-26-m5-32gb-ornith-ollama-q4km-ctx-limit.json`. The 128k+ fill steps were NOT run.

## Next
**P0-10:** OpenAI-compatible client (`src/llm/openaiCompatClient.ts`, `implements LlmProvider`, capabilities id `'mlx'`/`'openai-compatible'`): `chat` via `POST /v1/chat/completions` with `stream:true` (SSE parser: `data: {...}`, `[DONE]`, tolerate comments/keep-alives/split chunks), map `usage.prompt_tokens/completion_tokens`, measure TTFT + tok/s client-side (no Ollama-style durations), `max_tokens`/`stop`/`temperature`, abort, `health`+`listModels` via `GET /v1/models`, `ps()` → [] (or the served model), `embed` → undefined unless `/v1/embeddings` exists, `generate` via `/v1/completions`. Reuse `runProviderContract` against a new `fixtures/fakeOpenAI.ts` (streaming SSE, usage, errors, slow stream, malformed lines, keep-alive comments). Then **P0-11:** settings `forge.provider` (`ollama`|`mlx`|`openai-compatible`), `forge.mlx.*`, and provider selection in `extension.ts`.

## Owner decisions (2026-09-26)
- Start given. MLX install approved (project venv, pinned, offline, no remote code, no sudo).
- **Max stage models:** "Ornith 1 30B" and "Qwen 3.8 27B" on the M5 Max (not tested on this 32 GB Mac; Directive 4 keeps testing here Ornith-9B only). Note: Qwen3.8-27B is one of the two models the parked Splash engine supports.
- 45-minute pause rule when near the context limit (see CLAUDE.md rule 7).

## Open questions / blockers
- ~~MLX install approval~~ — **approved.** Still to check: Python 3.14 may lack MLX wheels; if so ask before installing another Python.
- ~~Max stage model~~ — answered (Ornith 30B-class + Qwen 3.8 27B). Exact model IDs/quantizations to confirm when we get to the Max stage.
- **Ollama 8-bit Ornith tag:** does one exist, and may I download it? (Optional arm O-Q8.)

## Files touched (this session)
`v0.15.0 suggestions.md`, `CLAUDE.md`, `PROGRESS.md`, `_devtools/bench/*` (probe scripts).

**Last updated:** 2026-09-27 01:00
