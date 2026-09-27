# t10-seeded-bugs — planted defects (harness only; not visible to the model)

| # | File | Kind | Line |
|---|------|------|------|
| 1 | `sales/validate.py` | SyntaxError (missing `:` on function def) | 5 |
| 2 | `sales/cli.py` | ImportError (typo `sales.aggregte`) | 5 |
| 3 | `sales/parser.py` | Runtime crash on blank CSV row (`ValueError` from `int('')`) | 11 |
| 4 | `sales/aggregate.py` | Wrong operator (`qty + price` instead of `qty * price`) | 8 |
| 5 | `sales/cli.py` | Wrong sort order (`reverse=True` on product lines) | 14 |
