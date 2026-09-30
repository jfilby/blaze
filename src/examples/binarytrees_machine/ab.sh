#!/usr/bin/env bash
# Compare two built programs on the same machine, interleaved.
#
# The machine this runs on is shared, so one timing tells nothing: the number
# that survives is the fastest of many, and the runs of the two programs have to
# be interleaved so that whatever the machine was doing affects both. The
# programs are alternated run by run rather than measured a block at a time.
#
# binarytrees never releases a tree, so a run at depth 16 holds about 1.2 GB.
# One of these runs at a time.
#
#   ./ab.sh <baseline-binary> <candidate-binary> [depth] [repeats]
set -euo pipefail

readonly A="${1:?usage: ab.sh <baseline> <candidate> [depth] [repeats]}"
readonly B="${2:?usage: ab.sh <baseline> <candidate> [depth] [repeats]}"
readonly DEPTH="${3:-16}"
readonly REPEATS="${4:-12}"


a_best=""
b_best=""
for (( round = 0; round < REPEATS; round += 1 )); do
  start=$(date +%s%N); "$A" "$DEPTH" >/dev/null; end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  if [[ -z "$a_best" ]] || (( ms < a_best )); then a_best=$ms; fi
  start=$(date +%s%N); "$B" "$DEPTH" >/dev/null; end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  if [[ -z "$b_best" ]] || (( ms < b_best )); then b_best=$ms; fi
done
printf 'baseline %s: %s ms\n' "$(basename "$A")" "$a_best"
printf 'candidate %s: %s ms\n' "$(basename "$B")" "$b_best"
printf 'difference: %s ms (%s%%)\n' "$(( b_best - a_best ))" "$(awk -v a="$a_best" -v b="$b_best" 'BEGIN { printf "%.1f", (b - a) * 100 / a }')"
