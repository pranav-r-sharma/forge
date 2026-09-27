"""Warehouse restock batches (a different concept from reordering from suppliers)."""

BATCH_SIZE = 25


def restock_quantity(current_stock, pending):
    """Round the shortfall up to whole batches, counting units already pending delivery."""
    shortfall = max(0, 60 - current_stock - pending)
    batches = -(-shortfall // BATCH_SIZE)
    return batches * BATCH_SIZE
