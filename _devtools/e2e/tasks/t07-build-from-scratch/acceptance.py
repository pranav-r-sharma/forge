import os, subprocess, sys, tempfile
d = tempfile.mkdtemp(); store = os.path.join(d, "c.json")
def run(*a):
    p = subprocess.run([sys.executable, "-m", "contacts.cli", "--store", store, *a], capture_output=True, text=True)
    return p.returncode, p.stdout.strip()
assert run("add", "Alice", "alice@example.com") == (0, "1"), run("add", "Alice", "alice@example.com")
assert run("add", "Bob", "bob@example.com") == (0, "2")
assert run("list") == (0, "1: Alice <alice@example.com>\n2: Bob <bob@example.com>"), run("list")
assert run("find", "bob") == (0, "2: Bob <bob@example.com>"), run("find", "bob")
assert run("find", "example.com") == (0, "1: Alice <alice@example.com>\n2: Bob <bob@example.com>")
assert run("remove", "1") == (0, "removed"), run("remove", "1")
assert run("remove", "1") == (0, "not found")
assert run("remove", "99") == (0, "not found")
assert run("list") == (0, "2: Bob <bob@example.com>")
from contacts.storage import ContactBook
s = ContactBook(os.path.join(d, "t.json"))
s.add("X", "x@x.com")
assert s.remove(1) is True and s.remove(1) is False
assert s.list() == []
print("acceptance ok")
