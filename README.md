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
5. **Offers manual control** through a `/role` command, which ends automatic management of
   the run and switches to any role the ingress is allowed to select.

The two surfaces are deliberately not the same size. `/role` is driven by a person. The
in-session `session_role` tool, which the model itself can call, is inactive outside a
routed run and accepts only `incident` — an escalation on evidence, never a free choice of
model. Widening that set is a separate decision from adding a role.

### Roles whose quota is scarce are gated on an interactive ingress

`fable` is listed in `INTERACTIVE_ONLY_ROLES` and is refused unless the command context
reports a terminal composer session. Measured on omp 18.1.10:

| ingress | `hasUI` | `mode` | gated role |
| --- | --- | --- | --- |
| composer in a terminal | `true` | `"tui"` | allowed |
| `-p` / `--mode=json` | `false` | `"json"` | refused |
| `--mode=rpc`, `--mode=rpc-ui` | **`true`** | `"rpc"` | refused |

The RPC row is why a UI flag alone is not provenance: an automated client gets a real
(non-no-op) UI context, so `hasUI` is `true`, and its prompt frames **do** execute slash
commands. With the gate checking only `hasUI`, `{"type":"prompt","message":"/role fable"}`
over `--mode=rpc` switched the model. So the mode is an allowlist of exactly one value, and
both fields are presence-checked: an unreported or unrecognised mode is refused. A build
that renames `"tui"`, adds a transport, or stops reporting either field fails **closed**.

The gate is deliberately not load-bearing on the harness staying as it is. On omp 18.1.10 an
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

The role names are `default`, `checkin`, `incident`, and `fable`. The config key each one
reads is declared in `ROLE_CONFIG_KEY` and is **not** derived from the role name, because a
key in an existing config may already be spelled differently — `fable` reads `FABLE`:

```ts
const ROLE_CONFIG_KEY: Record<RoleName, string> = {
  default: "default",
  checkin: "checkin",
  incident: "incident",
  fable: "FABLE",
};
```

Point a role at a differently-spelled key by editing that table rather than by renaming the
config key, so the mapping stays in the versioned file and a mismatch is a visible edit
instead of a runtime `Missing modelRoles.<key>`.

A missing key is reported, not silently absorbed: the switch is refused, the model does not
move, and the notification names the **config key** it looked for. That is a deliberate
difference from a fallback — a routing extension that quietly kept the current model would
be indistinguishable from one that never loaded.

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
runtime reports as provenance. Four cases:

1. **headless** — the gated role is refused while an ungated role still switches (the
   control: without it, "no switch" and "the extension never loaded" look identical).
2. **agent-attributed task prompt** — characterises the harness rather than testing the
   guard. It asserts a child really received the literal command text, agent-attributed,
   and that no session switched. It passes with the gate removed, and exists to fail loudly
   if an omp upgrade ever starts dispatching that text.
3. **interactive pty** — a real terminal must be admitted, or the gate has deleted the
   feature rather than secured it.
4. **automated rpc** — the ingress that broke a UI-flag-only gate; refused now, with an
   ungated-role control proving the frame reaches the handler at all.

It takes the extension path as an argument, so running it against a mutated copy is how you
check the script itself still fails. With the gate removed, cases 1 and 4 both fail.

## Requirements

OMP coding agent with extension loading, and a Bun runtime, which OMP already provides.
The single import from `@oh-my-pi/pi-coding-agent` is type-only.

## License

Apache-2.0. See [LICENSE](LICENSE).
