#!/usr/bin/env python3
"""Memory-aware Ollama scaling probe: decode + prefill speed vs model size.
One model at a time, small ctx, unload between models, abort on memory pressure/swap growth."""
import json, re, subprocess, sys, time, uuid, statistics, urllib.request

BASE = "http://localhost:11434"
OUT = sys.argv[1]
# (name, kind) smallest -> largest. kind: dense | moe
MODELS = [
    ("phi4-mini-reasoning", "dense"),
    ("ornith:9b", "dense"),
    ("phi4-reasoning", "dense"),
    ("gpt-oss:20b", "moe"),
    ("devstral:24b", "dense"),
    ("qwen3-coder:30b", "moe"),
]
NUM_CTX = 4096
MIN_FREE_PCT = 50
MAX_SWAP_GROWTH_MB = 1024
RUNS = 3
MAX_PROMPT = 3500

def post(path, body, timeout=900):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())

def free_pct():
    out = subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout
    m = re.search(r"free percentage:\s*(\d+)%", out)
    return int(m.group(1)) if m else -1

def swap_used_mb():
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    m = re.search(r"used = ([\d.]+)M", out)
    return float(m.group(1)) if m else 0.0

def loaded():
    return get("/api/ps").get("models", [])

def unload_all():
    for m in loaded():
        try:
            post("/api/generate", {"model": m["name"], "keep_alive": 0}, timeout=60)
        except Exception:
            pass
    for _ in range(30):
        if not loaded():
            return True
        time.sleep(1)
    return not loaded()

import random
def make_body():
    rnd = random.Random(uuid.uuid4().int)
    return "\n".join(
        f"def handler_{rnd.randint(1000,9999)}(request, ctx):\n    value = ctx.get('key_{rnd.randint(1000,9999)}', {rnd.randint(1,999)})\n    if value > {rnd.randint(1,99)}:\n        return {{'id': {rnd.randint(1,9999)}, 'status': 'ok'}}\n    return {{'id': {rnd.randint(1,9999)}, 'status': 'skip'}}\n"
        for i in range(28)
    )
LONG_BODY_OLD = "\n".join(
    f"def handler_{i}(request, ctx):\n    value = ctx.get('key_{i}', {i})\n    if value > {i % 7}:\n        return {{'id': {i}, 'status': 'ok', 'items': [x * {i % 5 + 1} for x in range({i % 9 + 2})]}}\n    return {{'id': {i}, 'status': 'skip'}}\n"
    for i in range(70)
)

def prompts():
    nonce = uuid.uuid4().hex  # unique prefix per run so Ollama can't reuse a cached prompt prefix
    short = f"# run-id: {nonce}\nWrite a Python function that splits a CSV line into fields, respecting double-quoted commas. Keep it short."
    long_ = f"# run-id: {nonce}\n{make_body()}\n\nIn one sentence, what does the code above do?"
    return short, long_

def gen(model, prompt, num_predict):
    r = post("/api/generate", {
        "model": model, "prompt": prompt, "stream": False, "keep_alive": "2m",
        "options": {"temperature": 0, "seed": 0, "num_ctx": NUM_CTX, "num_predict": num_predict},
    })
    pe, pd = r.get("prompt_eval_count", 0), r.get("prompt_eval_duration", 0)
    ee, ed = r.get("eval_count", 0), r.get("eval_duration", 0)
    return {
        "prompt_tokens": pe, "prefill_tps": round(pe / (pd / 1e9), 1) if pd else None,
        "gen_tokens": ee, "decode_tps": round(ee / (ed / 1e9), 2) if ed else None,
        "load_s": round(r.get("load_duration", 0) / 1e9, 2), "total_s": round(r.get("total_duration", 0) / 1e9, 2),
    }

results = {"ollama": get("/api/version"), "num_ctx": NUM_CTX, "models": []}
def save():
    json.dump(results, open(OUT, "w"), indent=2)

def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)

unload_all()
swap0 = swap_used_mb()
log(f"start: free={free_pct()}% swap={swap0}MB")

for name, kind in MODELS:
    fp, sw = free_pct(), swap_used_mb()
    if fp != -1 and fp < MIN_FREE_PCT:
        log(f"SKIP {name}: free memory {fp}% < {MIN_FREE_PCT}%"); results["models"].append({"model": name, "skipped": f"free {fp}%"}); save(); continue
    if sw - swap0 > MAX_SWAP_GROWTH_MB:
        log(f"ABORT before {name}: swap grew {sw - swap0:.0f}MB"); results["aborted"] = f"swap grew {sw - swap0:.0f}MB"; save(); break
    info = post("/api/show", {"model": name})
    entry = {"model": name, "kind": kind, "params": info["details"]["parameter_size"], "quant": info["details"]["quantization_level"], "free_before": fp}
    try:
        log(f"{name}: warmup/load…")
        warm = gen(name, prompts()[0], 16)
        entry["cold_load_s"] = warm["load_s"]
        ps = [m for m in loaded() if m["name"].startswith(name.split(":")[0])]
        if ps:
            entry["resident_gb"] = round(ps[0]["size"] / 1e9, 2)
            entry["resident_vram_gb"] = round(ps[0].get("size_vram", 0) / 1e9, 2)
        entry["free_after_load"] = free_pct()
        short_runs, long_runs = [], []
        for _ in range(RUNS):
            s, l = prompts()
            short_runs.append(gen(name, s, 8))
            long_runs.append(gen(name, l, 48))
        med = lambda rs, k: round(statistics.median([r[k] for r in rs if r[k] is not None]), 2)
        entry.update({
            "decode_tps": med(short_runs, "decode_tps"),
            "prefill_tps": med(long_runs, "prefill_tps"),
            "long_prompt_tokens": med(long_runs, "prompt_tokens"),
            "truncated_suspect": any(r["prompt_tokens"] >= 4000 for r in long_runs),
            "decode_runs": [r["decode_tps"] for r in short_runs],
            "prefill_runs": [r["prefill_tps"] for r in long_runs],
            "min_free_pct_seen": min(entry["free_after_load"], free_pct()),
        })
        log(f"{name}: decode {entry['decode_tps']} tok/s, prefill {entry['prefill_tps']} tok/s, resident {entry.get('resident_gb')} GB, free {free_pct()}%")
    except Exception as e:
        entry["error"] = str(e); log(f"{name}: ERROR {e}")
    results["models"].append(entry); save()
    ok = unload_all()
    log(f"unloaded {name}: {ok}; swap={swap_used_mb()}MB free={free_pct()}%")

results["swap_start_mb"], results["swap_end_mb"] = swap0, swap_used_mb()
save(); log("done")
