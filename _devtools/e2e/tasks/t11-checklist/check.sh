#!/bin/bash
set -e
test -f app/hello.py
test -f app/utils.py
test -f tests/test_utils.py
python3 -m py_compile app/hello.py
python3 -m py_compile app/utils.py
out=$(python3 app/hello.py)
test "$out" = "checklist-ok"
python3 -m unittest discover -s tests -p 'test_*.py'
