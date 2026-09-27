import os
import tempfile
import unittest

from contacts.storage import ContactBook


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.book = ContactBook(os.path.join(self.dir, "c.json"))

    def test_add_and_list(self):
        a = self.book.add("Alice", "alice@example.com")
        b = self.book.add("Bob", "bob@example.com")
        self.assertEqual((a, b), (1, 2))
        self.assertEqual([c["name"] for c in self.book.list()], ["Alice", "Bob"])

    def test_remove(self):
        self.book.add("Alice", "alice@example.com")
        self.assertTrue(self.book.remove(1))
        self.assertFalse(self.book.remove(1))
        self.assertEqual(self.book.list(), [])

    def test_find(self):
        self.book.add("Alice", "alice@example.com")
        self.book.add("Bob", "bob@example.com")
        self.assertEqual([c["name"] for c in self.book.find("bob")], ["Bob"])
        self.assertEqual(len(self.book.find("example.com")), 2)


if __name__ == "__main__":
    unittest.main()
