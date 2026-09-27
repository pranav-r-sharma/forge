Build a small contacts-book command-line tool from scratch in this empty repository.

Create a Python package `contacts/` with `contacts/__init__.py` (can be empty) and `contacts/storage.py` defining a class `ContactBook` whose constructor takes one argument, `ContactBook(path)`, and persists contacts as JSON at that path:
- `add(name, email)` adds a new contact with a unique integer `id` (starting at 1, incrementing) and returns the id.
- `remove(contact_id)` deletes the contact with that id and returns True, or returns False if no such id exists.
- `find(term)` returns a list of contacts (each a dict with keys `id`, `name`, `email`) whose name or email contains `term` as a case-insensitive substring, in the order they were added.
- `list()` returns all contacts (same dict shape) in the order they were added.

Also create `contacts/cli.py` with a command-line interface invoked as `python -m contacts.cli --store FILE <command> [args]`:
- `add NAME EMAIL` adds a contact and prints its id.
- `remove ID` removes the contact with that integer id; prints `removed` on success or `not found` otherwise; exit code 0 either way.
- `find TERM` prints one line per matching contact as `ID: NAME <EMAIL>`, in the order returned by `find`.
- `list` prints one line per contact as `ID: NAME <EMAIL>`, in the order returned by `list`.

Also create `tests/` with `tests/__init__.py` (can be empty) and `tests/test_storage.py` containing unit tests for `ContactBook` that cover `add`, `list`, `remove`, and `find`.

Run the tests when you are done.
