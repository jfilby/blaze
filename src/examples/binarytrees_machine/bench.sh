#!/usr/bin/env bash
# The best of N runs of a delivered binary, in milliseconds.
#
# binarytrees builds every tree it makes and never releases one, so its
# footprint doubles with every step of depth: 500 MB at 15, 1.2 GB at 16,
# 2.3 GB at 17 and 4.6 GB at 18. The deeper runs are what the measurement is
# made at, and a box with a few gigabytes of memory left will be driven into
# swap by one of them. The cap below is the deepest that is safe on an
# ordinary workstation; pass a higher depth only when the memory for it is
# really there, and never two of these at once.
set -euo pipefail
readonly SAFE_DEPTH=16
readonly REPEATS="${REPEATS:-5}"

depth="${1:?usage: bench.sh <depth> <binary>}"
binary="${2:?usage: bench.sh <depth> <binary>}"

if (( depth > SAFE_DEPTH )) && [[ "${ALLOW_DEEP:-}" != "1" ]]; then
  printf 'refusing depth %s: binarytrees never releases a tree, so this needs about %s GB.\n' \
    "$depth" "$(awk -v d="$depth" 'BEGIN { printf "%.1f", 0.25 * (2 ^ (d - 15)) }')" >&2
  printf 'Run it with ALLOW_DEEP=1 when the memory for it is really there.\n' >&2
  exit 2
fi

best=""
for (( run = 0; run < REPEATS; run += 1 )); do
  start=$(date +%s%N)
  "$binary" "$depth" >/dev/null
  end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  printf '  %s ms\n' "$ms"
  if [[ -z "$best" ]] || (( ms < best )); then best=$ms; fi
done
printf '%s depth %s: %s ms (best of %s)\n' "$(basename "$binary")" "$depth" "$best" "$REPEATS"
