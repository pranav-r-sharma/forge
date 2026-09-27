"""Discount helpers."""


def apply_discount(amount, pct):
    """Reduce `amount` by `pct` percent (0-100). Result is rounded to 2 decimals."""
    if pct < 0 or pct > 100:
        raise ValueError("pct must be between 0 and 100")
    return round(amount * (1 - pct / 100), 2)
