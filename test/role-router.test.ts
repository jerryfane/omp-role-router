import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// Existing lowercase roles and uppercase user-defined keys share one config.
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
  return await handler({ prompt, systemPrompt: ["base"] }, h.ctx) as AgentStartResult;
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

  test("follows @alias indirection through the configured key", async () => {
    const h = boot({ ...LIVE_LIKE_ROLES, FABLE: "@ASTRA", ASTRA: "openai-codex/gpt-6-astra:xhigh" }, [
      ...LIVE_MODELS,
      "openai-codex/gpt-6-astra",
    ]);

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-6-astra" }]);
    expect(h.thinkingCalls).toEqual(["xhigh"]);
  });

});

describe("configured manual roles", () => {
  test("discovers new roles after registration and accepts their lowercase spelling", async () => {
    const h = boot(LIVE_LIKE_ROLES, [...LIVE_MODELS, "openai-codex/gpt-6-astra"]);
    writeAgentConfig({ ...LIVE_LIKE_ROLES, ASTRA: "openai-codex/gpt-6-astra:xhigh" });

    await runRoleCommand(h, "astra");

    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-6-astra" }]);
    expect(h.thinkingCalls).toEqual(["xhigh"]);
    expect(h.confirmPrompts).toEqual([]);
  });

  test("unknown roles are refused without ending automatic management", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);
    await startAgent(h, "read /root/fleet-tools/jarvis-checkin.md and execute it");

    await runRoleCommand(h, "missing");

    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-5.6-terra" }]);
    expect(h.activeTools).toContain("session_role");
    expect(h.notifications.at(-1)?.level).toBe("error");
  });

  test("exact keys win and ambiguous casing is refused", async () => {
    const h = boot({ Astra: DEFAULT_SELECTOR, ASTRA: INCIDENT_SELECTOR }, LIVE_MODELS);

    await runRoleCommand(h, "astra");
    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.at(-1)?.level).toBe("error");
    await runRoleCommand(h, "Astra");
    await runRoleCommand(h, "ASTRA");
    expect(h.setModelCalls).toEqual([
      { provider: "anthropic", modelId: "claude-opus-5" },
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    ]);
  });

  test("uppercase and aliased Fable cannot bypass the gate", async () => {
    const h = boot({ ...LIVE_LIKE_ROLES, scarce: "@FaBlE" }, LIVE_MODELS, "headless");

    await runRoleCommand(h, "FABLE");
    await runRoleCommand(h, "scarce");
    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error", "error"]);
  });

  test("an acknowledged alias to Fable still switches and records its selector", async () => {
    const h = boot({ ...LIVE_LIKE_ROLES, scarce: "@FABLE" }, LIVE_MODELS);

    await runRoleCommand(h, "scarce");

    expect(h.setModelCalls).toEqual([{ provider: "anthropic", modelId: "claude-fable-5-1" }]);
    const rows = readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "role-activations.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toMatchObject([{ role: "scarce", selector: FABLE_SELECTOR }]);
  });

  test("cyclic and dangling aliases are refused", async () => {
    const h = boot({ a: "@B", B: "@a", dangling: "@missing" }, LIVE_MODELS);

    await runRoleCommand(h, "a");
    await runRoleCommand(h, "dangling");
    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error", "error"]);
  });

  test("prototype names are roles only when explicitly configured", async () => {
    const h = boot({ ...LIVE_LIKE_ROLES, ["__proto__"]: INCIDENT_SELECTOR }, LIVE_MODELS);

    await runRoleCommand(h, "constructor");
    expect(h.setModelCalls).toEqual([]);
    await runRoleCommand(h, "__proto__");
    expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-5.6-sol" }]);
  });
});

describe("automatic callbacks enforce resolved Fable aliases", () => {
  const prompt = "read /root/fleet-tools/jarvis-checkin.md and execute it";
  async function event(h: Harness, name: string, input: unknown = {}): Promise<unknown> {
    const callback = h.handlers.get(name);
    if (!callback) throw new Error(`Missing production callback: ${name}`);
    return callback(input, h.ctx);
  }
  const paths = [
    { name: "checkin start", role: "checkin", run: (h: Harness) => startAgent(h, prompt) },
    {
      name: "incident evidence", role: "incident",
      run: (h: Harness) => event(h, "tool_result", {
        toolName: "bash", content: [{ type: "text", text: "GUARD-FAIL" }],
      }),
    },
    {
      name: "incident consequential command", role: "incident",
      run: (h: Harness) => event(h, "tool_call", { toolName: "bash", input: { command: "git push" } }),
      refusedResult: { block: true },
    },
    {
      name: "incident session_role", role: "incident",
      run: (h: Harness) => h.tools.get("session_role")!.execute(
        "incident-call", { role: "incident", reason: "A confirmed incident" }, undefined, undefined, h.ctx,
      ),
      refusedResult: { isError: true },
    },
    { name: "default at run end", role: "default", run: (h: Harness) => event(h, "agent_end") },
    {
      name: "default after failed checkin", role: "default", failedCheckin: true,
      run: (h: Harness) => startAgent(h, prompt),
    },
  ];

  for (const path of paths) {
    async function prepare(provenance: Provenance, acknowledgement: Acknowledgement): Promise<Harness> {
      const roles: Record<string, string> = { ...LIVE_LIKE_ROLES, Bridge: "@fAbLe" };
      // Exercise case-insensitive lookup at both the entry role and alias hop.
      delete roles[path.role];
      roles[path.role.toUpperCase()] = "@bridge";
      const h = boot(roles, LIVE_MODELS, provenance, acknowledgement);
      if (path.role !== "checkin") {
        await startAgent(h, prompt);
      }
      if (path.failedCheckin) {
        writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "config.yml"),
          `modelRoles: ${JSON.stringify({ ...roles, checkin: "missing/model" })}\n`);
      }
      h.setModelCalls.length = 0;
      return h;
    }

    test(`${path.name}: acknowledgement activates and attributes the resolved model`, async () => {
      const h = await prepare("interactive", "yes");

      await path.run(h);

      expect(h.setModelCalls).toEqual([{ provider: "anthropic", modelId: "claude-fable-5-1" }]);
      expect(h.confirmDetails).toEqual([`Spends ${FABLE_SELECTOR}. This is the scarce model.`]);
      const rows = readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "role-activations.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toMatchObject([{
        role: path.role, selector: FABLE_SELECTOR,
        session: "01a07000-0000-7000-8000-000000000abc",
        gate: "composer_session_plus_acknowledgement",
      }]);
    });

    test(`${path.name}: declining confirmation refuses activation`, async () => {
      const h = await prepare("interactive", "no");

      const result = await path.run(h);

      expect(h.confirmDetails).toEqual([`Spends ${FABLE_SELECTOR}. This is the scarce model.`]);
      expect(h.setModelCalls).toEqual([]);
      expect(existsSync(join(process.env.PI_CODING_AGENT_DIR!, "role-activations.jsonl"))).toBe(false);
      if (path.refusedResult) expect(result).toMatchObject(path.refusedResult);
    });

    test(`${path.name}: headless ingress cannot spend Fable`, async () => {
      const h = await prepare("headless", "yes");

      const result = await path.run(h);

      expect(h.setModelCalls).toEqual([]);
      expect(h.confirmPrompts).toEqual([]);
      expect(existsSync(join(process.env.PI_CODING_AGENT_DIR!, "role-activations.jsonl"))).toBe(false);
      if (path.refusedResult) expect(result).toMatchObject(path.refusedResult);
    });
  }

  test("declining a manual switch preserves the routed incident escalation path", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "no");
    await startAgent(h, prompt);
    await runRoleCommand(h, "fable");

    await event(h, "tool_result", { toolName: "bash", content: [{ type: "text", text: "GUARD-FAIL" }] });

    expect(h.setModelCalls).toEqual([
      { provider: "openai-codex", modelId: "gpt-5.6-terra" },
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    ]);
  });
});

describe("fable is gated on an interactive ingress", () => {
  test("refuses fable when the session reports no UI", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "headless");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
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
  });

  test("fails closed when the ui offers no way to acknowledge", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "absent");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
  });

  // THE LIVENESS TEST. A refusal that leaves the dialog presented is not a safe
  // failure: omp keeps that selector focused and queues later dialogs, so the
  // session stops accepting commands. Measured in a real pty against the
  // previous implementation: /role fable unanswered printed the refusal, and a
  // following /role incident NEVER RAN. Asserting the refusal alone cannot see
  // that, so this asserts the dialog is CLOSED and that a second command still
  // works in the same session.
  test("denies without leaving the session wedged when nobody answers", async () => {
    process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS = "50";
    try {
      const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "silent");

      await runRoleCommand(h, "fable");

      expect(h.confirmPrompts.length).toBe(1);
      expect(h.setModelCalls).toEqual([]);
      // No dialog left behind, and the session takes the next command.
      expect(h.dialogsOpen).toBe(0);

      await runRoleCommand(h, "incident");
      expect(h.setModelCalls).toEqual([{ provider: "openai-codex", modelId: "gpt-5.6-sol" }]);
    } finally {
      delete process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS;
    }
  });

  // Each half of the redundancy is sufficient alone. A build that ignores the
  // signal must still be denied by the No-defaulted timeout, and a build that
  // ignores initialIndex - whose timeout therefore answers YES - must still be
  // denied by the abort. A test that only fails when both are broken proves
  // neither.
  test("denies through the timeout alone when the signal is ignored", async () => {
    process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS = "20";
    try {
      const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "ignoresSignal");

      await runRoleCommand(h, "fable");

      expect(h.confirmOptions[0]?.initialIndex).toBe(1);
      expect(h.setModelCalls).toEqual([]);
      expect(h.dialogsOpen).toBe(0);
    } finally {
      delete process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS;
    }
  });

  test("denies through the abort alone when the timeout would answer yes", async () => {
    process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS = "20";
    try {
      const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "ignoresDefault");

      await runRoleCommand(h, "fable");

      expect(h.confirmOptions[0]?.signal).toBeDefined();
      expect(h.setModelCalls).toEqual([]);
      expect(h.dialogsOpen).toBe(0);
    } finally {
      delete process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS;
    }
  });

  test("gives the dialog a deadline behind the abort, in milliseconds", async () => {
    process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS = "20";
    try {
      const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "silent");

      await runRoleCommand(h, "fable");

      // Strictly greater than the abort window: if the two deadlines coincided
      // they would race for the answer, and on a build that ignores
      // initialIndex the timeout's answer is Yes.
      expect(h.confirmOptions[0]?.timeout).toBe(520);
    } finally {
      delete process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS;
    }
  });

  // Deterministic, no sleeping: spy on the timer functions and assert the
  // window timer created for the dialog is the one cleared afterwards. Without
  // the clearTimeout, every switch leaves a live timer and AbortController for
  // the length of the window.
  test("clears the acknowledgement window timer once the dialog is answered", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const created: unknown[] = [];
    const cleared: unknown[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number) => {
      const id = realSetTimeout(handler, ms);
      created.push(id);
      return id;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id?: number | Timer) => {
      cleared.push(id);
      realClearTimeout(id as Parameters<typeof realClearTimeout>[0]);
    }) as typeof globalThis.clearTimeout;

    try {
      // "yes" answers on the spot, so the only timer created is the window one.
      const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "yes");

      await runRoleCommand(h, "fable");

      expect(h.setModelCalls.length).toBe(1);
      expect(created.length).toBe(1);
      expect(cleared).toContain(created[0]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  // A window past the platform timer limit fires immediately, which would
  // collapse both the window and the ordering between the two deadlines. An
  // out-of-range override is ignored rather than honoured.
  test("ignores an out-of-range acknowledgement window", async () => {
    for (const hostile of ["999999999999", "0", "-5", "1.5", "NaN", ""]) {
      process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS = hostile;
      try {
        const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

        await runRoleCommand(h, "fable");

        expect(h.confirmOptions[0]?.timeout).toBe(60_500);
      } finally {
        delete process.env.PI_ROLE_ROUTER_ACK_TIMEOUT_MS;
      }
    }
  });

  test("denies when the dialog cannot be presented at all", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS, "interactive", "throws");

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications.map((entry) => entry.level)).toEqual(["error"]);
  });

  test("names the model being spent in the acknowledgement, not just the role", async () => {
    const h = boot(LIVE_LIKE_ROLES, LIVE_MODELS);

    await runRoleCommand(h, "fable");

    expect(h.confirmPrompts).toEqual(["Switch this session to @fable?"]);
    expect(h.confirmDetails).toEqual([`Spends ${FABLE_SELECTOR}. This is the scarce model.`]);
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

describe("a gated activation leaves an attributable record", () => {
  test("records the session, the selector and the gate that admitted it", async () => {
    const dir = writeAgentConfig(LIVE_LIKE_ROLES);
    const h = makeHarness();
    for (const model of LIVE_MODELS) {
      h.knownModels.add(model);
    }
    roleRouter(h.pi as never);

    await runRoleCommand(h, "fable");

    const rows = readFileSync(join(dir, "role-activations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      event: "gated_role_activated",
      role: "fable",
      selector: FABLE_SELECTOR,
      gate: "composer_session_plus_acknowledgement",
      session: "01a07000-0000-7000-8000-000000000abc",
    });
    expect(typeof rows[0].ts).toBe("string");
  });

  test("writes nothing for an ungated role", async () => {
    const dir = writeAgentConfig(LIVE_LIKE_ROLES);
    const h = makeHarness();
    for (const model of LIVE_MODELS) {
      h.knownModels.add(model);
    }
    roleRouter(h.pi as never);

    await runRoleCommand(h, "incident");

    expect(existsSync(join(dir, "role-activations.jsonl"))).toBe(false);
  });

  // An activation nobody can attribute is the thing the record exists to
  // prevent, so failing to write it refuses the switch rather than proceeding
  // quietly.
  test("refuses the switch when the record cannot be written", async () => {
    const dir = writeAgentConfig(LIVE_LIKE_ROLES);
    mkdirSync(join(dir, "role-activations.jsonl"));
    const h = makeHarness();
    for (const model of LIVE_MODELS) {
      h.knownModels.add(model);
    }
    roleRouter(h.pi as never);

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications[0]?.message).toContain("could not be recorded");
  });

  // A row saying "unknown" would satisfy the mechanism and not the requirement,
  // so a session the extension cannot name is a refusal.
  test("refuses the switch when the session cannot be identified", async () => {
    const dir = writeAgentConfig(LIVE_LIKE_ROLES);
    const h = makeHarness();
    for (const model of LIVE_MODELS) {
      h.knownModels.add(model);
    }
    h.ctx.sessionManager = undefined;
    roleRouter(h.pi as never);

    await runRoleCommand(h, "fable");

    expect(h.setModelCalls).toEqual([]);
    expect(h.notifications[0]?.message).toContain("could not be recorded");
    expect(existsSync(join(dir, "role-activations.jsonl"))).toBe(false);
  });

  // The dialog names a selector; activating must use THAT one. Re-resolving
  // after the acknowledgement lets an edit during the window switch to a model
  // the human never saw.
  test("activates the acknowledged selector even if the config changes during the dialog", async () => {
    const dir = writeAgentConfig(LIVE_LIKE_ROLES);
    const h = makeHarness();
    for (const model of [...LIVE_MODELS, "anthropic/claude-swapped-1"]) {
      h.knownModels.add(model);
    }
    roleRouter(h.pi as never);

    const command = h.commands.get("role");
    if (!command) {
      throw new Error("extension registered no /role command");
    }
    // Rewrite FABLE while the dialog is open: the fake answers on the next tick,
    // so this lands between resolution and activation.
    const pending = command.handler("fable", h.ctx);
    writeFileSync(join(dir, "config.yml"), 'setupVersion: 2\nmodelRoles:\n  FABLE: "anthropic/claude-swapped-1:low"\n', "utf8");
    await pending;

    expect(h.setModelCalls).toEqual([{ provider: "anthropic", modelId: "claude-fable-5-1" }]);
    expect(h.thinkingCalls).toEqual(["high"]);
  });
});
