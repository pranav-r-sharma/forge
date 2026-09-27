"""Library domain models."""
from dataclasses import dataclass
from datetime import datetime


def _parse_date(value: str) -> None:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError("date must be YYYY-MM-DD")


@dataclass
class Book:
    isbn: str
    title: str
    author: str

    def __post_init__(self):
        if not self.isbn.strip():
            raise ValueError("isbn is required")
        if not self.title.strip():
            raise ValueError("title is required")
        if not self.author.strip():
            raise ValueError("author is required")


@dataclass
class Member:
    member_id: str
    name: str

    def __post_init__(self):
        if not self.member_id.strip():
            raise ValueError("member_id is required")
        if not self.name.strip():
            raise ValueError("name is required")


@dataclass
class Loan:
    isbn: str
    member_id: str
    borrow_date: str
    due_date: str

    def __post_init__(self):
        if not self.isbn.strip():
            raise ValueError("isbn is required")
        if not self.member_id.strip():
            raise ValueError("member_id is required")
        _parse_date(self.borrow_date)
        _parse_date(self.due_date)

    def to_dict(self):
        return {
            "isbn": self.isbn,
            "member_id": self.member_id,
            "borrow_date": self.borrow_date,
            "due_date": self.due_date,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            isbn=str(data["isbn"]),
            member_id=str(data["member_id"]),
            borrow_date=str(data["borrow_date"]),
            due_date=str(data["due_date"]),
        )
