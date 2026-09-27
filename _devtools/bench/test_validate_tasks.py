#!/usr/bin/env python3
"""npm-test wrapper: every e2e eval task must fail on its starting repo and pass with its reference solution."""
import os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
p = subprocess.run([sys.executable, os.path.join(here, "validate_tasks.py")], capture_output=True, text=True)
print(p.stdout.strip())
n = sum(1 for l in p.stdout.splitlines() if l.startswith("OK "))
b = sum(1 for l in p.stdout.splitlines() if l.startswith("BAD "))
print(f"\n{n} passed, {b} failed.")
sys.exit(1 if (b or p.returncode) else 0)
