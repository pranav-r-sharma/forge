#!/usr/bin/env python3
"""Raw MLX smoke/speed test for an Ornith snapshot (offline, no remote code).
usage: mlx_smoke.py <snapshot-dir> [prompt_tokens_target] ; prints one JSON line."""
import json, os, sys, time, uuid, random
os.environ.setdefault("HF_HUB_OFFLINE", "1")
import mlx.core as mx
from mlx_lm import load, stream_generate

path = sys.argv[1]
target = int(sys.argv[2]) if len(sys.argv) > 2 else 2000
t0 = time.time()
model, tok = load(path)               # trust_remote_code stays off (default)
load_s = time.time() - t0
mx.reset_peak_memory()
rnd = random.Random(uuid.uuid4().int)
body = "\n".join(f"def handler_{rnd.randint(1000,99999)}(request, ctx):\n    value = ctx.get('key_{rnd.randint(1000,99999)}', {rnd.randint(1,9999)})\n    return {{'id': {rnd.randint(1,99999)}, 'ok': value > {rnd.randint(1,999)}}}\n" for _ in range(max(1, target // 45)))
msgs = [{"role": "user", "content": f"{body}\n\nIn one short sentence, what does the code above do?"}]
prompt = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)
last = None; text = ""
for r in stream_generate(model, tok, prompt, max_tokens=48):
    last = r; text += r.text
print(json.dumps({"snapshot": os.path.basename(os.path.dirname(path.rstrip('/'))) if path.endswith('/') else os.path.basename(path),
    "load_s": round(load_s, 2), "prompt_tokens": last.prompt_tokens, "prefill_tps": round(last.prompt_tps, 1),
    "gen_tokens": last.generation_tokens, "decode_tps": round(last.generation_tps, 2),
    "peak_gb": round(last.peak_memory, 2), "mlx_active_gb": round(mx.get_active_memory()/1e9, 2), "sample": text[:100]}))
