import { describe, expect, test } from "bun:test";
import roleRouter from "../src/role-router.ts";
import {
  type Acknowledgement,
  type AgentStartResult,
  type Harness,
  makeHarness,
  type Provenance,
  writeAgentConfig,
} from "./harness.ts";

const FABLE_SELECTOR = "anthropic/claude-fable-5-1:high";
const INCIDENT_SELECTOR = "openai-codex/gpt-5.6-sol:high";
const CHECKIN_SELECTOR = "openai-codex/gpt-5.6-terra:medium";
const DEFAULT_SELECTOR = "anthropic/claude-opus-5:high";

// Mirrors the shape of the live config: every role key is lowercase except
// FABLE, which is the mismatch this change exists to resolve.
const LIVE_LIKE_ROLES: Record<string, string> = {
  default: DEFAULT_SELECTOR,
  checkin: CHECKIN_SELECTOR,
  incident: INCIDENT_SELECTOR,
  FABLE: FABLE_SELECTOR,
};

const LIVE_MODELS = [
  "anthropic/claude-fable-5-1",
  "anthropic/claude-opus-5",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
];

function boot(
  modelRoles: Record<string, string>,
  models: string[],
  provenance: Provenance = "interactive",
  acknowledgement: Acknowledgement = "yes",
): Harness {
  writeAgentConfig(modelRoles);
  const h = makeHarness(provenance, acknowledgement);
  for (const model of models) {
    h.knownModels.add(model);
  }
  // The extension is typed against the real ExtensionAPI; the fake implements
  // only the surface it uses, so this is the deliberate test-seam assertion.
  const pi = h.pi as never;
  roleRouter(pi);
  return h;
}

async function runRoleCommand(h: Harness, args: string): Promise<void> {
  const command = h.commands.get("role");
  if (!command) {
    throw new Error("extension registered no /role command");
  }
  await command.handler(args, h.ctx);
}

async function startAgent(h: Harness, prompt: string): Promise<AgentStartResult> {
  const handler = h.handlers.get("before_agent_start");
  if (!handler) {
    throw new Error("extension registered no before_agent_start hook");
  }
  return await handler({ prompt, systemPrompt: ["base"] }, h.ctx);
}

describe("/role fable", () => {
  test("resolves the uppercase FABLE config key to the fable model and thinking level", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    await runRoleCommand(h, "fable");

    // The assertion is that it RESOLVED to the right model, not merely that it
    // did not throw: a router that silently kept the current model would pass
    // an absence-of-exception check.
    expect(h.setModelCalls).toEqual([{ provider: "anthropic", modelId: "claude-fable-5-1" }]);
    expect(h.thinkingCalls).toEqual(["high"]);
    expect(h.notifications).toEqual([
      { message: `Role router: @fable (${FABLE_SELECTOR})`, level: "info" },
    ]);
  });

  test("still resolves the roles whose config key was already lowercase", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    await runRoleCommand(h, "incident");
    await runRoleCommand(h, "checkin");
    await runRoleCommand(h, "default");

    expect(h.setModelCalls).toEqual([
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { provider: "openai-codex", modelId: "gpt-5.6-terra" },
      { provider: "anthropic", modelId: "claude-opus-5" },
    ]);
    expect(h.thinkingCalls).toEqual(["high", "medium", "high"]);
  });

  test("follows @alias indirection through the mapped key", async () => {
    const h = boot({ ...LIVE_LIKE_ROLES, FABLE: "@ASTRA", ASTRA: "openai-codex/gpt-6-astra:xhigh" }, [
      ...LIVE_MODELS,
      "openai-codex/gpt-6-astra",
    ]);

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-6-astra" }]);
    expect(h.thinkingCalls).toEqual(["xhigh"]);
  });

  test("names the missing config key, not the role name, when FABLE is absent", async () => {
    const { FABLE: _absent, ...withoutFable } = LIVE_LIKE_ROLES;
    const h = boot(withoutFable, LIVE_MODELS);

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.message).join("\n")).toContain("Missing modelRoles.FABLE");
  });

  test("rejects the uppercase spelling and an unknown role without switching models", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    await runRoleCommand(h, "FABLE");
    await runRoleCommand(h, "sonnet");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications).toEqual([
      { message: "Usage: /role [default|checkin|incident|fable]", level: "error" },
      { message: "Usage: /role [default|checkin|incident|fable]", level: "error" },
    ]);
  });
});

describe("fable is gated on an interactive ingress", () => {
  test("refuses fable when the session reports no UI, and says why", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "headless");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications).toEqual([
      {
        message: "@fable can only be selected from an interactive terminal session; this ingress is not one.",
        level: "error",
      },
    ]);
  });

  // The case that made a UI flag alone insufficient: --mode=rpc gets a real
  // (non-no-op) UI context, so hasUI is true, and its prompt frames execute
  // slash commands. Measured: `{"type":"prompt","prompt":"/role fable"}` over
  // --mode=rpc switched the model while the guard checked only hasUI.
  test("refuses an automated rpc client even though it reports a UI", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "rpc");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
  });

  test("fails closed when a UI is reported but the mode is not", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "uiOnly");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
  });

  // Both fields must affirm. Without this case the hasUI check is not
  // load-bearing: a mutant that only tests for the field's PRESENCE keeps every
  // other test green, because the mode check catches the headless fixtures.
  test("fails closed when the mode says composer but no UI is reported", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "modeOnly");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
  });

  test("fails closed when the context reports no provenance at all", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "absent");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
  });

  // The mode check alone was not enough: `omp '/role fable'` passes a
  // positional message through the same command dispatch, and interactive
  // startup reports mode "tui", so an unattended pty invocation cleared it.
  test("refuses a composer session that does not acknowledge the switch", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "no");

    await runRoleCommand(h, "fable");

    expect(h.confirmPrompts.length).toBe(1);
    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications).toEqual([
      { message: "@fable not activated: the switch was not acknowledged.", level: "error" },
    ]);
  });

  test("fails closed when the ui offers no way to acknowledge", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "absent");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
  });

  test("names the model being spent in the acknowledgement, not just the role", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    await runRoleCommand(h, "fable");

    expect(h.confirmPrompts).toEqual([`Switch this session to @fable (${FABLE_SELECTOR})?`]);
    expect(h.setModelCalls).toEqual([{ provider: "anthropic", modelId: "claude-fable-5-1" }]);
  });

  test("does not ask for an acknowledgement for an ungated role", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    await runRoleCommand(h, "incident");

    expect(h.confirmPrompts).toEqual([]);
    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-5.6-sol" }]);
  });

  test("does not gate the roles whose quota is not scarce", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "headless");

    await runRoleCommand(h, "incident");
    await runRoleCommand(h, "checkin");

    expect(h.setModelCalls).toEqual([
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { provider: "openai-codex", modelId: "gpt-5.6-terra" },
    ]);
  });

  test("an agent-authored routed run still cannot reach fable even interactively", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    await startAgent(h, "read /root/fleet-tools/jarvis-checkin.md and execute it");

    // The automatic path activates checkin and nothing else, whatever the
    // prompt says: an agent that writes "/role fable" into a task prompt gets
    // text delivered to a model, not a command.
    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-5.6-terra" }]);
    const tool = h.tools.get("session_role");
    expect(tool?.parameters.shape.role?.values).toEqual(["incident"]);
  });
});

describe("the agent-facing surface is unchanged by this change", () => {
  test("session_role still accepts only incident", () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    const tool = h.tools.get("session_role");
    expect(tool?.parameters.shape.role?.values).toEqual(["incident"]);
  });

  test("an ordinary directive prompt gets neither the tool nor a role switch", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    const result = await startAgent(h, "read notes.md and summarise the failing build");

    expect(result).toBeUndefined();
    expect(h.activeTools).toEqual(["bash"]);
    expect(h.setModelCalls).toEqual([]);
  });

  test("a routed check-in prompt still activates checkin and the tool", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    const result = await startAgent(h, "read /root/fleet-tools/jarvis-checkin.md and execute it");

    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-5.6-terra" }]);
    expect(h.activeTools).toContain("session_role");
    expect(result?.systemPrompt.length).toBe(2);
  });
});
