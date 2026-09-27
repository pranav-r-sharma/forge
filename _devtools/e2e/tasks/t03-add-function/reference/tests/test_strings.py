import unittest

from textutils.strings import count_words, slugify, title_case, truncate


class StringTests(unittest.TestCase):
    def test_title_case(self):
        self.assertEqual(title_case("hello wORLD"), "Hello World")

    def test_truncate(self):
        self.assertEqual(truncate("abcdefghij", 6), "abc...")
        self.assertEqual(truncate("abc", 6), "abc")

    def test_count_words(self):
        self.assertEqual(count_words("a  b   c"), 3)

    def test_slugify_basic(self):
        self.assertEqual(slugify("  Hello, World!  "), "hello-world")

    def test_slugify_runs(self):
        self.assertEqual(slugify("a   b\t\tc"), "a-b-c")

    def test_slugify_edges(self):
        self.assertEqual(slugify("---x---"), "x")


if __name__ == "__main__":
    unittest.main()
