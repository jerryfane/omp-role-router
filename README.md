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
5. **Offers manual control** through `/role <name>`, accepting every string-valued key in
   `modelRoles` without a separate router allowlist. A valid manual selection ends automatic
   management of the run; an unknown role is refused without ending it.

The two surfaces are deliberately not the same size. `/role` is driven by a person. The
in-session `session_role` tool, which the model itself can call, is inactive outside a
routed run and accepts only `incident` — an escalation on evidence, never a free choice of
model. Widening that set is a separate decision from adding a role.

### Roles whose quota is scarce are gated on an interactive ingress

`fable` is listed in `INTERACTIVE_ONLY_ROLES`. Selecting it, with any casing or through an
alias, requires **two** things, and both fail closed.

**1. A terminal composer session.** Measured on omp 18.1.10:

| ingress | `hasUI` | `mode` | mode check |
| --- | --- | --- | --- |
| composer in a terminal | `true` | `"tui"` | passes |
| `-p` (text output) | `false` | `"print"` | refused |
| `--mode=json` | `false` | `"json"` | refused |
| `--mode=rpc`, `--mode=rpc-ui` | **`true`** | `"rpc"` | refused |

The RPC row is why a UI flag alone is not provenance: an automated client gets a real
(non-no-op) UI context, so `hasUI` is `true`, and its prompt frames **do** execute slash
commands. With the gate checking only `hasUI`, `{"type":"prompt","message":"/role fable"}`
over `--mode=rpc` switched the model. The mode is therefore an allowlist of exactly one
value and both fields are presence-checked: a renamed `"tui"`, a new transport, or a build
that stops reporting either field is refused.

**2. An acknowledgement at the moment of the switch,** via `ctx.ui.confirm`, naming the
selector being spent. The mode check alone is not enough: `omp '/role fable'` passes a
**positional** message to `AgentSession.prompt`, which dispatches extension commands, and
interactive startup reports `mode: "tui"` — so an unattended pty invocation cleared check 1
and switched the model (reproduced on 18.1.10 in a scripted pty with no keystrokes).

The dialog carries **two independent deadlines**, and neither is optional. Measured on
18.1.10, each in its own pty with nobody answering:

| options | result | session afterwards |
| --- | --- | --- |
| `{ signal }`, aborted at 5s | `false` at 5003ms | still accepts commands |
| `{ timeout: 5000 }` | **`true`** at 5002ms | still accepts commands |
| `{ timeout: 5, initialIndex: 1 }` | `false` at 7ms | still accepts commands |
| neither | never resolves | **wedged** |

So the built-in timeout answers with the **cursor position** — Yes unless `initialIndex`
moves it to No — and `timeout` is in **milliseconds**, which makes a value meant as seconds
a 5ms window. A bare `{ timeout }` is therefore forbidden here. The switch passes
`{ timeout, initialIndex: 1, signal }` in one call: if a build ignores `initialIndex` the
abort still denies, and if it ignores `signal` the No-defaulted timeout still denies. The
abort fires first and the dialog deadline sits a grace period behind it, so the two cannot
race for the answer. The window is 60s, overridable with `PI_ROLE_ROUTER_ACK_TIMEOUT_MS`.

The last row is why this is not a detail. An earlier version awaited the dialog with no
deadline of its own, raced against a timer: it printed a refusal and left the selector
presented, and a following `/role incident` **never ran**. A refusal that strands the
session is not a safe failure, and `test/provenance-regression.sh` now asserts the next
command still executes.

Because the cursor starts on No, **Enter alone denies**; acknowledging takes an explicit
keystroke (measured: Up then Enter admits). A `confirm` that throws denies, and a `ctx.ui`
with no `confirm` denies.

**Every gated activation is recorded** to `role-activations.jsonl` in the agent directory,
naming the session id, the timestamp, the selector and the gate that admitted it. The write
happens **before** the switch and is a precondition: if it fails, the switch is refused,
because an activation nobody can attribute is exactly what the record exists to prevent.
That includes a session the extension cannot name — a row saying `unknown` would satisfy the
mechanism and not the requirement, so it refuses instead.

`PI_ROLE_ROUTER_ACK_TIMEOUT_MS` is bounded on both sides (10ms to 600000ms, integers only)
and anything outside that keeps the 60s default. Not tidiness: a value past the platform
timer limit fires immediately, which would collapse the window to nothing and with it the
ordering between the two deadlines.

**The honest limit, and it is an API limit rather than a design choice.** This proves an
ingress that *answers*, not a human. The command context exposes `mode` and `hasUI` and
nothing about the submitter; `ctx.ui` exposes `onTerminalInput`, but a scripted pty produces
real terminal input too. At this API there is no signal that separates fingers from a
script, so **automation that injects a keystroke still passes**. What the gate removes is the
**unattended** case, which is the actual leak. It is not "human-selectable": it is a
terminal composer session plus an answered dialog inside a bounded window, and the residual
is deliberate keystroke injection.

Neither check is load-bearing on the harness staying as it is. On omp 18.1.10 an
agent-attributed *task* prompt is delivered to the model as text and is never
slash-command-dispatched, so agent-authored `/role fable` switches nothing today. That is a
property of the harness, not of this repository, and an upgrade could change it with no test
here failing. The gate pins the invariant locally; `test/provenance-regression.sh` proves it
against the real binary.

A `/role` switch is not undone for you at the end of the turn: the restore to `default` runs
at the end of a *routed* run only. It does not survive unconditionally either — a later
prompt that matches the routing trigger activates `checkin` regardless of the manual choice.
That is the intended behaviour for a choice a person made, and it is the reason an
agent-facing switch would need a restore path before it could be allowed.

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
  FABLE: anthropic/claude-fable-5-1:high
```

A `:suffix` on the selector sets the thinking level. Accepted values are `inherit`, `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

### Role names and config keys

Every string-valued key in `modelRoles` is available through `/role <name>`. The extension
reads the config on each invocation, so new roles need no router edit or restart:

```text
/role astra
/role CHILL
/role default
```

Exact config keys take precedence. Otherwise, names are matched case-insensitively:
`/role astra` selects `ASTRA`, and `/role fable` selects `FABLE`. If multiple keys differ
only by casing, use their exact spelling; an ambiguous spelling is refused.

`/role` without an argument shows the current role. Unknown names are refused with a list
of configured roles and leave automatic management unchanged. Missing alias targets, alias
cycles and invalid selectors are errors, never silent fallbacks.

Fable's terminal confirmation and activation record still apply, including when another
role aliases it. Other roles need no acknowledgement. This does not expand automatic
check-in/incident routing or the incident-only `session_role` tool.

A value may point at another key with `@`, resolved before the selector is parsed. YAML
reserves a leading `@`, so an alias value **must be quoted** — `FABLE: "@ASTRA"` is an
alias, while `FABLE: @ASTRA` is a YAML parse error:

```yaml
modelRoles:
  ASTRA: openai-codex/gpt-6-astra:high
  FABLE: "@ASTRA"
```

## Adapt it to your own seats

The trigger recognises a routine runbook prompt for any seat and captures the seat name from
the filename:

```ts
const CHECKIN_PROMPT = /(?:^|\s)(?:\/root\/fleet-tools\/)?([a-z0-9]+(?:-[a-z0-9]+)*?)-(?:checkin|sweep)(?:-prompt)?\.md\b[\s\S]*\bexecute\b/i;
```

Matching the pattern is not enough on its own. A seat is routed only if it is listed:

```ts
const ROUTED_SEATS = new Set(["jarvis", "gitmoot-coc", "apps-coc"]);
```

That split is deliberate. Generalising the filename pattern would otherwise enrol every seat
whose runbook happens to be named the same way, silently changing how other people's lanes
behave. Adding a lane stays a decision.

### Exempting a seat's routine work

A command that a seat runs every ordinary day should not force an escalation. Gating it
trains the seat to route around the gate instead of respecting it:

```ts
const ROUTINE_BY_SEAT: Record<string, RegExp[]> = {
  "gitmoot-coc": [/(?:^|\s)gh\s+pr\s+merge\b/, /(?:^|\s)git\s+push\b/],
};
```

Anything not listed stays gated for every seat, so each entry loosens the gate and should be
narrow enough to justify out loud.

The three pattern lists, `INCIDENT_RESULT`, `RISKY_BASH`, and `CHECKIN_PROMPT`, are plain
arrays at the top of the file and are meant to be edited.

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

### Automated tests

```sh
bun test
```

The suite drives the production entry points — the `before_agent_start` hook and the `/role`
handler — through a fake `ExtensionAPI` that captures what the extension registers, and it
points `PI_CODING_AGENT_DIR` at a throwaway `config.yml` so selector resolution runs for
real. No test calls the internal `activate` or `resolveSelector`; a test that reached inside
would pass over a router that never routes.

It asserts what each role RESOLVES to, not merely that resolving raised nothing, and it
includes an unrouted-prompt control. `@oh-my-pi/pi-coding-agent` is not needed to run it:
the only import from it is type-only.

### Mutation proof

```sh
bun test/mutation-proof.ts
```

A green suite is not evidence unless a broken version of the code turns it red. Each mutant
is a semantic reversion of `src/role-router.ts` — it breaks the property a guard protects —
and the harness refuses to report a result unless the anchor was found, the file **on disk**
changed (sha256 compared), and the original was restored afterwards. A mutation that quietly
fails to apply otherwise reports a green suite and is indistinguishable from a mutant that
survived.

### Production-path regression (needs credentials)

```sh
test/provenance-regression.sh [path-to-extension]
```

Runs the real `omp` binary, because the fake context in `bun test` cannot prove what the
runtime reports as provenance. Five cases:

1. **headless** — the gated role is refused while an ungated role still switches (the
   control: without it, "no switch" and "the extension never loaded" look identical).
2. **agent-attributed task prompt** — characterises the harness rather than testing the
   guard. It asserts a child really received the literal command text, agent-attributed,
   that no session switched, and — as a positive control — that a task child does inherit
   this extension and fire its hook, so the zero is not the result of broken child loading.
   It passes with the gate removed, and exists to fail loudly if an omp upgrade ever starts
   dispatching that text.
3. **interactive pty, acknowledged** — a real terminal answering the confirmation must be
   admitted, or the gate has deleted the feature rather than secured it.
4. **unattended positional CLI message** — `omp '/role fable'` in a pty with nobody
   answering. This is the ingress that defeated the mode check on its own, and it also
   carries the **liveness** assertion: after the refusal a following `/role incident` must
   still execute. An earlier gate printed the refusal and left the session wedged, which no
   amount of asserting the refusal could see.
5. **automated rpc** — the ingress that broke a UI-flag-only gate; refused now, with an
   ungated-role control proving the frame reaches the handler at all.

It takes the extension path as an argument, so running it against a mutated copy is how you
check the script itself still fails. With the gate removed, cases 1, 4 and 5 all fail.

## Requirements

OMP coding agent with extension loading, and a Bun runtime, which OMP already provides.
The single import from `@oh-my-pi/pi-coding-agent` is type-only.

## License

Apache-2.0. See [LICENSE](LICENSE).
