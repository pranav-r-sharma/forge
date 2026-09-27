"""Tiny command-line entry point."""
import sys

from .pricing import calc_tot


def main(argv):
    prices = [float(x) for x in argv]
    print(calc_tot([(p, 1) for p in prices]))


if __name__ == "__main__":
    main(sys.argv[1:])
