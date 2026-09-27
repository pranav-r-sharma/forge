#!/usr/bin/env python3
"""Tests for trace_report.py — synthetic trace with known numbers. Run: python3 _devtools/bench/test_trace_report.py"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import trace_report as tr

passed = failed = 0
def ok(cond, msg):
    global passed, failed
    if cond: passed += 1; print("ok -", msg)
    else: failed += 1; print("NOT OK -", msg)

def rec(i, **kw):
    base = dict(v=1, ts="t", sessionId="s", turnId="t1", iter=i, depth=0, model="m", mode="auto", promptChars=3000 * (i + 1), promptMsgs=i + 2,
                staleReadStubs=0, compacted=False, modelMs=1000, promptTokens=500, evalTokens=20, promptEvalMs=1000)
    base.update(kw); return base

recs = [
    rec(0, tool="read_file", ok=True, toolMs=10, resultChars=4000, redundantRead=False, hw=dict(availableGB=20.0, swapGB=0.5, gpuPeakPct=80, pressure="normal")),
    rec(1, tool="read_file", ok=True, toolMs=10, resultChars=4000, redundantRead=True, hw=dict(availableGB=18.0, swapGB=0.9, gpuPeakPct=100, pressure="warn")),
    rec(2, tool="grep", ok=False, toolMs=30, resultChars=10, staleReadStubs=2),
    rec(3, final=True, compacted=True, staleReadStubs=3),
]
s = tr.summarize(recs, cpt=3.0)
ok(s["iterations"] == 4 and s["turns"] == 1 and s["finished"] is True, "iterations, turns, finished")
ok(s["tools"] == {"read_file": 2, "grep": 1} and s["tool_failures"] == 1, "tool counts and failures")
ok(s["reads"] == 2 and s["redundant_reads"] == 1 and s["redundant_read_pct"] == 50.0 and s["redundant_read_chars"] == 4000 and s["read_chars"] == 8000, "redundant reads: count, %, chars")
ok(s["prompt_chars_first"] == 3000 and s["prompt_chars_last"] == 12000 and s["prompt_chars_max"] == 12000, "prompt growth")
sent = (3000 + 6000 + 9000 + 12000) / 3.0
ok(s["tokens_evaluated"] == 2000 and s["tokens_sent_estimate"] == int(sent) and abs(s["cache_saved_pct_estimate"] - round(100 * (1 - 2000 / sent), 1)) < 0.05, f"evaluated vs sent estimate → cache saved ~{s['cache_saved_pct_estimate']}%")
ok(s["prefill_tok_per_s"] == 500.0, "prefill speed = tokens / prompt-eval seconds")
ok(s["model_s"] == 4.0 and s["tool_s"] == 0.05 and abs(s["model_share_pct"] - 98.8) < 0.05, "model vs tool time split")
ok(s["stale_read_stubs_max"] == 3 and s["compactions"] == 1, "stale stubs and compactions")
ok(s["hw_min_available_gb"] == 18.0 and s["hw_max_swap_gb"] == 0.9 and s["hw_max_gpu_peak_pct"] == 100 and s["hw_worst_pressure"] == "warn", "hardware low-points and worst pressure")
ok("cache saved" in tr.render(s) and "redundant 1 (50.0%)" in tr.render(s), "rendered report mentions the key numbers")
ok(tr.summarize([]) == {"iterations": 0} and tr.render({"iterations": 0}) == "empty trace", "empty trace handled")
s2 = tr.summarize([{"iter": 0, "turnId": "x"}])
ok(s2["reads"] == 0 and s2["redundant_read_pct"] == 0.0 and s2["cache_saved_pct_estimate"] is None and s2["prefill_tok_per_s"] is None, "records with missing fields yield None/0, not errors")
with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
    f.write(json.dumps(recs[0]) + "\n" + "{ this line is torn")
ok(len(tr.load(f.name)) == 1, "a torn last line (crash mid-write) is skipped, not fatal")
os.unlink(f.name)
print(f"\n{passed} passed, {failed} failed.")
sys.exit(1 if failed else 0)
