import unittest

from orders.invoice import render_invoice
from orders.pricing import calculate_total
from orders.report import average_order, revenue


class OrderTests(unittest.TestCase):
    def test_calculate_total(self):
        self.assertEqual(calculate_total([(10.0, 2), (5.0, 1)]), 25.0)

    def test_calculate_total_tax(self):
        self.assertEqual(calculate_total([(100.0, 1)], 0.2), 120.0)

    def test_invoice(self):
        self.assertEqual(render_invoice("A1", [(10.0, 2)]), "Invoice A1: total 20.00")

    def test_revenue_and_average(self):
        orders = [[(10.0, 1)], [(30.0, 1)]]
        self.assertEqual(revenue(orders), 40.0)
        self.assertEqual(average_order(orders), 20.0)


if __name__ == "__main__":
    unittest.main()
