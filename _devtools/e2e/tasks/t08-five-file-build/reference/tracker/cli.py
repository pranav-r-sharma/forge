"""Expense tracker CLI."""
import argparse
import os
import sys
import tempfile

from tracker.models import Expense
from tracker.reports import category_totals, overall_total
from tracker.storage import load_expenses, save_expenses


def _print_summary(expenses):
    for cat, total in sorted(category_totals(expenses).items()):
        print(f"{cat}: {total:.2f}")
    print(f"Total: {overall_total(expenses):.2f}")


def cmd_add(args):
    expenses = load_expenses(args.db)
    expenses.append(
        Expense(
            amount=args.amount,
            category=args.category,
            note=args.note,
            date=args.date,
        )
    )
    save_expenses(args.db, expenses)


def cmd_list(args):
    for e in load_expenses(args.db):
        print(f"{e.date}  {e.category:12}  {e.amount:8.2f}  {e.note}")


def cmd_summary(args):
    _print_summary(load_expenses(args.db))


def cmd_demo(args):
    fd, path = tempfile.mkstemp(suffix=".json", prefix="expense-demo-")
    os.close(fd)
    try:
        demo_args = argparse.Namespace(
            db=path,
            amount=0,
            category="",
            note="",
            date="",
        )
        for amount, category, note, date in [
            (24.99, "food", "lunch", "2026-03-01"),
            (8.50, "transport", "bus", "2026-03-02"),
            (42.00, "food", "groceries", "2026-03-03"),
        ]:
            demo_args.amount = amount
            demo_args.category = category
            demo_args.note = note
            demo_args.date = date
            cmd_add(demo_args)
        cmd_list(demo_args)
        cmd_summary(demo_args)
    finally:
        os.remove(path)


def _add_db_arg(parser):
    parser.add_argument("--db", default="expenses.json", help="JSON database path")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Expense tracker")
    sub = parser.add_subparsers(dest="command", required=True)

    add_p = sub.add_parser("add", help="Add an expense")
    _add_db_arg(add_p)
    add_p.add_argument("--amount", type=float, required=True)
    add_p.add_argument("--category", required=True)
    add_p.add_argument("--note", default="")
    add_p.add_argument("--date", required=True)

    list_p = sub.add_parser("list", help="List expenses")
    _add_db_arg(list_p)

    summary_p = sub.add_parser("summary", help="Print totals by category")
    _add_db_arg(summary_p)

    sub.add_parser("demo", help="Run a sample session")

    args = parser.parse_args(argv)
    handlers = {
        "add": cmd_add,
        "list": cmd_list,
        "summary": cmd_summary,
        "demo": cmd_demo,
    }
    handlers[args.command](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
