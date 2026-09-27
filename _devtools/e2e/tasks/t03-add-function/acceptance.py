from textutils.strings import slugify
cases = {"  Hello, World!  ": "hello-world", "Already-slugged": "already-slugged", "a   b\t\tc": "a-b-c", "---x---": "x", "": "", "!!!": ""}
bad = {k: (slugify(k), v) for k, v in cases.items() if slugify(k) != v}
assert not bad, f"slugify wrong: {bad}"
print("acceptance ok")
