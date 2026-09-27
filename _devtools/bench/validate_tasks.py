#!/usr/bin/env python3
"""Validate the e2e eval tasks (standard library only): for every task, check.sh must FAIL on the starting repo and PASS once the reference
solution is applied — otherwise a "model failure" could really be a broken task. Also verifies protected files are untouched by the reference.
usage: validate_tasks.py [task-id ...]   (default: all)"""
import json, os, shutil, subprocess, sys, tempfile

root = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "_devtools", "e2e", "tasks")
ids = sys.argv[1:] or sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
bad = 0

def run_check(task_dir, ws, final_text):
    ff = os.path.join(ws, ".forge-final.txt")
    open(ff, "w").write(final_text)
    env = dict(os.environ, FORGE_TASK_DIR=task_dir, FORGE_FINAL_FILE=ff, PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.run(["bash", os.path.join(task_dir, "check.sh")], cwd=ws, env=env, capture_output=True, text=True, timeout=120)
    return p.returncode, (p.stdout + p.stderr).strip().splitlines()[-3:]

for tid in ids:
    td = os.path.join(root, tid)
    meta = json.load(open(os.path.join(td, "meta.json")))
    ws = tempfile.mkdtemp(prefix=f"forge-validate-{tid}-")
    shutil.copytree(os.path.join(td, "repo"), ws, dirs_exist_ok=True)
    before, tail_b = run_check(td, ws, "")
    ref = os.path.join(td, "reference")
    if os.path.isdir(ref):
        for dp, _, fns in os.walk(ref):
            for fn in fns:
                if fn == ".keep": continue
                src = os.path.join(dp, fn); dst = os.path.join(ws, os.path.relpath(src, ref))
                os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy(src, dst)
    after, tail_a = run_check(td, ws, meta.get("referenceFinal", ""))
    touched = [f for f in meta.get("protected", []) if os.path.exists(os.path.join(ref, f))]
    ok = before != 0 and after == 0 and not touched
    bad += 0 if ok else 1
    print(f"{'OK  ' if ok else 'BAD '} {tid:<26} starting repo: {'fails' if before else 'PASSES (task is already solved!)'} | with reference: {'passes' if after == 0 else 'FAILS'}{' | reference edits protected files: ' + str(touched) if touched else ''}")
    if not ok:
        print("     start:", tail_b, "\n     ref:  ", tail_a)
    shutil.rmtree(ws, ignore_errors=True)
print(f"\n{len(ids) - bad}/{len(ids)} tasks valid")
sys.exit(1 if bad else 0)
