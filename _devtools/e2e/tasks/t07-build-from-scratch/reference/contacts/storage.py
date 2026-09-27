"""JSON-file contact store."""
import json
import os


class ContactBook:
    def __init__(self, path):
        self.path = path

    def _load(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path) as f:
            return json.load(f)

    def _save(self, contacts):
        with open(self.path, "w") as f:
            json.dump(contacts, f)

    def add(self, name, email):
        contacts = self._load()
        contact_id = max((c["id"] for c in contacts), default=0) + 1
        contacts.append({"id": contact_id, "name": name, "email": email})
        self._save(contacts)
        return contact_id

    def remove(self, contact_id):
        contacts = self._load()
        kept = [c for c in contacts if c["id"] != contact_id]
        if len(kept) == len(contacts):
            return False
        self._save(kept)
        return True

    def find(self, term):
        term = term.lower()
        return [c for c in self._load() if term in c["name"].lower() or term in c["email"].lower()]

    def list(self):
        return self._load()
