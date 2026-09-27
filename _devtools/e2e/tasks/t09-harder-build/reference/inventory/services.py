"""Loan operations."""
from inventory.models import Loan
from inventory.rules import (
    BORROW_LIMIT,
    active_loans_for_member,
    due_date_for,
    is_on_loan,
    late_fee,
)


class LibraryError(Exception):
    pass


def borrow(db, member_id: str, isbn: str, date: str) -> None:
    members = {m.member_id for m in db["members"]}
    books = {b.isbn for b in db["books"]}
    if member_id not in members:
        raise LibraryError(f"unknown member: {member_id}")
    if isbn not in books:
        raise LibraryError(f"unknown book: {isbn}")
    if is_on_loan(db["loans"], isbn):
        raise LibraryError(f"book already on loan: {isbn}")
    if len(active_loans_for_member(db["loans"], member_id)) >= BORROW_LIMIT:
        raise LibraryError(f"borrow limit reached for member: {member_id}")
    db["loans"].append(
        Loan(
            isbn=isbn,
            member_id=member_id,
            borrow_date=date,
            due_date=due_date_for(date),
        )
    )
    db.setdefault("borrow_history", []).append(isbn)


def return_book(db, isbn: str, date: str) -> float:
    for i, loan in enumerate(db["loans"]):
        if loan.isbn == isbn:
            fee = late_fee(loan.due_date, date)
            db.setdefault("return_fees", []).append(
                {"member_id": loan.member_id, "fee": fee}
            )
            del db["loans"][i]
            return fee
    raise LibraryError(f"no active loan for isbn: {isbn}")
