#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
MODEL="$HOME/.cache/huggingface/hub/models--mlx-community--gpt-oss-20b-MXFP4-Q8/snapshots/773a7da77e569019bb0fd17a554b263738d669a3"
RUN=(node _devtools/run-ts.js _devtools/bench/run_task.ts --provider mlx --model "$MODEL" --thinking auto --terse true --append-only true --port 8126)
run_one() {
  local task=$1 req=$2 rep=$3 max_iters=$4 timeout=$5
  local flag=$([[ "$req" == on ]] && echo true || echo false)
  local out="_devtools/e2e/results/req-ab2-${task}-req-${req}-r${rep}.json"
  echo "=== $task req-$req r$rep -> $out ==="
  "${RUN[@]}" --task "$task" --requirements "$flag" --max-iters "$max_iters" --timeout-s "$timeout" --out "$out"
}
run_one t11-checklist on 1 50 900
run_one t11-checklist on 2 50 900
run_one t11-checklist off 1 50 900
run_one t11-checklist off 2 50 900
run_one t09-harder-build on 1 80 1200
run_one t09-harder-build on 2 80 1200
run_one t09-harder-build off 1 80 1200
run_one t09-harder-build off 2 80 1200
echo "ROUND2_COMPLETE"
