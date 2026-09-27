"""Order pricing."""


def calc_tot(lines, tax_rate=0.0):
    """Total for order lines of (unit_price, quantity), including tax."""
    subtotal = sum(price * qty for price, qty in lines)
    return round(subtotal * (1 + tax_rate), 2)
