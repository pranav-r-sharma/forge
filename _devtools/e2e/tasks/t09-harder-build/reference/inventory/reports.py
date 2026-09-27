"""Library reports."""
from collections import Counter


def overdue_loans(loans, as_of: str):
    from inventory.rules import parse_date

    as_of_dt = parse_date(as_of)
    result = []
    for loan in loans:
        if parse_date(loan.due_date) < as_of_dt:
            result.append(loan.isbn)
    return sorted(result)


def member_fee_totals(return_fees):
    totals = {}
    for item in return_fees:
        mid = item["member_id"]
        totals[mid] = totals.get(mid, 0.0) + float(item["fee"])
    return totals


def most_borrowed(borrow_history, limit: int = 5):
    counts = Counter(borrow_history)
    ranked = sorted(counts.items(), key=lambda x: (-x[1], x[0]))
    return ranked[:limit]
