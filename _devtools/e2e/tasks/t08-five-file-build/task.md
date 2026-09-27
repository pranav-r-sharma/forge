Build a small Python 3 command-line expense tracker from scratch in this empty repository. Use only the standard library.

Create exactly these five code files (`tracker/__init__.py` may exist and does not count toward the five):

- `tracker/models.py` — an `Expense` dataclass (`amount` float, `category` str, `note` str, `date` str `YYYY-MM-DD`) with validation (`amount` > 0, valid date format).
- `tracker/storage.py` — load and save a list of expenses as JSON at a file path you pass in.
- `tracker/reports.py` — compute total per category and overall total.
- `tracker/cli.py` — `argparse` commands: `add`, `list`, `summary`, `demo`. Every command takes `--db PATH` (default `expenses.json`).
- `main.py` (repo root) — entry point that calls `tracker.cli.main()`.

The `demo` command must use a fresh temporary db file, add at least 3 expenses in 2+ categories, list them, print the summary, and exit 0.

When you are done:

1. Check each of the 5 files compiles: `python3 -m py_compile <file>`. Fix any errors.
2. Run the program end to end: `python3 main.py demo`, and also `python3 main.py add ...`, `list`, and `summary` against a temp `--db`. Fix failures and rerun until everything works.
3. Finish with a short summary of what you ran and the results.
