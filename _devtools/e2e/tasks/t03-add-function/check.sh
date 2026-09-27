#!/bin/bash
# Pass = hidden acceptance cases for slugify pass + the repo's own tests pass + the tests file exercises slugify at least 3 times.
set -e
PYTHONPATH=. python3 "${FORGE_TASK_DIR:?}/acceptance.py"
out=$(python3 -m unittest discover -s tests -t . 2>&1)
echo "$out" | tail -3
echo "$out" | grep -q "^OK"
# the task asks for at least 3 test CASES (assertions), not necessarily 3 test methods
cases=$(grep -c 'slugify(' tests/test_strings.py)
[ "${cases:-0}" -ge 3 ]   # at least 3 lines that call slugify(...)
