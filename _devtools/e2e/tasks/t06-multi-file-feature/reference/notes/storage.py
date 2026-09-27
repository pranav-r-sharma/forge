"""JSON-file note store."""
import json
import os


class NoteStore:
    def __init__(self, path):
        self.path = path

    def _load(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path) as f:
            return json.load(f)

    def _save(self, notes):
        with open(self.path, "w") as f:
            json.dump(notes, f)

    def add(self, text):
        notes = self._load()
        note_id = max((n["id"] for n in notes), default=0) + 1
        notes.append({"id": note_id, "text": text})
        self._save(notes)
        return note_id

    def list(self):
        return self._load()

    def delete(self, note_id):
        notes = self._load()
        kept = [n for n in notes if n["id"] != note_id]
        if len(kept) == len(notes):
            return False
        self._save(kept)
        return True
