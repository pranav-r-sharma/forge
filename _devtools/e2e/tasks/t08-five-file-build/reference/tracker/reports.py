"""Expense totals."""
from collections import defaultdict


def category_totals(expenses):
    totals = defaultdict(float)
    for e in expenses:
        totals[e.category] += e.amount
    return dict(totals)


def overall_total(expenses):
    return sum(e.amount for e in expenses)
