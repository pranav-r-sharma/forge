"""Invoice rendering."""
from .pricing import calculate_total


def render_invoice(order_id, lines, tax_rate=0.0):
    total = calculate_total(lines, tax_rate)
    return f"Invoice {order_id}: total {total:.2f}"
