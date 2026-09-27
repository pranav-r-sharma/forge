"""Tiny command-line entry point."""
import sys

from .pricing import calculate_total


def main(argv):
    prices = [float(x) for x in argv]
    print(calculate_total([(p, 1) for p in prices]))


if __name__ == "__main__":
    main(sys.argv[1:])
