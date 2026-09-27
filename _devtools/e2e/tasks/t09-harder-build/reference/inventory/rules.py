"""Business rules for library loans."""
from datetime import datetime

BORROW_LIMIT = 3
LOAN_DAYS = 14
FEE_PER_DAY = 0.25
MAX_FEE = 10.0


def parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


def due_date_for(borrow_date: str) -> str:
    start = parse_date(borrow_date)
    due = start.toordinal() + LOAN_DAYS
    return datetime.fromordinal(due).strftime("%Y-%m-%d")


def active_loans_for_member(loans, member_id: str):
    return [loan for loan in loans if loan.member_id == member_id]


def is_on_loan(loans, isbn: str) -> bool:
    return any(loan.isbn == isbn for loan in loans)


def late_fee(due_date: str, return_date: str) -> float:
    due = parse_date(due_date)
    returned = parse_date(return_date)
    if returned <= due:
        return 0.0
    days_late = (returned - due).days
    fee = days_late * FEE_PER_DAY
    return min(fee, MAX_FEE)
