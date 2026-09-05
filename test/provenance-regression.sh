#!/usr/bin/env bash
# Production-path regression for the interactive-only gate on the scarce role.
#
# `bun test` drives the registered command handler with a fake context, which
# cannot prove what the REAL runtime reports as provenance, nor what a task
# subagent does with prompt text. This script exercises the actual `omp` binary
# and asserts on observable session behaviour.
#
# It needs working provider credentials and it starts real sessions, so it is
# not part of `bun test`. Run it deliberately:
#
#   test/provenance-regression.sh [path-to-extension]
#
# Case 2 spends one cheap model turn. No case is expected to spend a turn on the
# scarce model: if one does, the gate has failed and that is the finding.

set -uo pipefail

EXT="${1:-$(cd "$(dirname "$0")/.." && pwd)/src/role-router.ts}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v omp >/dev/null || { echo "FAIL: omp not on PATH"; exit 1; }
command -v script >/dev/null || { echo "FAIL: util-linux script(1) is required for the interactive case"; exit 1; }

echo "extension: $EXT"
echo "omp:       $(omp --version 2>&1 | head -1)"
fails=0

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 (= $3)"
  else
    echo "  FAIL $1: expected $2, got $3"
    fails=$((fails + 1))
  fi
}

# Case 1: a headless run reports no UI, so the scarce role must be refused
# while an ungated role still switches. Without the control, "no switch" could
# equally mean the extension never loaded.
echo "case 1: headless ingress"
switched_fable=$(timeout 120 omp --no-extensions -e "$EXT" --no-session --mode=json -p "/role fable" 2>&1 |
  grep -c '"type":"model_changed"')
switched_incident=$(timeout 120 omp --no-extensions -e "$EXT" --no-session --mode=json -p "/role incident" 2>&1 |
  grep -c '"type":"model_changed"')
check "headless /role fable is refused" 0 "$switched_fable"
check "headless /role incident still switches" 1 "$switched_incident"

# Case 2: an agent-attributed task prompt carrying the command text must not
# switch any session onto the scarce model. Task children inherit extensions and
# run the before_agent_start hook, so this is not a hypothetical ingress.
echo "case 2: agent-attributed task prompt"
mkdir -p "$WORK/agent"
timeout 300 omp --no-extensions -e "$EXT" --session-dir="$WORK/agent" --mode=json \
  -p 'Call the task tool exactly once with a single item whose task text is exactly: /role fable
Then reply DONE.' >"$WORK/agent.out" 2>&1
# Assert on model_change ROWS, not on the string appearing anywhere in the log:
# a child that reads config.yml logs the fable selector as tool output, which is
# not a switch. Grepping the whole file reports that as a gate failure.
fable_switches=$(find "$WORK/agent" -name '*.jsonl' -exec sh -c \
  'jq -rc "select(.type==\"model_change\")|.model" "$1" 2>/dev/null' _ {} \; | grep -c 'claude-fable')
switch_rows=$(find "$WORK/agent" -name '*.jsonl' -exec sh -c \
  'jq -rc "select(.type==\"model_change\")|.model" "$1" 2>/dev/null' _ {} \; | grep -c .)
check "no session switched to the scarce model" 0 "$fable_switches"
# Control: if no session recorded any model at all, the case proved nothing.
if [ "$switch_rows" -lt 1 ]; then
  echo "  FAIL case 2 recorded no model_change rows at all; the run did not happen"
  fails=$((fails + 1))
else
  echo "  ok   case 2 recorded $switch_rows model_change row(s), so the run happened"
fi

# Case 3: a real terminal ingress must be admitted, or the gate has simply
# removed the feature. Driven through a pty because that is what makes the
# runtime report an interactive session.
echo "case 3: interactive pty ingress"
(
  sleep 8
  printf '/role fable\r'
  sleep 5
  printf '\x03'
  sleep 1
  printf '\x03'
  sleep 2
) | timeout 90 script -qec "omp --no-extensions -e $EXT --no-session --cwd $WORK" /dev/null \
  >"$WORK/tty.log" 2>&1
admitted=$(tr -d '\000' <"$WORK/tty.log" | grep -ac 'Role router: @fable')
check "interactive /role fable is admitted" 1 "$admitted"

echo
if [ "$fails" -eq 0 ]; then
  echo "PASS: gate refuses headless and agent-authored ingress, admits a real terminal"
  exit 0
fi
echo "FAIL: $fails check(s) failed"
exit 1
