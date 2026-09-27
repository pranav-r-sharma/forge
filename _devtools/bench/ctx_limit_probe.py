#!/usr/bin/env python3
"""Ornith-only context-ceiling probe on Ollama, with hard safety gates.
Stage 1: load at increasing num_ctx, record memory (KV is allocated at load). Stops at first gate hit.
Stage 2: actually FILL the context (unique prompt) and measure prefill/TTFT/decode + memory, aborting the request if pressure rises."""
import http.client, json, re, subprocess, sys, threading, time, uuid, random

MODEL = "ornith:9b"
OUT = sys.argv[1]
CTXS = [8192, 16384, 32768, 65536, 131072, 196608, 262144]  # model max is 262144
# ---- safety gates (Mac: M5, 32 GB) ----
MIN_FREE_PCT_BEFORE = 45     # don't even start a step below this
ABORT_FREE_PCT = 18          # abort an in-flight request below this
MAX_RESIDENT_GB = 21.0       # stay under the GPU working-set limit (~2/3-3/4 of RAM)
MAX_SWAP_GROWTH_MB = 1500
STEP_TIMEOUT_S = 1500        # 25 min per fill step
FILL_FRACTION = 0.70
CHARS_PER_TOKEN = 2.5        # measured ~2.6 for this prompt style on Ornith

def http_json(method, path, body=None, timeout=60):
    c = http.client.HTTPConnection("localhost", 11434, timeout=timeout)
    c.request(method, path, json.dumps(body) if body is not None else None, {"Content-Type": "application/json"})
    r = c.getresponse(); data = r.read(); c.close()
    return json.loads(data)

def free_pct():
    out = subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout
    m = re.search(r"free percentage:\s*(\d+)%", out); return int(m.group(1)) if m else -1

def swap_mb():
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    m = re.search(r"used = ([\d.]+)M", out); return float(m.group(1)) if m else 0.0

def resident():
    for m in http_json("GET", "/api/ps").get("models", []):
        if m["name"].startswith("ornith"):
            return round(m["size"] / 1e9, 2), round(m.get("size_vram", 0) / 1e9, 2), m.get("context_length")
    return None, None, None

def unload():
    try: http_json("POST", "/api/generate", {"model": MODEL, "keep_alive": 0}, timeout=60)
    except Exception: pass
    for _ in range(40):
        if not http_json("GET", "/api/ps").get("models"): return True
        time.sleep(1)
    return False

def log(msg): print(time.strftime("%H:%M:%S"), msg, flush=True)

def make_prompt(target_chars):
    rnd = random.Random(uuid.uuid4().int)
    parts, n = [f"# run-id: {uuid.uuid4().hex}"], 0
    while n < target_chars:
        s = (f"def handler_{rnd.randint(1000,99999)}(request, ctx):\n    value = ctx.get('key_{rnd.randint(1000,99999)}', {rnd.randint(1,9999)})\n"
             f"    if value > {rnd.randint(1,999)}:\n        return {{'id': {rnd.randint(1,99999)}, 'status': 'ok'}}\n    return {{'id': {rnd.randint(1,99999)}, 'status': 'skip'}}\n")
        parts.append(s); n += len(s)
    parts.append("\nIn one short sentence, what does the code above do?")
    return "\n".join(parts)

def generate_guarded(prompt, num_ctx, num_predict):
    """Runs one request in a thread; the main thread watches memory and closes the connection (cancelling the run) on pressure."""
    result = {}
    conn = http.client.HTTPConnection("localhost", 11434, timeout=STEP_TIMEOUT_S)
    def worker():
        try:
            conn.request("POST", "/api/generate", json.dumps({
                "model": MODEL, "prompt": prompt, "stream": False, "keep_alive": "2m",
                "options": {"temperature": 0, "seed": 0, "num_ctx": num_ctx, "num_predict": num_predict}}),
                {"Content-Type": "application/json"})
            result["r"] = json.loads(conn.getresponse().read())
        except Exception as e:
            result["err"] = str(e)
    t = threading.Thread(target=worker, daemon=True); t.start()
    t0, low_free, peak_res, abort = time.time(), 100, 0.0, None
    swap0 = swap_mb()
    while t.is_alive():
        time.sleep(4)
        f = free_pct(); low_free = min(low_free, f if f != -1 else low_free)
        r, _, _ = resident(); peak_res = max(peak_res, r or 0)
        if f != -1 and f < ABORT_FREE_PCT: abort = f"free memory {f}% < {ABORT_FREE_PCT}%"
        elif swap_mb() - swap0 > MAX_SWAP_GROWTH_MB: abort = f"swap grew {swap_mb()-swap0:.0f}MB"
        elif time.time() - t0 > STEP_TIMEOUT_S: abort = f"step timeout {STEP_TIMEOUT_S}s"
        if abort:
            try: conn.close()
            except Exception: pass
            break
    t.join(timeout=5)
    return result, abort, low_free, peak_res, round(time.time() - t0, 1)

results = {"model": MODEL, "ollama": http_json("GET", "/api/version"), "gates": {
    "min_free_before": MIN_FREE_PCT_BEFORE, "abort_free": ABORT_FREE_PCT, "max_resident_gb": MAX_RESIDENT_GB, "max_swap_growth_mb": MAX_SWAP_GROWTH_MB},
    "stage1": [], "stage2": []}
def save(): json.dump(results, open(OUT, "w"), indent=2)

unload(); swap_start = swap_mb(); log(f"start free={free_pct()}% swap={swap_start}MB")

# ---------- Stage 1: memory cost of each context size (KV is allocated at load) ----------
stop_reason = None
for ctx in CTXS:
    fp = free_pct()
    if fp != -1 and fp < MIN_FREE_PCT_BEFORE: stop_reason = f"free {fp}% before ctx {ctx}"; break
    if swap_mb() - swap_start > MAX_SWAP_GROWTH_MB: stop_reason = f"swap growth before ctx {ctx}"; break
    done_rows = [r for r in results["stage1"] if r["resident_gb"]]
    if len(done_rows) >= 2:  # extrapolate memory linearly from the last two steps; never attempt a load predicted to exceed the cap
        a, b = done_rows[-2], done_rows[-1]
        slope = (b["resident_gb"] - a["resident_gb"]) / (b["ctx"] - a["ctx"])
        predicted = b["resident_gb"] + slope * (ctx - b["ctx"])
        log(f"stage1 ctx={ctx}: predicted resident {predicted:.1f} GB (cap {MAX_RESIDENT_GB})")
        if predicted > MAX_RESIDENT_GB * 0.97:
            stop_reason = f"predicted {predicted:.1f} GB > cap at ctx {ctx} (not loaded)"; break
    log(f"stage1 ctx={ctx}: loading…")
    res, abort, low, peak, secs = generate_guarded("hi", ctx, 1)
    gb, vram, cl = resident()
    row = {"ctx": ctx, "resident_gb": gb, "vram_gb": vram, "context_reported": cl, "load_total_s": secs, "free_pct_low": low,
           "swap_mb": swap_mb(), "error": res.get("err") or (res.get("r") or {}).get("error"), "aborted": abort}
    results["stage1"].append(row); save(); log(f"stage1 {row}")
    unload()
    if abort or row["error"]: stop_reason = abort or row["error"]; break
    if gb and gb > MAX_RESIDENT_GB: stop_reason = f"resident {gb} GB > {MAX_RESIDENT_GB} GB at ctx {ctx}"; break
    if vram is not None and gb and vram < gb * 0.98: stop_reason = f"spilled to CPU at ctx {ctx} (vram {vram} < size {gb})"; break
results["stage1_stop_reason"] = stop_reason; save(); log(f"stage1 done; stop_reason={stop_reason}")

# ---------- Stage 2: actually fill the context ----------
ok_ctxs = [r["ctx"] for r in results["stage1"] if not r["aborted"] and not r["error"]]
prev = None
for ctx in ok_ctxs:
    fp = free_pct()
    if fp != -1 and fp < MIN_FREE_PCT_BEFORE: results["stage2_stop_reason"] = f"free {fp}% before fill {ctx}"; break
    if prev:  # predict time from the last step (attention makes it worse than linear); skip if it would blow the step cap
        predicted = prev["total_s"] * (ctx / prev["ctx"]) ** 1.5
        if predicted > STEP_TIMEOUT_S: results["stage2_stop_reason"] = f"predicted {predicted:.0f}s > cap {STEP_TIMEOUT_S}s at ctx {ctx}"; log(results["stage2_stop_reason"]); break
    prompt = make_prompt(int(ctx * FILL_FRACTION * CHARS_PER_TOKEN))
    log(f"stage2 ctx={ctx}: filling ~{int(ctx*FILL_FRACTION)} tokens…")
    res, abort, low, peak, secs = generate_guarded(prompt, ctx, 32)
    r = res.get("r") or {}
    pe, pd, ee, ed = r.get("prompt_eval_count", 0), r.get("prompt_eval_duration", 0), r.get("eval_count", 0), r.get("eval_duration", 0)
    row = {"ctx": ctx, "prompt_tokens": pe, "truncated_suspect": pe >= ctx - 40, "prefill_s": round(pd / 1e9, 1) if pd else None,
           "prefill_tps": round(pe / (pd / 1e9), 1) if pd else None, "decode_tps": round(ee / (ed / 1e9), 2) if ed else None,
           "total_s": secs, "peak_resident_gb": peak, "free_pct_low": low, "swap_mb": swap_mb(),
           "error": res.get("err") or r.get("error"), "aborted": abort, "answer": (r.get("response") or "")[:120]}
    results["stage2"].append(row); save(); log(f"stage2 {row}")
    unload()
    if abort or row["error"]: results["stage2_stop_reason"] = abort or row["error"]; break
    prev = row

results["swap_start_mb"], results["swap_end_mb"] = swap_start, swap_mb(); save(); log("done")
