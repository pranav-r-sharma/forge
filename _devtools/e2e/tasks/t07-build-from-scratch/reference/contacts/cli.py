"""Command-line interface: `python -m contacts.cli --store FILE add NAME EMAIL | remove ID | find TERM | list`."""
import argparse
import sys

from .storage import ContactBook


def build_parser():
    p = argparse.ArgumentParser(prog="contacts")
    p.add_argument("--store", required=True, help="path of the JSON file")
    sub = p.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", help="add a contact")
    add.add_argument("name")
    add.add_argument("email")
    remove = sub.add_parser("remove", help="remove a contact by id")
    remove.add_argument("id", type=int)
    find = sub.add_parser("find", help="find contacts by substring")
    find.add_argument("term")
    sub.add_parser("list", help="list contacts")
    return p


def _format(c):
    return f"{c['id']}: {c['name']} <{c['email']}>"


def main(argv=None):
    args = build_parser().parse_args(argv)
    book = ContactBook(args.store)
    if args.command == "add":
        print(book.add(args.name, args.email))
    elif args.command == "remove":
        print("removed" if book.remove(args.id) else "not found")
    elif args.command == "find":
        for c in book.find(args.term):
            print(_format(c))
    elif args.command == "list":
        for c in book.list():
            print(_format(c))
    return 0


if __name__ == "__main__":
    sys.exit(main())
