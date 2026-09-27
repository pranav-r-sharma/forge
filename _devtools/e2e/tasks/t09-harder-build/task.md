Build a small Python 3 **library loan system** from scratch in this empty repository. Use only the standard library.

Create exactly these seven code files (`inventory/__init__.py` may exist and does not count toward the seven):

- `inventory/models.py` — `Book`, `Member`, and `Loan` dataclasses with validation (`Book`: `isbn`, `title`, `author`; `Member`: `member_id`, `name`; `Loan`: `isbn`, `member_id`, `borrow_date`, `due_date` as `YYYY-MM-DD`).
- `inventory/storage.py` — JSON persistence at a `--db` path for books, members, active loans, return-fee history, and borrow history. Missing db file = empty library.
- `inventory/rules.py` — borrow limit **3** active loans per member; loan period **14** days from borrow date; late fee **$0.25** per calendar day after the due date, **capped at $10.00**; a book with an active loan cannot be borrowed again.
- `inventory/services.py` — `borrow(member_id, isbn, date)` and `return_book(isbn, date) -> fee` (float dollars), raising clear exceptions when rules are violated.
- `inventory/reports.py` — overdue ISBNs as of a date, total late fees per member from returns, most-borrowed ISBNs.
- `inventory/cli.py` — `argparse` subcommands (each takes `--db PATH`): `add-book`, `add-member`, `borrow`, `return`, `overdue`, `fees`, `demo`. Dates are `YYYY-MM-DD`. On failure, print `error: <message>` to **stderr** and exit **1**.
- `main.py` — entry point calling `inventory.cli.main()`.

**CLI forms** (always pass `--db`):

- `python3 main.py add-book --db PATH --isbn ISBN --title TITLE --author AUTHOR`
- `python3 main.py add-member --db PATH --member-id ID --name NAME`
- `python3 main.py borrow --db PATH --member-id ID --isbn ISBN --date YYYY-MM-DD`
- `python3 main.py return --db PATH --isbn ISBN --date YYYY-MM-DD`
- `python3 main.py overdue --db PATH --date YYYY-MM-DD`
- `python3 main.py fees --db PATH`
- `python3 main.py demo`

**Exact output formats:**

- `return` prints one line to stdout: `fee: N.NN` (two decimal places, e.g. `fee: 1.50`).
- `overdue` prints one ISBN per line, sorted ascending, no extra lines (empty output if none).
- `fees` prints one line per member with recorded return fees: `member_id: N.NN`, sorted by `member_id` ascending (no output if none).

The `demo` command must exercise add/borrow/overdue on a temporary db and exit 0.

When you are done:

1. Check each of the 7 files compiles: `python3 -m py_compile <file>`. Fix any errors.
2. Run the program end to end: `python3 main.py demo`, and also a scripted sequence with a fresh `--db` path (new file) covering borrow, return, overdue, and fees. Fix failures and rerun until everything works.
3. Finish with a short summary of what you ran and the results.
