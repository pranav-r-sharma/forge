"""Sales reporting."""
from . import pricing


def revenue(orders):
    """Sum of totals over a list of order line-lists."""
    return round(sum(pricing.calculate_total(lines) for lines in orders), 2)


def average_order(orders):
    if not orders:
        return 0.0
    return round(revenue(orders) / len(orders), 2)
