import unittest

from pricing.rules import price_with_tax, rule_000, rule_139


class RuleTests(unittest.TestCase):
    def test_price_with_tax(self):
        self.assertEqual(price_with_tax(100.0), 108.0)

    def test_price_with_tax_rounding(self):
        self.assertEqual(price_with_tax(9.99), 10.79)

    def test_other_rules_unaffected(self):
        self.assertIsInstance(rule_000(10.0), float)
        self.assertIsInstance(rule_139(10.0, 12), float)


if __name__ == "__main__":
    unittest.main()
