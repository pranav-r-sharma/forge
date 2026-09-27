"""Invoice rendering."""
from .pricing import calc_tot


def render_invoice(order_id, lines, tax_rate=0.0):
    total = calc_tot(lines, tax_rate)
    return f"Invoice {order_id}: total {total:.2f}"
