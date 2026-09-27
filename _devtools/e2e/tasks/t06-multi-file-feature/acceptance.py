import os, subprocess, sys, tempfile
d = tempfile.mkdtemp(); store = os.path.join(d, "s.json")
def run(*a):
    p = subprocess.run([sys.executable, "-m", "notes.cli", "--store", store, *a], capture_output=True, text=True)
    return p.returncode, p.stdout.strip()
assert run("add", "alpha") == (0, "1"); assert run("add", "beta") == (0, "2")
assert run("delete", "1") == (0, "deleted"), run("delete", "1")
assert run("delete", "1") == (0, "not found")
assert run("delete", "99") == (0, "not found")
assert run("list") == (0, "2: beta"), run("list")
from notes.storage import NoteStore
s = NoteStore(os.path.join(d, "t.json")); s.add("x")
assert s.delete(1) is True and s.delete(1) is False and s.list() == []
print("acceptance ok")
