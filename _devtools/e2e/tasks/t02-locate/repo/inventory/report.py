"""Plain-text stock report."""


def format_report(levels):
    lines = [f"{sku}: {qty}" for sku, qty in sorted(levels.items())]
    return "\n".join(lines)
