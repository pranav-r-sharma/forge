#!/bin/bash
# Pass = no reference to the old name remains anywhere, the new name is used in at least 5 places, and the tests pass.
! grep -rn "calc_tot" --include=*.py . || exit 1
[ "$(grep -rn "calculate_total" --include=*.py . | wc -l)" -ge 5 ] || exit 1
python3 -m unittest discover -s tests -t . -q
