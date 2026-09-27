"""Command-line interface: `python -m notes.cli --store FILE add TEXT | list`."""
import argparse
import sys

from .storage import NoteStore


def build_parser():
    p = argparse.ArgumentParser(prog="notes")
    p.add_argument("--store", required=True, help="path of the JSON file")
    sub = p.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", help="add a note")
    add.add_argument("text")
    sub.add_parser("list", help="list notes")
    rm = sub.add_parser("delete", help="delete a note")
    rm.add_argument("note_id", type=int)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    store = NoteStore(args.store)
    if args.command == "add":
        print(store.add(args.text))
    elif args.command == "delete":
        print("deleted" if store.delete(args.note_id) else "not found")
    elif args.command == "list":
        for n in store.list():
            print(f"{n['id']}: {n['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
