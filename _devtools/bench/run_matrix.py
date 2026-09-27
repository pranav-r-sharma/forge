#!/usr/bin/env python3
"""Run run_task.ts over a matrix of configs x repetitions and print median results (standard library only).
usage: run_matrix.py <label> <task> <snapshot-or-model> <provider> <reps> <config-name>=<extra args>... 
  e.g. run_matrix.py ab1 t01-fix-bug /path/snap mlx 3 "base=--thinking off --terse false --no-env" "env=--thinking off --terse false" 
Each run is memory-safe (one server at a time, stopped after every run). Results: _devtools/e2e/results/<label>-<config>-r<N>.json"""
import json, os, statistics, subprocess, sys, time

label, task, model, provider, reps = sys.argv[1:6]
configs = [a.split("=", 1) for a in sys.argv[6:]]
repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
outdir = os.path.join(repo, "_devtools", "e2e", "results")
os.makedirs(outdir, exist_ok=True)
rows = {}
for name, extra in configs:
    for r in range(1, int(reps) + 1):
        out = os.path.join(outdir, f"{label}-{name}-r{r}.json")
        cmd = ["node", "_devtools/run-ts.js", "_devtools/bench/run_task.ts", "--task", task, "--provider", provider, "--model", model, "--out", out, "--timeout-s", "600", "--max-iters", "30"] + extra.split()
        t = time.time()
        p = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=900)
        try:
            res = json.load(open(out))
        except Exception:
            res = {"pass": False, "crash": (p.stderr or p.stdout)[-400:]}
        rows.setdefault(name, []).append(res)
        print(f"[{name} r{r}] pass={res.get('pass')} wall={res.get('wallS')} iters={res.get('iterations')} evalTok={res.get('evalTokens')} cache={res.get('cacheHitPct')}% ({time.time()-t:.0f}s incl. server)", flush=True)

def med(rs, k):
    v = [x[k] for x in rs if isinstance(x.get(k), (int, float))]
    return round(statistics.median(v), 1) if v else None

print("\nconfig      pass   wall_s  iters  evalTok  tool_fail  cache%   (medians)")
for name, rs in rows.items():
    passes = sum(1 for x in rs if x.get("pass"))
    print(f"{name:<11} {passes}/{len(rs)}  {med(rs,'wallS'):>7}  {med(rs,'iterations'):>5}  {med(rs,'evalTokens'):>7}  {med(rs,'toolFailures'):>9}  {med(rs,'cacheHitPct'):>6}")
json.dump({k: v for k, v in rows.items()}, open(os.path.join(outdir, f"{label}-summary.json"), "w"), indent=2)
