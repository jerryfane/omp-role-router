# omp-role-router

An [OMP](https://github.com/oh-my-pi) coding-agent extension that picks the model for you,
based on what the turn is actually doing.

A long-running autonomous seat spends most of its turns confirming that nothing changed.
Those turns do not need an expensive model. The few turns that merge, deploy, push, or
message a human do. This extension routes between the two automatically, inside one
session, with no restart and no lost context.

## What it does

1. **Auto-routes on the prompt.** When a turn opens with a recognised routine prompt, the
   session switches to the `checkin` model role and a short routing policy is injected.
2. **Escalates on evidence.** While the routine role is active, every `bash` result is
   scanned. A high-signal match (a ghost job, a guard failure, a containment leak, a red
   main branch, a blocked pane, a dirty merge state) switches the same session to the
   `incident` role.
3. **Escalates before consequential commands.** A `bash` call matching a consequential
   pattern is **blocked**, the session is switched to `incident`, and the model is told to
   re-evaluate authorization before retrying. The blocked patterns are pull-request merge,
   close and ready, release creation, mutating `gh api` calls, `git push`, owner-facing
   message sends, escalation resolution, `systemctl` restart, stop and disable, `rsync`,
   and `npm run build`.
4. **Restores the default role** when the routed run ends.
5. **Offers manual control** through a `session_role` tool and a `/role` command.

The direction matters: escalation is one-way for the duration of a run. A turn that has
already seen something serious does not drift back down to the cheap model.

## Why block instead of just switching

Switching the model does not undo a command that already ran. Blocking the first attempt
is what makes the escalation meaningful: the consequential command is re-decided by the
stronger model rather than merely reported to it.

## Install

Drop the file into an OMP auto-discovery directory:

```sh
mkdir -p ~/.omp/agent/extensions
cp src/role-router.ts ~/.omp/agent/extensions/role-router.ts
```

`~/.omp/agent/extensions/` is scanned at startup, so no flag is needed. Under
`omp --profile <name>` the directory becomes `~/.omp/profiles/<name>/agent/extensions/`.
`PI_CODING_AGENT_DIR` overrides the agent directory.

## Configure

The extension reads model selectors from `modelRoles` in `~/.omp/agent/config.yml`. It
never hardcodes a model:

```yaml
modelRoles:
  default: anthropic/claude-opus-5:high
  checkin: openai-codex/gpt-5.6-terra:medium
  incident: openai-codex/gpt-5.6-sol:high
```

A `:suffix` on the selector sets the thinking level. Accepted values are `inherit`, `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A role with no entry falls back to
the session default, so a partial config degrades instead of failing.

## Adapt the trigger to your own prompts

This shipped as fleet tooling, so the default prompt trigger is specific to it:

```ts
const CHECKIN_PROMPT = /(?:^|\s)(?:\/root\/fleet-tools\/)?jarvis-(?:checkin|sweep)\.md\b[\s\S]*\bexecute\b/i;
```

Point it at whatever your own routine prompt looks like. The three pattern lists,
`INCIDENT_RESULT`, `RISKY_BASH`, and `CHECKIN_PROMPT`, are plain arrays at the top of the
file and are meant to be edited.

## Verify it, do not assume it

Rendered terminal text is not evidence. The session log is. Check for `model_change` rows:

```sh
jq -c 'select(.type=="model_change") | {ts:.timestamp, to:.to}' \
  ~/.omp/agent/sessions/*/<session>.jsonl | tail
```

A routed run shows the switch to the `checkin` selector when the prompt lands, any
escalation to `incident`, and the restore to `default` at the end.

Run a control as well: send a prompt that does **not** match the trigger and confirm the
model does not move. Without the control, a passing test cannot distinguish a working
router from an extension that never loaded. `/role` with no argument prints the current
role and whether the run is managed, which separates those two cases directly.

## Requirements

OMP coding agent with extension loading, and a Bun runtime, which OMP already provides.
The single import from `@oh-my-pi/pi-coding-agent` is type-only.

## License

Apache-2.0. See [LICENSE](LICENSE).
