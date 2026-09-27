#!/usr/bin/env python3
"""Summarize a Forge agent trace (.forge/traces/<session>.jsonl) — standard library only.

usage: trace_report.py <trace.jsonl> [--cpt 3.0] [--json]

Answers the questions the v0.15.0 plan is about: how many redundant reads, how much of each prompt the runtime actually had to
re-evaluate vs. what we sent, where the seconds went (model vs tools), how many old reads were pruned to stubs, and what the
hardware looked like. `--cpt` = characters per token used to ESTIMATE tokens sent (Ornith measured ~2.5 on code, ~3-4 on prose); the
"evaluated" figure is what the runtime reported, the "sent" figure is an estimate — so the cache-saved share is approximate.
"""
import argparse, collections, json, sys


def load(path):
    recs = []
    with open(path, encoding="utf8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    recs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # a torn last line (crash mid-write) must not break the report
    return recs


def _sum(rs, key):
    return sum(r[key] for r in rs if isinstance(r.get(key), (int, float)))


def summarize(recs, cpt=3.0):
    if not recs:
        return {"iterations": 0}
    tools = collections.Counter(r["tool"] for r in recs if r.get("tool"))
    reads = [r for r in recs if r.get("tool") == "read_file" and r.get("ok")]
    redundant = [r for r in reads if r.get("redundantRead")]
    model_ms, tool_ms = _sum(recs, "modelMs"), _sum(recs, "toolMs")
    prompt_recs = [r for r in recs if isinstance(r.get("promptTokens"), (int, float)) and isinstance(r.get("promptChars"), (int, float))]
    sent_est = sum(r["promptChars"] / cpt for r in prompt_recs)
    evaluated = sum(r["promptTokens"] for r in prompt_recs)
    pe_recs = [r for r in recs if isinstance(r.get("promptTokens"), (int, float)) and isinstance(r.get("promptEvalMs"), (int, float)) and r["promptEvalMs"] > 0]
    pe_ms = sum(r["promptEvalMs"] for r in pe_recs)
    pe_tok = sum(r["promptTokens"] for r in pe_recs)
    hw = [r["hw"] for r in recs if isinstance(r.get("hw"), dict)]
    pressure_rank = {"normal": 0, "warn": 1, "critical": 2}
    worst = max((h.get("pressure") for h in hw if h.get("pressure") in pressure_rank), key=lambda p: pressure_rank[p], default=None)
    return {
        "iterations": len(recs),
        "turns": len({r.get("turnId") for r in recs}),
        "max_depth": max((r.get("depth", 0) for r in recs), default=0),
        "finished": any(r.get("final") for r in recs),
        "tools": dict(tools.most_common()),
        "tool_failures": sum(1 for r in recs if r.get("tool") and r.get("ok") is False),
        "reads": len(reads),
        "redundant_reads": len(redundant),
        "redundant_read_pct": round(100 * len(redundant) / len(reads), 1) if reads else 0.0,
        "redundant_read_chars": _sum(redundant, "resultChars"),
        "read_chars": _sum(reads, "resultChars"),
        "prompt_chars_first": recs[0].get("promptChars"),
        "prompt_chars_last": recs[-1].get("promptChars"),
        "prompt_chars_max": max((r.get("promptChars", 0) for r in recs), default=0),
        "tokens_evaluated": int(evaluated),
        "tokens_sent_estimate": int(sent_est),
        "cache_saved_pct_estimate": round(max(0.0, 100 * (1 - evaluated / sent_est)), 1) if sent_est > 0 else None,
        "prefill_tok_per_s": round(1000 * pe_tok / pe_ms, 1) if pe_ms > 0 else None,
        "model_s": round(model_ms / 1000, 2),
        "tool_s": round(tool_ms / 1000, 2),
        "model_share_pct": round(100 * model_ms / (model_ms + tool_ms), 1) if (model_ms + tool_ms) > 0 else None,
        "stale_read_stubs_max": max((r.get("staleReadStubs", 0) for r in recs), default=0),
        "compactions": sum(1 for r in recs if r.get("compacted")),
        "hw_min_available_gb": min((h["availableGB"] for h in hw if isinstance(h.get("availableGB"), (int, float))), default=None),
        "hw_max_swap_gb": max((h["swapGB"] for h in hw if isinstance(h.get("swapGB"), (int, float))), default=None),
        "hw_max_gpu_peak_pct": max((h["gpuPeakPct"] for h in hw if isinstance(h.get("gpuPeakPct"), (int, float))), default=None),
        "hw_worst_pressure": worst,
    }


def render(s):
    if not s.get("iterations"):
        return "empty trace"
    L = []
    a = L.append
    a(f"iterations {s['iterations']} · turns {s['turns']} · finished {'yes' if s['finished'] else 'NO'} · tool failures {s['tool_failures']}")
    a("tools: " + ", ".join(f"{k}×{v}" for k, v in s["tools"].items()))
    a(f"reads {s['reads']} · redundant {s['redundant_reads']} ({s['redundant_read_pct']}%) · redundant chars {s['redundant_read_chars']:,} of {s['read_chars']:,}")
    a(f"prompt chars first→last→max: {s['prompt_chars_first']:,} → {s['prompt_chars_last']:,} → {s['prompt_chars_max']:,} · stale-read stubs (max) {s['stale_read_stubs_max']} · compactions {s['compactions']}")
    if s["tokens_sent_estimate"]:
        a(f"tokens evaluated {s['tokens_evaluated']:,} vs ~{s['tokens_sent_estimate']:,} sent (estimate) → cache saved ~{s['cache_saved_pct_estimate']}%")
    if s["prefill_tok_per_s"]:
        a(f"prefill {s['prefill_tok_per_s']} tok/s")
    a(f"time: model {s['model_s']}s · tools {s['tool_s']}s · model share {s['model_share_pct']}%")
    if s["hw_min_available_gb"] is not None or s["hw_max_gpu_peak_pct"] is not None:
        a(f"hardware: min available {s['hw_min_available_gb']} GB · max swap {s['hw_max_swap_gb']} GB · GPU peak {s['hw_max_gpu_peak_pct']}% · worst pressure {s['hw_worst_pressure']}")
    return "\n".join(L)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("trace")
    ap.add_argument("--cpt", type=float, default=3.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    summary = summarize(load(args.trace), args.cpt)
    print(json.dumps(summary, indent=2) if args.json else render(summary))
