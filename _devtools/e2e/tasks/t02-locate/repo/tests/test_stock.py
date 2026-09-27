import unittest

from inventory.stock import add_stock, remove_stock


class StockTests(unittest.TestCase):
    def test_add_and_remove(self):
        levels = {}
        add_stock(levels, "A", 5)
        self.assertEqual(remove_stock(levels, "A", 2), 3)


if __name__ == "__main__":
    unittest.main()
