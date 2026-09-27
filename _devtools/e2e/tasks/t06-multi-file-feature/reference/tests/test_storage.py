import os
import tempfile
import unittest

from notes.storage import NoteStore


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = NoteStore(os.path.join(self.dir, "n.json"))

    def test_add_and_list(self):
        a = self.store.add("first")
        b = self.store.add("second")
        self.assertEqual((a, b), (1, 2))
        self.assertEqual([n["text"] for n in self.store.list()], ["first", "second"])

    def test_delete(self):
        i = self.store.add("x")
        self.assertTrue(self.store.delete(i))
        self.assertFalse(self.store.delete(i))
        self.assertEqual(self.store.list(), [])


if __name__ == "__main__":
    unittest.main()
