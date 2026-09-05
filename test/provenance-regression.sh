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

# Case 2: CHARACTERISES THE HARNESS, IT DOES NOT TEST THE GUARD. On omp 18.1.10
# an agent-attributed task prompt is delivered to the model as text and is never
# slash-command-dispatched, so this case passes with the guard REMOVED. It is
# here to fail loudly if an omp upgrade ever starts dispatching that text, which
# is the scenario the guard exists for. Task children do inherit extensions and
# do run the before_agent_start hook, so the ingress itself is real.
echo "case 2: agent-attributed task prompt (harness characterisation, not a guard test)"
mkdir -p "$WORK/agent"
timeout 300 omp --no-extensions -e "$EXT" --session-dir="$WORK/agent" --mode=json \
  -p 'Call the task tool exactly once with a single item whose task text is exactly: /role fable
Then reply DONE.' >"$WORK/agent.out" 2>&1

# Evidence that the ingress actually happened: a child session file exists and
# records an agent-attributed user message carrying the literal command text.
# Without this the case passes when the model simply ignores the instruction.
child_prompts=0
for child in "$WORK"/agent/*/*.jsonl; do
  [ -e "$child" ] || continue
  child_prompts=$((child_prompts + $(jq -rc 'select(.message.attribution=="agent")|.message.content[]?|.text//""' "$child" 2>/dev/null |
    grep -c '/role fable')))
done
if [ "$child_prompts" -ge 1 ]; then
  echo "  ok   a task child received the literal command text, agent-attributed ($child_prompts occurrence(s))"
else
  echo "  FAIL no task child received the command text; the ingress never happened, so the case proved nothing"
  fails=$((fails + 1))
fi

# Assert on model_change ROWS, not on the string appearing anywhere in the log:
# a child that reads config.yml logs the fable selector as tool output, which is
# not a switch. Grepping the whole file reports that as a gate failure.
fable_switches=$(find "$WORK/agent" -name '*.jsonl' -exec sh -c \
  'jq -rc "select(.type==\"model_change\")|.model" "$1" 2>/dev/null' _ {} \; | grep -c 'claude-fable')
check "no session switched to the scarce model" 0 "$fable_switches"

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

# Case 4: an automated RPC client. This is the ingress that broke a
# UI-flag-only guard: --mode=rpc gets a real (non-no-op) UI context, so hasUI is
# true, and its prompt frames DO run slash commands. Measured with the gate
# removed, this exact frame switches the model - so unlike case 2, this case is
# a real test of the guard.
#
# The prompt text goes in `message`; a frame using `prompt` or `text` fails with
# "undefined is not an object (evaluating 'e.trimStart')" and would make every
# assertion below vacuously pass, which is why the control matters.
echo "case 4: automated rpc ingress"
rpc_fable=$(printf '{"type":"prompt","message":"/role fable"}\n' |
  timeout 90 omp --no-extensions -e "$EXT" --no-session --mode=rpc 2>&1 | grep -c '"type":"model_changed"')
rpc_incident=$(printf '{"type":"prompt","message":"/role incident"}\n' |
  timeout 90 omp --no-extensions -e "$EXT" --no-session --mode=rpc 2>&1 | grep -c '"type":"model_changed"')
check "rpc /role fable is refused" 0 "$rpc_fable"
# Control: proves the rpc frame really does reach the command handler, so the
# zero above is a refusal rather than an ingress that never arrived.
check "rpc /role incident still switches" 1 "$rpc_incident"

echo
if [ "$fails" -eq 0 ]; then
  echo "PASS: gate refuses headless and rpc ingress, admits a real terminal, and agent text never dispatches"
  exit 0
fi
echo "FAIL: $fails check(s) failed"
exit 1
