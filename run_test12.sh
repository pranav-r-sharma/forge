#!/bin/bash
# Runs one test file (default: the 0.12.0 indentation test). Run the whole suite with `npm test`.
cd "$(dirname "$0")"
node _devtools/run-ts.js "_devtools/runtime_test/${1:-test_v12_indent.ts}"
