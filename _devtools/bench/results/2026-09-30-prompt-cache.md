# Prompt cache benchmark — gpt-oss-20b MXFP4-Q8 (MLX)

**Date:** 2026-09-30  
**Hardware:** Apple M5, 32 GB RAM  
**Model:** mlx-community/gpt-oss-20b-MXFP4-Q8 (local snapshot `773a7da…`)  
**Forge commit under test:** `bcee0dc` (stable system prefix + trace cache metrics)  
**mlx-lm:** project venv `_devtools/mlx-venv` (offline, `HF_HUB_OFFLINE=1`)

## Pre-flight memory

| Metric | Before load | After unload |
|--------|-------------|--------------|
| `memory_pressure` (vm) | normal (`kern.memorystatus_vm_pressure_level=1`) | normal |
| Available (Forge sampler) | 18.6 GB (58.1% of 32 GB) | 22.3 GB |
| Swap | 0.99 / 2.0 GB used | same |

Gate: available ≥ 50% — **pass**.

## Server

Managed via `MlxServerManager` with packaged defaults: `--prompt-cache-bytes 34359738368` (32 GB), `127.0.0.1:8127`.

```bash
node _devtools/run-ts.js _devtools/bench/mlx_prompt_cache_bench.ts \
  ~/.cache/huggingface/hub/models--mlx-community--gpt-oss-20b-MXFP4-Q8/snapshots/773a7da77e569019bb0fd17a554b263738d669a3 \
  _devtools/bench/results/2026-09-30-prompt-cache-run.json 8127
```

Cold start to `/health`: **2.6 s** (weights already in OS cache). `pgrep` after `stop()`: **0 processes**.

## Forge system prompt stability (task step 4)

- `buildSystemPrompt('bench-ws', 'agent', { terse: true, environmentText: '…' })` called twice: **byte-identical** (`prefixCheck.identical=true` in JSON).
- `test_v15_prompt_prefix.ts`: **11/11** checks (append-only `updatePromptView` preserves full prefix each step).

## Agent-like pattern (3 reps)

Pattern: real Forge `buildSystemPrompt` system message + ~6.7k-token history; req2/req3 append one assistant + tool-result user turn; control edits an early user message.

| Label | prompt total | cached | evaluated | hit % | prefill ms | prefill tok/s | decode tok/s |
|-------|-------------|--------|-----------|-------|------------|---------------|--------------|
| R1-req1 cold+history | 6687 | 0 | 6687 | 0 | 7058 | 947 | 34.8 |
| R1-req2 append tool1 | 6922 | 6686 | 236 | 97 | 461 | 512 | 34.0 |
| R1-req3 append tool2 | 7118 | 6921 | 197 | 97 | 433 | 455 | 35.1 |
| R1-control early edit | 7122 | 3283 | 3839 | 46 | 2936 | 1308 | 35.2 |
| R2-req1 cold+history | 6687 | 6686 | 1 | 100 | 145 | 7* | 35.6 |
| R2-req2 append tool1 | 6922 | 6686 | 236 | 97 | 452 | 522 | 35.3 |
| R2-req3 append tool2 | 7118 | 6921 | 197 | 97 | 445 | 443 | 35.2 |
| R2-control early edit | 7122 | 3283 | 3839 | 46 | 2931 | 1310 | 35.0 |
| R3-req1 cold+history | 6687 | 3283 | 3404 | 49 | 2615 | 1302 | 35.5 |
| R3-req2 append tool1 | 6922 | 6686 | 236 | 97 | 456 | 518 | 35.2 |
| R3-req3 append tool2 | 7118 | 6921 | 197 | 97 | 435 | 453 | 29.5 |
| R3-control early edit | 7122 | 3283 | 3839 | 46 | 3154 | 1217 | 35.2 |

\*When only 1 token is evaluated, prefill tok/s is not meaningful.

Raw JSON: `_devtools/bench/results/2026-09-30-prompt-cache-run.json`

## Conclusions

**Does the prompt cache work after `bcee0dc`?** **Yes** for the intended agent loop on gpt-oss-20b:

- **Append-only steps:** ~**97%** cache hit rate; ~**200–240** new prompt tokens per step; prefill **~430–460 ms** vs **~7.1 s** true cold (R1-req1) → **~15×** faster prefill (TTFT proxy).
- **Exact prefix repeat** (R2-req1 after R1): **100%** hit, **145 ms** prefill.
- **Early-message edit (control):** hit drops to **~46%**; prefill **~2.9–3.2 s** (~**6–7×** slower than append-only warm steps) — shows cost of breaking the shared prefix (stale-read stub scenario).

Decode speed stable **~35 tok/s** (32 max output tokens); not cache-sensitive.

**Prefix stability:** Harness changes in `bcee0dc` do not break byte-stable system prompts across steps; volatile context belongs on the user tail (unit tests + live `buildSystemPrompt` check).

## Issues observed (report only, not fixed)

1. **R3-req1** “cold+history” only **49%** hit after two control branches in the same server session — cache entries for divergent prefixes interact; not a fresh-session cold start.
2. **`prefillTokPerSec`** from client metrics is misleading when `evaluated≈1` but TTFT is still ~145 ms (cached bulk not counted in evaluated tokens).
3. **System prompt copy** still says “local Ollama model” while testing MLX (cosmetic; does not affect cache bytes in this run).
