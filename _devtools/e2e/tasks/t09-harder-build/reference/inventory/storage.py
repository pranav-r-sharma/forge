"""JSON persistence for books, members, loans, and return fee history."""
import json
import os

from inventory.models import Book, Loan, Member


def _empty_db():
    return {"books": [], "members": [], "loans": [], "return_fees": [], "borrow_history": []}


def load_db(path: str) -> dict:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return _empty_db()
    with open(path) as f:
        raw = json.load(f)
    return {
        "books": [Book(**b) for b in raw.get("books", [])],
        "members": [Member(**m) for m in raw.get("members", [])],
        "loans": [Loan.from_dict(item) for item in raw.get("loans", [])],
        "return_fees": [
            {"member_id": str(item["member_id"]), "fee": float(item["fee"])}
            for item in raw.get("return_fees", [])
        ],
        "borrow_history": [str(x) for x in raw.get("borrow_history", [])],
    }


def save_db(path: str, db: dict) -> None:
    payload = {
        "books": [
            {"isbn": b.isbn, "title": b.title, "author": b.author} for b in db["books"]
        ],
        "members": [
            {"member_id": m.member_id, "name": m.name} for m in db["members"]
        ],
        "loans": [loan.to_dict() for loan in db["loans"]],
        "return_fees": db.get("return_fees", []),
        "borrow_history": db.get("borrow_history", []),
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
