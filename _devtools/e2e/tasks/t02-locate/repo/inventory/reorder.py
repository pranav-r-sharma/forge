"""Reorder policy: decide how much to order when stock runs low."""

REORDER_THRESHOLD = 20
TARGET_LEVEL = 100


def reorder_quantity(current_stock):
    """Units to order for a SKU with `current_stock` on hand.

    Returns 0 when stock is above the threshold, otherwise enough to reach the target level.
    """
    if current_stock > REORDER_THRESHOLD:
        return 0
    return TARGET_LEVEL - current_stock
