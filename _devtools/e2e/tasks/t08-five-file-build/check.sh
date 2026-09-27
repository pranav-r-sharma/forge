#!/bin/bash
set -e
for f in main.py tracker/models.py tracker/storage.py tracker/reports.py tracker/cli.py; do
  test -f "$f"
  python3 -m py_compile "$f"
done
out=$(python3 main.py demo 2>&1)
echo "$out" | tail -5
test -n "$out"
dir=$(mktemp -d "${TMPDIR:-/tmp}/forge-expenses-XXXXXX")
db="$dir/expenses.json"
python3 main.py add --db "$db" --amount 12.50 --category groceries --note milk --date 2026-01-15
python3 main.py list --db "$db" | grep -q milk
sum=$(python3 main.py summary --db "$db" 2>&1)
echo "$sum"
echo "$sum" | grep -qi groceries
rm -rf "$dir"
