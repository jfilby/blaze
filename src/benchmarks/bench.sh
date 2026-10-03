#!/bin/sh
# Measures a benchmark project with the offline build: rebuild, check what it
# prints, and time it. Nothing here asks a model, so the number is the number
# the rule-based half of the compiler produced.
#
#   sh bench.sh <project directory> <n> [repeats]
#
# The value printed is compared against the value the same project printed
# before the change, which is what a rewrite that is not value-preserving does
# first and most visibly.

set -eu

project=$1
n=$2
repeats=${3:-7}

here=$(dirname "$0")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

node "$here/../compiler/offline-build.ts" "$project" "$work"

answer=$("$work/program" "$n")
echo "answer: $answer"
hyperfine --warmup 2 -r "$repeats" -N "$work/program $n"
