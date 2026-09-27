#!/bin/bash
# Run the whole e2e suite for two configs on one model. usage: run_suite.sh <label> <model-snapshot> <provider> <reps> "<config A>" "<config B>"
# each config is "name=extra run_task args". Writes _devtools/e2e/results/<label>-<task>-<config>-r<N>.json and a per-task summary.
cd "$(dirname "$0")/../.." || exit 1
label="$1"; model="$2"; provider="$3"; reps="$4"; shift 4
for task in t01-fix-bug t02-locate t03-add-function t04-rename-symbol t05-large-file t06-multi-file-feature; do
  echo "=== $task"
  python3 _devtools/bench/run_matrix.py "$label-$task" "$task" "$model" "$provider" "$reps" "$@"
done
echo "=== SUITE DONE"
