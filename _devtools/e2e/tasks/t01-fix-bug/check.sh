#!/bin/bash
# Run from the workspace root by the runner. Pass = all unit tests pass.
python3 -m unittest discover -s tests -t . -q
