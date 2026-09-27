#!/bin/bash
# Pass = the CLI behaves as specified end to end (hidden acceptance), and the repo's own tests pass with at least 2 test methods covering the storage layer.
set -e
PYTHONPATH=. python3 "${FORGE_TASK_DIR:?}/acceptance.py"
out=$(python3 -m unittest discover -s tests -t . 2>&1); echo "$out" | tail -3
echo "$out" | grep -q "^OK"
n=$(echo "$out" | sed -n 's/^Ran \([0-9]*\) tests.*/\1/p'); [ "${n:-0}" -ge 2 ]
