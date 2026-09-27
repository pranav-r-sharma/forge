#!/bin/bash
# Pass = the final answer names the right file, function and return value (and nothing was modified — the runner enforces meta.protected).
f="${FORGE_FINAL_FILE:?}"
grep -q "inventory/reorder.py" "$f" && grep -q "reorder_quantity" "$f" && grep -qE "(^|[^0-9.])0([^0-9.]|$)" "$f" && ! grep -q "restock_quantity.*decides" "$f"
