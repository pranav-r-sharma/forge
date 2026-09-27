import unittest

from textutils.strings import count_words, title_case, truncate


class StringTests(unittest.TestCase):
    def test_title_case(self):
        self.assertEqual(title_case("hello wORLD"), "Hello World")

    def test_truncate(self):
        self.assertEqual(truncate("abcdefghij", 6), "abc...")
        self.assertEqual(truncate("abc", 6), "abc")

    def test_count_words(self):
        self.assertEqual(count_words("a  b   c"), 3)


if __name__ == "__main__":
    unittest.main()
