"""Expense model."""
from dataclasses import dataclass
from datetime import datetime


@dataclass
class Expense:
    amount: float
    category: str
    note: str
    date: str

    def __post_init__(self):
        if self.amount <= 0:
            raise ValueError("amount must be > 0")
        try:
            datetime.strptime(self.date, "%Y-%m-%d")
        except ValueError:
            raise ValueError("date must be YYYY-MM-DD")

    def to_dict(self):
        return {
            "amount": self.amount,
            "category": self.category,
            "note": self.note,
            "date": self.date,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            amount=float(data["amount"]),
            category=str(data["category"]),
            note=str(data["note"]),
            date=str(data["date"]),
        )
