This repository contains a **broken** Python 3 CSV sales reporting tool. The intended behavior:

- Read `data/sales.csv` (header `date,product,qty,price`). Skip blank lines in the data.
- Validate each row (`YYYY-MM-DD` date, positive `qty`, non-negative `price`).
- `report` prints revenue per product (qty × price), one line per product sorted **ascending by product name**, then a `total:` line.
- `top` prints the product with the highest revenue (alphabetical tie-break).

**Do not edit** `data/sales.csv`.

Expected output for the bundled data file:

```text
$ python3 main.py report data/sales.csv
apple: 4.50
banana: 2.25
cherry: 4.00
total: 10.75

$ python3 main.py top data/sales.csv
apple
```

Find and fix **all** bugs in the Python sources. When you are done:

1. `python3 -m py_compile` every `.py` file under this repo.
2. Run both commands above end to end; output must match exactly.
3. Summarize each bug you fixed (file and what was wrong).
