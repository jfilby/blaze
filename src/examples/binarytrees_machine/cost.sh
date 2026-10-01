#!/usr/bin/env bash
# What a built program costs, counted rather than timed.
#
# The wall clock of this benchmark cannot resolve what these changes are worth:
# two runs of one binary on a shared machine differ by about a percent, and the
# changes are smaller than that. The count is exact and does not move with what
# else the machine is doing, so it is what a change is judged on until the code
# is different enough for the clock to see.
#
# Three counts are reported, because one of them cannot see a change the other
# two are the reason to make:
#
#   instructions  every instruction the text carries. What a change is judged on
#                 when it adds or removes instructions outright — a frame emptied
#                 and its `sub`/`add %rsp` pair gone, a spill folded away.
#   memory        every operand naming memory. A register-to-register move and a
#                 load out of the frame are both one instruction, so the
#                 instruction count cannot tell a value kept in a register from
#                 one left in a slot, and this is the count that can: it falls
#                 when a name is given a register and rises when one is taken
#                 away. A RIP-relative load reads a constant the linker put in
#                 .rodata rather than a value the program computed, so it is
#                 not counted.
#   stack         the memory operands that name the stack pointer, which is the
#                 traffic a local variable kept in a frame is. The gap between
#                 this and `memory` is the traffic through a pointer — a field
#                 read, an argument — which a register cannot remove and a change
#                 to the object layout can.
#
# The two functions whose call count the program fixes are counted in full:
# `createTree` and `checksum` are called once per node and once per node plus
# one, so they are where the run spends its instructions.
#
#   ./cost.sh <binary>
set -euo pipefail

readonly BINARY="${1:?usage: cost.sh <binary>}"
cd "$(dirname "$0")"

# `readelf` and not `objdump -h`: the section headers objdump prints are the
# allocatable ones, and a symbol table is not one of those, so a stripped
# binary and an unstripped one list the same sections through it.
# The section list is written out before it is searched rather than piped into
# `grep -q`: a `grep -q` that has found what it was asked for exits at once,
# `readelf` takes SIGPIPE writing the rest, and `pipefail` — which is on above —
# turns that into a failure. The guard then reported a binary with a symbol
# table as having none.
if ! readelf -S "$BINARY" > /tmp/cost-sections.$$ ; then
  rm -f /tmp/cost-sections.$$
  printf 'cost.sh: %s could not be read by readelf.\n' "$BINARY" >&2
  exit 2
fi
if ! grep -q '\.symtab' /tmp/cost-sections.$$ ; then
  rm -f /tmp/cost-sections.$$
  printf 'cost.sh: %s carries no symbol table, so every per-function count below is 0.\n' "$BINARY" >&2
  printf "The binary delivered beside the sources is stripped; the build store's copy is not.\n" >&2
  exit 2
fi
rm -f /tmp/cost-sections.$$
listing=$(objdump -d --no-show-raw-insn "$BINARY")

# One function's instructions: its address, mnemonic and operands. The alignment
# padding a linker leaves between two functions is dropped, because it is where a
# function happened to start rather than anything the body did, and counting it
# would make the total move when an unrelated function's length changed.
body() { printf '%s' "$listing" | sed -n "/<$1>:/,/^\$/p" | grep '^\s*[0-9a-f]*:' | grep -vE ':\s*(data16|cs)?\s*nop'; }
# The operands alone — what follows the mnemonic, which is where a memory
# operand is written.
operands() { body "$1" | sed 's/^[[:space:]]*[0-9a-f]*:[[:space:]]*[a-z0-9.]*[[:space:]]*//' | grep -v '(%rip)'; }

instructions() { body "$1" | wc -l; }
memory() { operands "$1" | grep -o '([^)]*)' | wc -l; }
stack() { operands "$1" | grep -o '(%r[bs]p)' | wc -l; }

# The program as a whole, over the whole listing rather than one function, with
# the same padding dropped.
program() { printf '%s' "$listing" | grep '^\s*[0-9a-f]*:' | grep -vE ':\s*(data16|cs)?\s*nop' \
  | sed 's/^[[:space:]]*[0-9a-f]*:[[:space:]]*[a-z0-9.]*[[:space:]]*//'; }

printf '%-14s %12s %8s %6s\n' "" instructions memory stack
printf '%-14s %12s %8s %6s\n' "text:" \
  "$(printf '%s' "$listing" | grep '^\s*[0-9a-f]*:' | grep -vcE ':\s*(data16|cs)?\s*nop')" \
  "$(program | grep -o '([^)]*)' | wc -l)" "$(program | grep -o '(%r[bs]p)' | wc -l)"
for fn in createTree checksum blaze_main blaze_rt_block; do
  printf '%-14s %12s %8s %6s\n' "$fn:" "$(instructions "$fn")" "$(memory "$fn")" "$(stack "$fn")"
done