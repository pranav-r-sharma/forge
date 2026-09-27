#!/bin/bash
set -e
for f in main.py tracker/models.py tracker/storage.py tracker/reports.py tracker/cli.py; do
  test -f "$f"
  python3 -m py_compile "$f"
done
out=$(python3 main.py demo 2>&1)
echo "$out" | tail -5
test -n "$out"
db=$(mktemp "${TMPDIR:-/tmp}/forge-expenses-XXXXXX.json")
python3 main.py --db "$db" add --amount 12.50 --category groceries --note milk --date 2026-01-15
sum=$(python3 main.py --db "$db" summary 2>&1)
echo "$sum"
echo "$sum" | grep -qi groceries
rm -f "$db"
