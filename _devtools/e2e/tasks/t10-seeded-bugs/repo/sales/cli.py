"""Sales report CLI."""
import argparse
import sys

from sales.aggregte import grand_total, revenue_by_product, top_product
from sales.parser import load_rows
from sales.validate import validate_row


def cmd_report(path: str) -> None:
    rows = load_rows(path)
    for row in rows:
        validate_row(row)
    totals = revenue_by_product(rows)
    for product in sorted(totals, reverse=True):
        print(f"{product}: {totals[product]:.2f}")
    print(f"total: {grand_total(rows):.2f}")


def cmd_top(path: str) -> None:
    rows = load_rows(path)
    for row in rows:
        validate_row(row)
    print(top_product(rows))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Sales CSV tools")
    sub = parser.add_subparsers(dest="command", required=True)
    report_p = sub.add_parser("report")
    report_p.add_argument("csv_path")
    top_p = sub.add_parser("top")
    top_p.add_argument("csv_path")
    args = parser.parse_args(argv)
    if args.command == "report":
        cmd_report(args.csv_path)
    elif args.command == "top":
        cmd_top(args.csv_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
