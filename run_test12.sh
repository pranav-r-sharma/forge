#!/bin/bash
cd /root/work/forge/_devtools/runtime_test
export NODE_PATH="$(pwd)/node_modules"
export TS_NODE_TRANSPILE_ONLY=true
export TS_NODE_COMPILER_OPTIONS='{"ignoreDeprecations":"6.0"}'
npx ts-node test_v12_indent.ts
