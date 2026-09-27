Build a small Python 3 command-line expense tracker from scratch in this empty repository. Use only the standard library.

Create exactly these five code files (`tracker/__init__.py` may exist and does not count toward the five):

- `tracker/models.py` — an `Expense` dataclass (`amount` float, `category` str, `note` str, `date` str `YYYY-MM-DD`) with validation (`amount` > 0, valid date format).
- `tracker/storage.py` — load and save a list of expenses as JSON at a file path you pass in. If the db path does not exist yet, treat it as an empty expense list.
- `tracker/reports.py` — compute total per category and overall total.
- `tracker/cli.py` — `argparse` commands: `add`, `list`, `summary`, `demo`. Each of `add`, `list`, and `summary` takes `--db PATH` (default `expenses.json`) on that subcommand.
- `main.py` (repo root) — entry point that calls `tracker.cli.main()`.

Use these exact CLI forms:

- `python3 main.py add --db PATH --amount 12.50 --category groceries --note milk --date 2026-01-15`
- `python3 main.py list --db PATH`
- `python3 main.py summary --db PATH`
- `python3 main.py demo`

The `demo` command must use a fresh temporary db file, add at least 3 expenses in 2+ categories, list them, print the summary, and exit 0.

When you are done:

1. Check each of the 5 files compiles: `python3 -m py_compile <file>`. Fix any errors.
2. Run the program end to end: `python3 main.py demo`, and also `add`, `list`, and `summary` with `--db PATH` where `PATH` is a new file that does not exist yet. Fix failures and rerun until everything works.
3. Finish with a short summary of what you ran and the results.
