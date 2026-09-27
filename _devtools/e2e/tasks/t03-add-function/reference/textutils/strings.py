"""Small string helpers."""
import re


def title_case(text):
    """Capitalise the first letter of every word."""
    return " ".join(w[:1].upper() + w[1:].lower() for w in text.split(" "))


def truncate(text, width, suffix="..."):
    """Shorten `text` to at most `width` characters, adding `suffix` when it was cut."""
    if len(text) <= width:
        return text
    return text[: max(0, width - len(suffix))] + suffix


def count_words(text):
    """Number of whitespace-separated words."""
    return len(text.split())


def slugify(text):
    """Lowercase, collapse runs of non-alphanumerics into one hyphen, strip edge hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
