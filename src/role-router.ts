import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

const ROLE_NAMES = ["default", "checkin", "incident"] as const;
type RoleName = (typeof ROLE_NAMES)[number];
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

const CHECKIN_PROMPT = /(?:^|\s)(?:\/root\/fleet-tools\/)?jarvis-(?:checkin|sweep)\.md\b[\s\S]*\bexecute\b/i;
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

const CHECKIN_POLICY = `This is an automatically routed Jarvis check-in or oversight sweep. Stay on the checkin role for routine observation and unchanged healthy state. Call session_role with role incident before any merge, revert, deploy, destructive action, owner-facing send, authorization conflict, security or credential incident, live blocked pane, corroborated ghost, main-branch failure, conflicting evidence, or repeated inert fix. Once escalated, do not downgrade during this run. Keep healthy check-in output to one or two lines.`;

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

function resolveSelector(role: RoleName): { provider: string; modelId: string; thinking?: ThinkingLevel; selector: string } {
  const roles = loadModelRoles();
  let selector = roles[role];
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
    throw new Error(`Missing modelRoles.${role} in ${join(agentDir(), "config.yml")}`);
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

  async function activate(role: RoleName, ctx: ExtensionContext, reason: string): Promise<string> {
    const target = resolveSelector(role);
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
    if (!CHECKIN_PROMPT.test(event.prompt)) {
      return;
    }

    managedRun = true;
    try {
      await activate("checkin", ctx, "Jarvis check-in prompt detected");
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
    try {
      await activate("default", ctx, "automatic check-in completed");
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
    description: "Escalate an automatically routed Jarvis check-in or sweep to the incident model in the same OMP session. Use before consequential action or when the injected routing policy says incident review is required.",
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
          content: [{ type: "text", text: "Rejected: session_role is only available during an automatically routed Jarvis check-in or sweep." }],
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
    description: "Show or manually switch the current OMP model role: /role [default|checkin|incident]",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        const target = resolveSelector(currentRole);
        ctx.ui.notify(`Role router: @${currentRole} (${target.selector}), managed=${managedRun}`, "info");
        return;
      }
      if (!ROLE_NAMES.some((role) => role === requested)) {
        ctx.ui.notify("Usage: /role [default|checkin|incident]", "error");
        return;
      }

      managedRun = false;
      try {
        await setRoleToolActive(false);
      } catch (error) {
        ctx.ui.notify(`Role router tool cleanup failed: ${String(error)}`, "error");
      }
      try {
        await activate(requested, ctx, "manual /role command");
      } catch (error) {
        ctx.ui.notify(`Role router failed: ${String(error)}`, "error");
      }
    },
  });
}
