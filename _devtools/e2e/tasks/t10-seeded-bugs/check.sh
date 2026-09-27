#!/bin/bash
set -e
for f in main.py sales/parser.py sales/validate.py sales/aggregate.py sales/cli.py; do
  test -f "$f"
  python3 -m py_compile "$f"
done
test -f data/sales.csv

report=$(python3 main.py report data/sales.csv)
expected_report=$(cat <<'EOF'
apple: 4.50
banana: 2.25
cherry: 4.00
total: 10.75
EOF
)
test "$report" = "$expected_report"

top=$(python3 main.py top data/sales.csv)
test "$top" = "apple"
