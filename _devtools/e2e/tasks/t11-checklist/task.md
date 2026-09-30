Build a tiny Python package in this empty repo. Follow every item — the harness tracks each one.

1. Create `app/hello.py` that prints exactly `checklist-ok` when run as `python3 app/hello.py`.
2. Create `app/utils.py` with a function `add(a: int, b: int) -> int`.
3. Create `app/__init__.py` (may be empty).
4. Create `tests/test_utils.py` with one test that asserts `add(2, 3) == 5`.
5. Do not use any third-party packages — standard library only.
6. Run `python3 -m py_compile app/hello.py` and `python3 -m py_compile app/utils.py` — both must succeed.
7. Run `python3 app/hello.py` and confirm stdout is exactly `checklist-ok`.
8. Run `python3 -m unittest discover -s tests -p 'test_*.py'` — all tests must pass.

When finished, give a one-paragraph summary listing each command you ran and its result.
