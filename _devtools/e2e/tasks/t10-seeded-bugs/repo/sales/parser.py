"""Parse sales CSV rows."""
import csv
from io import StringIO


def load_rows(path: str):
    with open(path, newline="") as f:
        text = f.read()
    reader = csv.DictReader(StringIO(text))
    rows = []
    for row in reader:
        rows.append(
            {
                "date": row["date"].strip(),
                "product": row["product"].strip(),
                "qty": int(row["qty"]),
                "price": float(row["price"]),
            }
        )
    return rows
