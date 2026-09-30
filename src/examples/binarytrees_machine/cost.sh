#!/usr/bin/env bash
# What a built program costs, counted rather than timed.
#
# The wall clock of this benchmark cannot resolve what these changes are worth:
# two runs of one binary on a shared machine differ by about a percent, and the
# changes are smaller than that. The count is exact and does not move with what
# else the machine is doing, so it is what a change is judged on until the code
# is different enough for the clock to see.
#
# What is counted is every instruction the program's own text carries, plus the
# dynamic count for the two functions whose call count the program fixes:
# `createTree` and `checksum` are called once per node and once per node plus
# one, so their instruction counts are what the run spends most of its time in.
#
#   ./cost.sh <binary>
set -euo pipefail

readonly BINARY="${1:?usage: cost.sh <binary>}"
cd "$(dirname "$0")"

listing=$(objdump -d --no-show-raw-insn "$BINARY")
count() { printf '%s' "$listing" | sed -n "/<$1>:/,/^\$/p" | grep -c '^\s*[0-9a-f]*:' || true; }

printf '%-22s %s\n' "text instructions:" "$(printf '%s' "$listing" | grep -c '^\s*[0-9a-f]*:')"
for fn in createTree checksum blaze_main blaze_rt_block; do
  printf '%-22s %s\n' "$fn:" "$(count "$fn")"
done
