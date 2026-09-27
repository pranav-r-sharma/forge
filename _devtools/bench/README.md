# _devtools/bench — hardware/runtime probes

Python, standard library only. Each script takes one argument: the output JSON path.
All are **memory-gated** (check free memory + swap before each load, unload between models, abort on pressure). Run on one model at a time.

| Script | What it measures |
|---|---|
| `scaling_probe.py` | Decode/prefill speed and memory vs model size (Ollama). One-off run 2026-09-26; **closed** — testing is Ornith-only now. Its prefill figures after run 1 are invalid (prompt truncated → cache hit); only decode speed and first-run prefill are trustworthy. |
| `prefill_probe.py` | Corrected prefill-only probe (short prompt, per-run random content). |
| `ctx_limit_probe.py` | Ornith context ceiling: stage 1 = memory cost of each `num_ctx` (KV allocated at load); stage 2 = actually fill the context and time it. Stops at the first gate hit. |

`results/` holds JSON output named `<date>-<hardware>-<what>.json`. Record hardware, versions and model revisions with every result.
