#!/bin/bash
set -e
for f in main.py inventory/models.py inventory/storage.py inventory/rules.py inventory/services.py inventory/reports.py inventory/cli.py; do
  test -f "$f"
  python3 -m py_compile "$f"
done

python3 main.py demo >/dev/null

dir=$(mktemp -d "${TMPDIR:-/tmp}/forge-library-XXXXXX")
db="$dir/lib.json"
trap 'rm -rf "$dir"' EXIT

add_book() {
  python3 main.py add-book --db "$db" --isbn "$1" --title "T $1" --author "A"
}
add_member() {
  python3 main.py add-member --db "$db" --member-id "$1" --name "N $1"
}

add_member m1
for isbn in 978-a 978-b 978-c 978-d; do add_book "$isbn"; done

python3 main.py borrow --db "$db" --member-id m1 --isbn 978-a --date 2026-01-01
python3 main.py borrow --db "$db" --member-id m1 --isbn 978-b --date 2026-01-02
python3 main.py borrow --db "$db" --member-id m1 --isbn 978-c --date 2026-01-03
if python3 main.py borrow --db "$db" --member-id m1 --isbn 978-d --date 2026-01-04 2>err4; then
  echo "expected 4th borrow to fail"
  exit 1
fi
grep -q '^error:' err4

if python3 main.py borrow --db "$db" --member-id m1 --isbn 978-a --date 2026-01-05 2>errdbl; then
  echo "expected double-loan to fail"
  exit 1
fi
grep -q '^error:' errdbl

fee=$(python3 main.py return --db "$db" --isbn 978-a --date 2026-01-21)
test "$fee" = "fee: 1.50"

add_book 978-cap
python3 main.py borrow --db "$db" --member-id m1 --isbn 978-cap --date 2026-01-01
feecap=$(python3 main.py return --db "$db" --isbn 978-cap --date 2026-04-11)
test "$feecap" = "fee: 10.00"

db2="$dir/overdue-only.json"
python3 main.py add-member --db "$db2" --member-id m1 --name "N m1"
python3 main.py add-book --db "$db2" --isbn 978-od --title "T" --author "A"
python3 main.py borrow --db "$db2" --member-id m1 --isbn 978-od --date 2026-01-01
over=$(python3 main.py overdue --db "$db2" --date 2026-02-01)
test "$over" = "978-od"
