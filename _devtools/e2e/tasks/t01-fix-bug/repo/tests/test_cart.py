import unittest

from shop.cart import cart_total, line_total


class CartTests(unittest.TestCase):
    def test_line_total(self):
        self.assertEqual(line_total(2.5, 4), 10.0)

    def test_cart_total_uses_quantity(self):
        self.assertEqual(cart_total([(10.0, 2), (5.0, 3)]), 35.0)

    def test_cart_total_with_discount(self):
        self.assertEqual(cart_total([(10.0, 2), (5.0, 3)], discount_pct=10), 31.5)

    def test_empty_cart(self):
        self.assertEqual(cart_total([]), 0)


if __name__ == "__main__":
    unittest.main()
