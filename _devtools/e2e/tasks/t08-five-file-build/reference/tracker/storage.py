"""JSON persistence for expenses."""
import json
import os

from tracker.models import Expense


def load_expenses(path):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return []
    with open(path) as f:
        raw = json.load(f)
    return [Expense.from_dict(item) for item in raw]


def save_expenses(path, expenses):
    with open(path, "w") as f:
        json.dump([e.to_dict() for e in expenses], f, indent=2)
