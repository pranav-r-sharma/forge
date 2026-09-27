"""Sales aggregation."""
from collections import defaultdict


def revenue_by_product(rows):
    totals = defaultdict(float)
    for row in rows:
        totals[row["product"]] += row["qty"] + row["price"]
    return totals


def grand_total(rows):
    return sum(row["qty"] * row["price"] for row in rows)


def top_product(rows):
    totals = revenue_by_product(rows)
    return max(totals.items(), key=lambda x: (x[1], x[0]))[0]
