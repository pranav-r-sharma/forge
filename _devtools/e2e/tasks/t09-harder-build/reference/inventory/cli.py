"""Library loan CLI."""
import argparse
import os
import sys
import tempfile

from inventory.models import Book, Member
from inventory.reports import member_fee_totals, most_borrowed, overdue_loans
from inventory.services import LibraryError, borrow, return_book
from inventory.storage import load_db, save_db


def _fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _add_db(parser):
    parser.add_argument("--db", required=True, help="JSON database path")


def cmd_add_book(args):
    db = load_db(args.db)
    try:
        db["books"].append(Book(isbn=args.isbn, title=args.title, author=args.author))
    except ValueError as e:
        _fail(str(e))
    save_db(args.db, db)


def cmd_add_member(args):
    db = load_db(args.db)
    try:
        db["members"].append(Member(member_id=args.member_id, name=args.name))
    except ValueError as e:
        _fail(str(e))
    save_db(args.db, db)


def cmd_borrow(args):
    db = load_db(args.db)
    try:
        borrow(db, args.member_id, args.isbn, args.date)
    except LibraryError as e:
        _fail(str(e))
    save_db(args.db, db)


def cmd_return(args):
    db = load_db(args.db)
    try:
        fee = return_book(db, args.isbn, args.date)
    except LibraryError as e:
        _fail(str(e))
    save_db(args.db, db)
    print(f"fee: {fee:.2f}")


def cmd_overdue(args):
    db = load_db(args.db)
    for isbn in overdue_loans(db["loans"], args.date):
        print(isbn)


def cmd_fees(args):
    db = load_db(args.db)
    totals = member_fee_totals(db.get("return_fees", []))
    for member_id in sorted(totals):
        print(f"{member_id}: {totals[member_id]:.2f}")


def cmd_demo(args):
    fd, path = tempfile.mkstemp(suffix=".json", prefix="library-demo-")
    os.close(fd)
    try:
        demo = argparse.Namespace(
            db=path,
            isbn="",
            title="",
            author="",
            member_id="",
            name="",
            date="2026-01-01",
        )
        demo.isbn = "978-1"
        demo.title = "Demo Book"
        demo.author = "Author"
        cmd_add_book(demo)
        demo.member_id = "m1"
        demo.name = "Alice"
        cmd_add_member(demo)
        demo.member_id = "m1"
        demo.isbn = "978-1"
        demo.date = "2026-01-01"
        cmd_borrow(demo)
        cmd_overdue(argparse.Namespace(db=path, date="2026-01-20"))
    finally:
        os.remove(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Library loan system")
    sub = parser.add_subparsers(dest="command", required=True)

    add_book = sub.add_parser("add-book")
    _add_db(add_book)
    add_book.add_argument("--isbn", required=True)
    add_book.add_argument("--title", required=True)
    add_book.add_argument("--author", required=True)

    add_member = sub.add_parser("add-member")
    _add_db(add_member)
    add_member.add_argument("--member-id", required=True)
    add_member.add_argument("--name", required=True)

    borrow_p = sub.add_parser("borrow")
    _add_db(borrow_p)
    borrow_p.add_argument("--member-id", required=True)
    borrow_p.add_argument("--isbn", required=True)
    borrow_p.add_argument("--date", required=True)

    return_p = sub.add_parser("return")
    _add_db(return_p)
    return_p.add_argument("--isbn", required=True)
    return_p.add_argument("--date", required=True)

    overdue_p = sub.add_parser("overdue")
    _add_db(overdue_p)
    overdue_p.add_argument("--date", required=True)

    fees_p = sub.add_parser("fees")
    _add_db(fees_p)

    sub.add_parser("demo")

    args = parser.parse_args(argv)
    handlers = {
        "add-book": cmd_add_book,
        "add-member": cmd_add_member,
        "borrow": cmd_borrow,
        "return": cmd_return,
        "overdue": cmd_overdue,
        "fees": cmd_fees,
        "demo": cmd_demo,
    }
    handlers[args.command](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
