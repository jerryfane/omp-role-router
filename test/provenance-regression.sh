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

# The TUI redraws, so a notification can appear several times in a captured pty
# stream. Presence is the assertion there; exact counts belong to event streams.
check_seen() { # check_seen <label> <actual-count>
  if [ "$2" -ge 1 ]; then
    echo "  ok   $1 (seen $2x)"
  else
    echo "  FAIL $1: not seen"
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

# Positive child-side control: prove a task child really does inherit and run
# this extension, otherwise the zero above also holds when child extension
# loading is broken and the case is vacuous. The trigger text is placed in a
# FILE so the parent prompt cannot match it, which is what makes a match in the
# child attributable to the child's own hook.
printf 'read /root/fleet-tools/apps-coc-sweep.md and execute it\n' >"$WORK/child-task.txt"
mkdir -p "$WORK/inherit"
timeout 300 omp --no-extensions -e "$EXT" --session-dir="$WORK/inherit" --mode=json \
  -p "Read the file $WORK/child-task.txt and call the task tool exactly once with a single item whose task text is exactly the contents of that file. Then reply DONE." \
  >"$WORK/inherit.out" 2>&1
child_routed=$(find "$WORK/inherit" -mindepth 2 -name '*.jsonl' -exec sh -c \
  'jq -rc "select(.type==\"model_change\")|.model" "$1" 2>/dev/null' _ {} \; | grep -c 'gpt-5.6-terra')
if [ "$child_routed" -ge 1 ]; then
  echo "  ok   a task child inherited this extension and its hook fired ($child_routed routed switch(es))"
else
  echo "  FAIL no child routed; child extension loading is broken, so the no-switch result above proves nothing"
  fails=$((fails + 1))
fi

# Case 3: a real terminal ingress must be admitted, or the gate has simply
# removed the feature. Driven through a pty because that is what makes the
# runtime report an interactive session.
#
# The dialog's cursor starts on No (initialIndex 1), so Enter alone DENIES.
# Answering Yes means moving the cursor and confirming - measured: Up then
# Enter admits, a bare Enter does not, and Left does nothing. That is
# deliberate: the default must be the safe answer, because the built-in timeout
# picks whatever the cursor is on.
echo "case 3: interactive pty ingress, acknowledged"
(
  sleep 8
  printf '/role fable\r'
  sleep 4
  printf '\x1b[A'
  sleep 1
  printf '\r'
  sleep 4
  printf '\x03'
  sleep 1
  printf '\x03'
  sleep 2
) | timeout 120 script -qec "omp --no-extensions -e $EXT --no-session --cwd $WORK" /dev/null \
  >"$WORK/tty.log" 2>&1
admitted=$(tr -d '\000' <"$WORK/tty.log" | grep -ac 'Role router: @fable')
check_seen "interactive acknowledged /role fable is admitted" "$admitted"

# Case 4: THE INGRESS THAT DEFEATED THE MODE CHECK. `omp '/role fable'` passes a
# positional message to AgentSession.prompt, which dispatches extension
# commands, and interactive startup reports mode "tui" - so an unattended pty
# invocation satisfied the mode check on its own.
#
# Nobody answers here. An unanswered dialog does NOT resolve on 18.1.10, so the
# extension bounds the wait itself; the window is shortened via the documented
# override so the case does not idle for a minute. The refusal MESSAGE is
# asserted, not just the absence of a switch: a session that failed to start, or
# a command that never dispatched, would also produce zero admissions.
echo "case 4: unattended positional CLI message in a pty"

# Positive control first: an ungated role through the SAME positional ingress
# must switch, which proves positional command dispatch works in this harness.
(
  sleep 10
  printf '\x03'
  sleep 1
  printf '\x03'
  sleep 2
) | timeout 120 script -qec "omp --no-extensions -e $EXT --no-session --cwd $WORK '/role incident'" /dev/null \
  >"$WORK/tty-cli-control.log" 2>&1
cli_control=$(tr -d '\000' <"$WORK/tty-cli-control.log" | grep -ac 'Role router: @incident')
check_seen "positional ingress does reach the handler (ungated role)" "$cli_control"

# After the refusal, a SECOND command must still execute in the same session.
# That is the assertion the earlier implementation failed: it printed the
# refusal and left the dialog presented, and the following /role incident never
# ran. A refusal that strands the session is not a safe failure.
(
  sleep 12
  printf '/role incident\r'
  sleep 6
  printf '\x03'
  sleep 1
  printf '\x03'
  sleep 2
) | PI_ROLE_ROUTER_ACK_TIMEOUT_MS=4000 timeout 120 script -qec \
  "omp --no-extensions -e $EXT --no-session --cwd $WORK '/role fable'" /dev/null \
  >"$WORK/tty-cli.log" 2>&1
cli_admitted=$(tr -d '\000' <"$WORK/tty-cli.log" | grep -ac 'Role router: @fable')
cli_refused=$(tr -d '\000' <"$WORK/tty-cli.log" | grep -ac 'not activated: the switch was not acknowledged')
cli_alive=$(tr -d '\000' <"$WORK/tty-cli.log" | grep -ac 'Role router: @incident')
check "unacknowledged positional /role fable is refused" 0 "$cli_admitted"
check_seen "and refused by the acknowledgement window, not by a dead session" "$cli_refused"
check_seen "and the session still runs the NEXT command (no wedge)" "$cli_alive"

# Case 5: an automated RPC client. This is the ingress that broke a
# UI-flag-only guard: --mode=rpc gets a real (non-no-op) UI context, so hasUI is
# true, and its prompt frames DO run slash commands. Measured with the gate
# removed, this exact frame switches the model - so unlike case 2, this case is
# a real test of the guard.
#
# The prompt text goes in `message`; a frame using `prompt` or `text` fails with
# "undefined is not an object (evaluating 'e.trimStart')" and would make every
# assertion below vacuously pass, which is why the control matters.
echo "case 5: automated rpc ingress"
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
