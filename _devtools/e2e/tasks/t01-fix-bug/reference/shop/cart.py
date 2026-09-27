"""A tiny shopping cart."""
from .discounts import apply_discount


def line_total(price, quantity):
    """Price of one line: unit price times quantity."""
    return price * quantity


def cart_total(items, discount_pct=0):
    """Total for a list of (price, quantity) pairs, after an optional percentage discount."""
    subtotal = 0
    for price, quantity in items:
        subtotal += line_total(price, quantity)
    return apply_discount(subtotal, discount_pct)
