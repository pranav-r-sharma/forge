"""Row validation."""
from datetime import datetime


def validate_row(row)
    datetime.strptime(row["date"], "%Y-%m-%d")
    if row["qty"] <= 0:
        raise ValueError("qty must be positive")
    if row["price"] < 0:
        raise ValueError("price must be non-negative")
