"""Stock level bookkeeping."""


def add_stock(levels, sku, qty):
    levels[sku] = levels.get(sku, 0) + qty
    return levels[sku]


def remove_stock(levels, sku, qty):
    if levels.get(sku, 0) < qty:
        raise ValueError("insufficient stock")
    levels[sku] -= qty
    return levels[sku]
