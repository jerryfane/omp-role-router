import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

// Manual roles come from modelRoles; only the scarce-role policy is fixed here.
const INTERACTIVE_ONLY_ROLES = new Set(["fable"]);

// Ingress checks for a gated role. Both must hold, and both fail CLOSED.
//
// (1) The session must be a terminal composer session. Measured on omp 18.1.10:
//   composer in a terminal  -> hasUI true,  mode "tui"
//   -p text / --mode=json   -> hasUI false, mode "print"/"json"
//   --mode=rpc / rpc-ui     -> hasUI TRUE,  mode "rpc"
// The RPC row is why a UI flag alone is not provenance: an automated client
// gets a non-no-op UI context, so hasUI is true, and its prompt frames run
// slash commands. `{"type":"prompt","message":"/role fable"}` over --mode=rpc
// switched the model before this check required the mode. The mode is an
// allowlist of ONE and both fields are presence-checked, so an unreported or
// unrecognised mode - a renamed "tui", a new transport - is refused.
function isComposerSession(ctx: ExtensionContext): boolean {
  return "hasUI" in ctx && ctx.hasUI === true && "mode" in ctx && ctx.mode === "tui";
}

// (2) The switch must be acknowledged at the moment it happens. The mode check
// alone is not enough: `omp '/role fable'` passes a POSITIONAL message to
// AgentSession.prompt, which dispatches extension commands, and interactive
// startup reports mode "tui" - so an unattended pty invocation cleared check
// (1) and switched the model.
//
// HONEST LIMIT: this proves an ingress that ANSWERS, not a human. Automation
// that injects a keystroke still passes, and nothing the extension can see
// distinguishes that. It moves the bar from "any pty invocation" to "an ingress
// that acknowledges within the window", and unattended automation - the actual
// leak - fails.

// How long silence is allowed to stand before it counts as a refusal. Read per
// invocation rather than at load so a test can exercise the silence path
// without waiting a minute.
//
// Bounded on BOTH sides, and not only for tidiness: a value past the platform
// timer limit fires immediately, which would collapse the window to nothing and
// also collapse the ordering between the two deadlines. Anything unparseable,
// non-integer or outside the range keeps the default.
const ACKNOWLEDGEMENT_WINDOW_DEFAULT_MS = 60_000;
const ACKNOWLEDGEMENT_WINDOW_MIN_MS = 10;
const ACKNOWLEDGEMENT_WINDOW_MAX_MS = 600_000;

function acknowledgementWindowMs(): number {
  const override = Number(process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS);
  const usable =
    Number.isSafeInteger(override) &&
    override >= ACKNOWLEDGEMENT_WINDOW_MIN_MS &&
    override <= ACKNOWLEDGEMENT_WINDOW_MAX_MS;
  return usable ? override : ACKNOWLEDGEMENT_WINDOW_DEFAULT_MS;
}

// The dialog carries TWO independent deadlines, in the safe direction, because
// each covers the other's failure mode. Measured on omp 18.1.10, each in its
// own pty with nobody answering:
//   { signal }, aborted at 5s         -> false at 5003ms, session still live
//   { timeout: 5000 }                 -> TRUE  at 5002ms  <- fails OPEN
//   { timeout: 5, initialIndex: 1 }   -> false at    7ms, session still live
// So: the built-in timeout answers with the CURSOR POSITION, which is Yes
// unless initialIndex moves it to No; and `timeout` is in MILLISECONDS, so a
// value meant as seconds becomes a 5ms window. Bare { timeout } is therefore
// forbidden here. If a future build ignores initialIndex the abort still
// denies; if it ignores the signal, the No-defaulted timeout still denies.
//
// The abort fires first and the dialog timeout is a grace period behind it, so
// the two deadlines cannot race for the answer.
const ACKNOWLEDGEMENT_GRACE_MS = 500;

async function isAcknowledged(ctx: ExtensionContext, role: string, selector: string): Promise<boolean> {
  const ui = ctx.ui;
  if (!("confirm" in ui) || typeof ui.confirm !== "function") {
    return false;
  }

  const windowMs = acknowledgementWindowMs();
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(new Error(`@${role} acknowledgement window expired`)), windowMs);

  try {
    const answer = await ui.confirm(`Switch this session to @${role}?`, `Spends ${selector}. This is the scarce model.`, {
      timeout: windowMs + ACKNOWLEDGEMENT_GRACE_MS,
      initialIndex: 1,
      signal: controller.signal,
    });
    return answer === true;
  } catch {
    // A dialog that cannot be presented, or an abort surfaced as a throw, is a
    // refusal - never an acknowledgement.
    return false;
  } finally {
    // Asserted by a timer spy in the suite, not left to inspection: without
    // this line every switch leaves a timer and an AbortController alive for
    // the length of the window. An earlier waiver of that test rested on the
    // gap being unobservable without wall-clock time; it is observable with a
    // spy, so the waiver was revoked and the test written.
    clearTimeout(abort);
  }
}

// Condition of the ship ruling: a gated activation must leave a durable,
// attributable trace. The residual case the gate cannot prevent - an ingress
// that injects a keystroke - is at least ATTRIBUTABLE afterwards, which is the
// difference between an unexplained burn of the scarce model and a session id
// you can name.
//
// Written BEFORE the switch and treated as a precondition: if the record cannot
// be written the switch is refused, because an activation nobody can attribute
// is exactly what this is for.
const ACTIVATION_LOG = "role-activations.jsonl";

// A record that cannot name the session does not satisfy the requirement it
// exists for, so an unidentifiable session is a REFUSAL rather than a row
// saying "unknown".
function sessionIdOf(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager;
  if (manager && typeof manager === "object" && "getSessionId" in manager && typeof manager.getSessionId === "function") {
    const id = manager.getSessionId();
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  throw new Error("the session could not be identified, so the activation would not be attributable");
}

function recordGatedActivation(ctx: ExtensionContext, role: string, target: RoleTarget): void {
  const row = {
    ts: new Date().toISOString(),
    event: "gated_role_activated",
    role,
    selector: target.selector,
    gate: "composer_session_plus_acknowledgement",
    session: sessionIdOf(ctx),
    pid: process.pid,
  };
  appendFileSync(join(agentDir(), ACTIVATION_LOG), `${JSON.stringify(row)}\n`, "utf8");
}

type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: Record<ThinkingLevel, true> = {
  inherit: true,
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

function isThinkingLevel(value: string): value is ThinkingLevel {
  return value in THINKING_LEVELS;
}

// Matches a routine runbook prompt for any seat and captures the seat name:
// "<seat>-checkin.md", "<seat>-sweep.md", "<seat>-sweep-prompt.md", with or
// without the fleet-tools directory prefix. Group 1 is the seat, e.g. "jarvis",
// "gitmoot-coc", "apps-coc".
const CHECKIN_PROMPT = /(?:^|\s)(?:\/root\/fleet-tools\/)?([a-z0-9]+(?:-[a-z0-9]+)*?)-(?:checkin|sweep)(?:-prompt)?\.md\b[\s\S]*\bexecute\b/i;

// Seats whose routine runbook prompts are routed. A seat absent from this list
// is left entirely alone, so adding a lane is an explicit decision rather than a
// side effect of the pattern above matching its runbook name.
const ROUTED_SEATS = new Set(["jarvis", "gitmoot-coc", "apps-coc"]);
const INCIDENT_RESULT = [
  /\bGHOST\b/,
  /\bGUARD-FAIL\b/,
  /\bDISK GUARD REFUSED\b/,
  /\bLEAK\b/,
  /"blocked"\s*:\s*[1-9]\d*/,
  /"agent_status"\s*:\s*"(?:blocked|input_pending)"/,
  /\bSTILL conflicting\b/i,
  /\b-> conflicting\b/i,
  /mergeStateStatus[^\n]{0,80}\bDIRTY\b/i,
  /!! MAIN RED/,
];

const RISKY_BASH = [
  /(?:^|\s)gh\s+pr\s+(?:merge|close|ready)\b/,
  /(?:^|\s)gh\s+release\s+create\b/,
  /(?:^|\s)gh\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
  /(?:^|\s)git\s+push\b/,
  /(?:^|\s)(?:herdr\s+gram|agentgram)\s+send\b/,
  /(?:^|\s)gitmoot\s+org\s+escalate\s+resolve\b/,
  /(?:^|\s)systemctl(?:\s+--user)?\s+(?:restart|stop|disable)\b/,
  /(?:^|\s)rsync\b/,
  /(?:^|\s)npm\s+run\s+build\b/,
];

// Commands a given seat runs as routine lane work, which therefore must NOT be
// blocked or force an escalation. Everything not listed here stays gated for
// every seat. Adding an entry LOOSENS the gate, so keep each one narrow and
// justified by that seat's normal duties.
const ROUTINE_BY_SEAT: Record<string, RegExp[]> = {
  // Owner decision 2026-09-01: merging and pushing are routine coordinator
  // work in this lane and must not trigger the incident model.
  "gitmoot-coc": [/(?:^|\s)gh\s+pr\s+merge\b/, /(?:^|\s)git\s+push\b/],
};

const CHECKIN_POLICY = `This is an automatically routed check-in or oversight sweep. Stay on the checkin role for routine observation and unchanged healthy state. Call session_role with role incident before any revert, deploy, destructive action, owner-facing send, authorization conflict, security or credential incident, live blocked pane, corroborated ghost, main-branch failure, conflicting evidence, or repeated inert fix. Once escalated, do not downgrade during this run. Keep healthy check-in output to one or two lines.`;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

function loadModelRoles(): Record<string, string> {
  const parsed: unknown = YAML.parse(readFileSync(join(agentDir(), "config.yml"), "utf8"));
  if (!parsed || typeof parsed !== "object" || !("modelRoles" in parsed)) {
    return {};
  }

  const candidate = parsed.modelRoles;
  if (!candidate || typeof candidate !== "object") {
    return {};
  }

  const roles: Record<string, string> = Object.create(null);
  for (const [name, selector] of Object.entries(candidate)) {
    if (typeof selector === "string") {
      roles[name] = selector;
    }
  }
  return roles;
}

// Prefer an exact config key; accept other casing only when it is unambiguous.
function resolveRoleKey(roles: Record<string, string>, role: string): string {
  if (Object.hasOwn(roles, role)) {
    return role;
  }
  const matches = Object.keys(roles).filter((key) => key.toLowerCase() === role.toLowerCase());
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous role @${role}; use an exact config key: ${matches.join(", ")}`);
  }
  throw new Error(`Unknown role @${role}. Configured roles: ${Object.keys(roles).join(", ") || "(none)"}`);
}

// Carry both the selector and its gate through the dialog without re-reading config.
type RoleTarget = { provider: string; modelId: string; thinking?: ThinkingLevel; selector: string; gated: boolean };

function resolveSelector(role: string): RoleTarget {
  const roles = loadModelRoles();
  let configKey = resolveRoleKey(roles, role);
  let selector = roles[configKey]!;
  const seen = new Set<string>();
  let gated = false;

  while (true) {
    if (seen.has(configKey)) {
      throw new Error(`Invalid model role alias for @${role}`);
    }
    seen.add(configKey);
    gated ||= INTERACTIVE_ONLY_ROLES.has(configKey.toLowerCase());
    if (!selector.startsWith("@")) {
      break;
    }
    const alias = selector.slice(1).split(":", 1)[0]!;
    configKey = resolveRoleKey(roles, alias);
    selector = roles[configKey]!;
  }

  const slash = selector.indexOf("/");
  if (slash < 1 || slash === selector.length - 1) {
    throw new Error(`Invalid model selector for @${role}: ${selector}`);
  }

  let modelId = selector.slice(slash + 1);
  let thinking: ThinkingLevel | undefined;
  const colon = modelId.lastIndexOf(":");
  const thinkingCandidate = modelId.slice(colon + 1);
  if (colon > 0 && isThinkingLevel(thinkingCandidate)) {
    thinking = thinkingCandidate;
    modelId = modelId.slice(0, colon);
  }

  return {
    provider: selector.slice(0, slash),
    modelId,
    thinking,
    selector,
    gated,
  };
}

function toolText(event: ToolResultEvent): string {
  return event.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}


export default function roleRouter(pi: ExtensionAPI) {
  let currentRole = "default";
  let managedRun = false;
  let managedSeat = "";

  async function setRoleToolActive(active: boolean): Promise<void> {
    const activeTools = pi.getActiveTools();
    const currentlyActive = activeTools.includes("session_role");
    if (currentlyActive === active) {
      return;
    }
    await pi.setActiveTools(
      active ? [...activeTools, "session_role"] : activeTools.filter((name) => name !== "session_role"),
    );
  }

  // Every entry point authorizes the same resolved target before switching.
  // Keep it fixed across acknowledgement, recording and activation.
  async function activate(role: string, ctx: ExtensionContext, reason: string): Promise<string> {
    const target = resolveSelector(role);
    const model = ctx.modelRegistry.find(target.provider, target.modelId);
    if (!model) {
      throw new Error(`Model not found for @${role}: ${target.provider}/${target.modelId}`);
    }

    if (target.gated) {
      if (!isComposerSession(ctx)) {
        throw new Error(`@${role} can only be selected from an interactive terminal session; this ingress is not one.`);
      }
      if (!(await isAcknowledged(ctx, role, target.selector))) {
        throw new Error(`@${role} not activated: the switch was not acknowledged.`);
      }
      try {
        recordGatedActivation(ctx, role, target);
      } catch (error) {
        throw new Error(`@${role} not activated: the activation could not be recorded (${String(error)}).`);
      }
    }

    const changed = await pi.setModel(model);
    if (!changed) {
      throw new Error(`OMP could not activate @${role}; provider credentials may be unavailable`);
    }
    if (target.thinking) {
      pi.setThinkingLevel(target.thinking);
    }

    currentRole = role;
    ctx.ui.notify(`Role router: @${role} (${target.selector})`, role === "incident" ? "warning" : "info");
    return `Activated @${role} (${target.selector}). Reason: ${reason}`;
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const match = CHECKIN_PROMPT.exec(event.prompt);
    if (!match) {
      return;
    }

    const seat = (match[1] ?? "").toLowerCase();
    if (!ROUTED_SEATS.has(seat)) {
      return;
    }

    managedRun = true;
    managedSeat = seat;
    try {
      await activate("checkin", ctx, `routine ${managedSeat || "seat"} runbook prompt detected`);
      await setRoleToolActive(true);
      return { systemPrompt: [...event.systemPrompt, CHECKIN_POLICY] };
    } catch (error) {
      managedRun = false;
      try {
        await setRoleToolActive(false);
      } catch (cleanupError) {
        ctx.ui.notify(`Role router tool cleanup failed: ${String(cleanupError)}`, "error");
      }
      if (currentRole !== "default") {
        try {
          await activate("default", ctx, "check-in routing failed");
        } catch (restoreError) {
          ctx.ui.notify(`Role router restore failed: ${String(restoreError)}`, "error");
        }
      }
      ctx.ui.notify(`Role router failed: ${String(error)}`, "error");
      return { systemPrompt: event.systemPrompt };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!managedRun || currentRole !== "checkin" || event.toolName !== "bash") {
      return;
    }

    const output = toolText(event);
    const trigger = INCIDENT_RESULT.find((pattern) => pattern.test(output));
    if (!trigger) {
      return;
    }

    try {
      await activate("incident", ctx, `high-signal check-in result matched ${trigger}`);
    } catch (error) {
      ctx.ui.notify(`Role router escalation failed: ${String(error)}`, "error");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!managedRun || currentRole !== "checkin" || event.toolName !== "bash") {
      return;
    }

    const command = String(event.input?.command ?? "");
    if (!RISKY_BASH.some((pattern) => pattern.test(command))) {
      return;
    }

    // This seat's routine lane work is exempt: gating it would force an
    // escalation on every ordinary day, which trains the seat to route around
    // the gate rather than respect it.
    const routine = ROUTINE_BY_SEAT[managedSeat] ?? [];
    if (routine.some((pattern) => pattern.test(command))) {
      return;
    }

    try {
      await activate("incident", ctx, "consequential command requires incident review");
      return {
        block: true,
        reason: "Role router switched this same session to @incident. Re-evaluate authorization and evidence, then retry the exact command only if it remains warranted.",
      };
    } catch (error) {
      return {
        block: true,
        reason: `Role router could not activate @incident, so the consequential command remains blocked: ${String(error)}`,
      };
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!managedRun) {
      return;
    }

    managedRun = false;
    managedSeat = "";
    try {
      await activate("default", ctx, "routed run completed");
    } catch (error) {
      ctx.ui.notify(`Role router restore failed: ${String(error)}`, "error");
    }
    try {
      await setRoleToolActive(false);
    } catch (error) {
      ctx.ui.notify(`Role router tool cleanup failed: ${String(error)}`, "error");
    }
  });

  pi.registerTool({
    name: "session_role",
    label: "Session role",
    description: "Escalate an automatically routed check-in or sweep to the incident model in the same OMP session. Use before consequential action or when the injected routing policy says incident review is required.",
    loadMode: "essential",
    defaultInactive: true,
    approval: "read",
    parameters: pi.zod.object({
      role: pi.zod.enum(["incident"]),
      reason: pi.zod.string().min(1).describe("Concrete evidence or decision requiring incident review"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!managedRun) {
        return {
          content: [{ type: "text", text: "Rejected: session_role is only available during an automatically routed check-in or sweep." }],
          details: { role: currentRole, managedRun },
          isError: true,
        };
      }
      if (currentRole === "incident") {
        return {
          content: [{ type: "text", text: "Already using @incident in this same session." }],
          details: { role: currentRole, managedRun },
        };
      }

      try {
        const text = await activate(params.role, ctx, params.reason);
        return {
          content: [{ type: "text", text }],
          details: { role: currentRole, managedRun },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error) }],
          details: { role: currentRole, managedRun },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("role", {
    description: "Show the current role or switch to any configured modelRoles key: /role <name>",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        const target = resolveSelector(currentRole);
        ctx.ui.notify(`Role router: @${currentRole} (${target.selector}), managed=${managedRun}`, "info");
        return;
      }
      try {
        await activate(requested, ctx, "manual /role command");
      } catch (error) {
        ctx.ui.notify(`Role router failed: ${String(error)}`, "error");
        return;
      }

      managedRun = false;
      try {
        await setRoleToolActive(false);
      } catch (error) {
        ctx.ui.notify(`Role router tool cleanup failed: ${String(error)}`, "error");
      }
    },
  });
}
