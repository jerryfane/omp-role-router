import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

const ROLE_NAMES = ["default", "checkin", "incident", "fable"] as const;
type RoleName = (typeof ROLE_NAMES)[number];

// Role names are lowercase by convention; the modelRoles keys in config.yml are
// not, so the mapping is declared here rather than inferred. resolveSelector
// looks up the mapped key, never the role name, so a rename on either side is a
// visible edit to this table instead of a runtime "Missing modelRoles.x".
const ROLE_CONFIG_KEY: Record<RoleName, string> = {
  default: "default",
  checkin: "checkin",
  incident: "incident",
  fable: "FABLE",
};

// Derived so the /role usage text cannot drift from the accepted set.
const ROLE_USAGE = `/role [${ROLE_NAMES.join("|")}]`;

// Type guard so `requested` narrows to RoleName for the guard and for activate.
function isRoleName(value: string): value is RoleName {
  return ROLE_NAMES.some((role) => role === value);
}

// Roles that may be selected ONLY from an interactive session, because the
// quota behind them is scarce enough that an unattended switch is a leak.
// Everything not listed here is selectable wherever /role is.
const INTERACTIVE_ONLY_ROLES: Partial<Record<RoleName, true>> = {
  fable: true,
};

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

async function isAcknowledged(ctx: ExtensionContext, role: RoleName, selector: string): Promise<boolean> {
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

function recordGatedActivation(ctx: ExtensionContext, role: RoleName, target: RoleTarget): void {
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

  const roles: Record<string, string> = {};
  for (const [name, selector] of Object.entries(candidate)) {
    if (typeof selector === "string") {
      roles[name] = selector;
    }
  }
  return roles;
}

// A resolved role: the model to switch to plus the selector text it came from.
type RoleTarget = { provider: string; modelId: string; thinking?: ThinkingLevel; selector: string };

function resolveSelector(role: RoleName): RoleTarget {
  const roles = loadModelRoles();
  const configKey = ROLE_CONFIG_KEY[role];
  let selector = roles[configKey];
  const seen = new Set<string>();

  while (typeof selector === "string" && selector.startsWith("@")) {
    const alias = selector.slice(1).split(":", 1)[0];
    if (!alias || seen.has(alias)) {
      throw new Error(`Invalid model role alias for @${role}`);
    }
    seen.add(alias);
    selector = roles[alias];
  }

  if (typeof selector !== "string") {
    throw new Error(`Missing modelRoles.${configKey} in ${join(agentDir(), "config.yml")}`);
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
  };
}

function toolText(event: ToolResultEvent): string {
  return event.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}


export default function roleRouter(pi: ExtensionAPI) {
  let currentRole: RoleName = "default";
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

  // The target may be supplied by a caller that already resolved it. That is not
  // an optimisation: an acknowledgement names a selector, and re-reading
  // config.yml here would let an edit during the dialog activate a DIFFERENT
  // model than the one that was acknowledged.
  async function activate(role: RoleName, ctx: ExtensionContext, reason: string, resolved?: RoleTarget): Promise<string> {
    const target = resolved ?? resolveSelector(role);
    const model = ctx.modelRegistry.find(target.provider, target.modelId);
    if (!model) {
      throw new Error(`Model not found for @${role}: ${target.provider}/${target.modelId}`);
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
    description: `Show or manually switch the current OMP model role: ${ROLE_USAGE}`,
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        const target = resolveSelector(currentRole);
        ctx.ui.notify(`Role router: @${currentRole} (${target.selector}), managed=${managedRun}`, "info");
        return;
      }
      if (!isRoleName(requested)) {
        ctx.ui.notify(`Usage: ${ROLE_USAGE}`, "error");
        return;
      }
      // Resolved ONCE here, then carried through the acknowledgement, the
      // record and the activation. Re-resolving after the dialog would let an
      // edit during the window switch to a model the human never saw.
      let acknowledged: RoleTarget | undefined;
      if (INTERACTIVE_ONLY_ROLES[requested]) {
        if (!isComposerSession(ctx)) {
          ctx.ui.notify(
            `@${requested} can only be selected from an interactive terminal session; this ingress is not one.`,
            "error",
          );
          return;
        }
        // Resolved before the dialog so a misconfigured role fails without
        // presenting one, and so the dialog can name the model being spent.
        let target: RoleTarget;
        try {
          target = resolveSelector(requested);
        } catch (error) {
          ctx.ui.notify(`Role router failed: ${String(error)}`, "error");
          return;
        }
        if (!(await isAcknowledged(ctx, requested, target.selector))) {
          ctx.ui.notify(`@${requested} not activated: the switch was not acknowledged.`, "error");
          return;
        }
        try {
          recordGatedActivation(ctx, requested, target);
        } catch (error) {
          ctx.ui.notify(
            `@${requested} not activated: the activation could not be recorded (${String(error)}).`,
            "error",
          );
          return;
        }
        acknowledged = target;
      }

      managedRun = false;
      try {
        await setRoleToolActive(false);
      } catch (error) {
        ctx.ui.notify(`Role router tool cleanup failed: ${String(error)}`, "error");
      }
      try {
        await activate(requested, ctx, "manual /role command", acknowledged);
      } catch (error) {
        ctx.ui.notify(`Role router failed: ${String(error)}`, "error");
      }
    },
  });
}
