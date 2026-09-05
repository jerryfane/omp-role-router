// Test harness: a fake ExtensionAPI that captures whatever the extension
// registers, so tests can drive the PRODUCTION entry points -- the
// before_agent_start hook, the session_role tool's execute(), and the /role
// command handler. Nothing here calls activate() or resolveSelector() directly;
// a test that reached inside would pass over a router that never routes.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type NotifyCall = { message: string; level?: string };
export type ModelKey = { provider: string; modelId: string };

export type AgentStartEvent = { prompt: string; systemPrompt: string[] };
export type AgentStartResult = { systemPrompt: string[] } | undefined;

// The fake declares one hook signature for every event name. Only
// before_agent_start is driven by these tests; the extension's other hooks are
// captured so that registering them cannot be mistaken for calling them.
export type HookHandler = (event: AgentStartEvent, ctx: unknown) => Promise<AgentStartResult>;

export type FakeZodField = { kind: string; values?: string[] };
export type ToolSpec = {
  name: string;
  parameters: { kind: string; shape: Record<string, FakeZodField> };
};
export type RoleCommandSpec = {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

export type FakePi = {
  on: (name: string, handler: HookHandler) => void;
  registerTool: (spec: ToolSpec) => void;
  registerCommand: (name: string, spec: RoleCommandSpec) => void;
  getActiveTools: () => string[];
  setActiveTools: (names: string[]) => Promise<void>;
  setModel: (model: ModelKey) => Promise<boolean>;
  setThinkingLevel: (level: string) => void;
  zod: {
    enum: (values: string[]) => FakeZodField;
    string: () => FakeZodField;
    object: (shape: Record<string, FakeZodField>) => ToolSpec["parameters"];
  };
};

// How the fake reports the ingress a /role command arrived on. Measured on omp
// 18.1.10:
//   "interactive" -> hasUI true,  mode "tui"   (a person in the composer)
//   "headless"    -> hasUI false, mode "json"  (-p / --mode=json)
//   "rpc"         -> hasUI TRUE,  mode "rpc"   (--mode=rpc, an automated client
//                    with a real UI context whose prompt frames run commands)
//   "uiOnly"      -> hasUI true,  mode absent  (a build that stops reporting it)
//   "modeOnly"    -> hasUI false, mode "tui"   (a headless harness claiming the
//                    composer mode; both fields must affirm, so this is refused)
//   "absent"      -> neither field reported
// Anything other than "interactive" must be refused a gated role.
export type Provenance = "interactive" | "headless" | "rpc" | "uiOnly" | "modeOnly" | "absent";

const PROVENANCE_FIELDS: Record<Provenance, { hasUI?: boolean; mode?: string }> = {
  interactive: { hasUI: true, mode: "tui" },
  headless: { hasUI: false, mode: "json" },
  rpc: { hasUI: true, mode: "rpc" },
  uiOnly: { hasUI: true },
  modeOnly: { hasUI: false, mode: "tui" },
  absent: {},
};

export type FakeCtx = {
  modelRegistry: { find: (provider: string, modelId: string) => ModelKey | undefined };
  ui: { notify: (message: string, level?: string) => void; confirm?: (message: string) => Promise<boolean> };
  hasUI?: boolean;
  mode?: string;
};

// What the fake ui.confirm does. Measured on omp 18.1.10: unanswered it
// resolves FALSE, a keystroke resolves true. "absent" models a build with no
// confirm at all, which must refuse rather than proceed unacknowledged.
export type Acknowledgement = "yes" | "no" | "absent";

export type Harness = {
  handlers: Map<string, HookHandler>;
  tools: Map<string, ToolSpec>;
  commands: Map<string, RoleCommandSpec>;
  activeTools: string[];
  setModelCalls: ModelKey[];
  thinkingCalls: string[];
  notifications: NotifyCall[];
  confirmPrompts: string[];
  // Models the fake registry resolves; anything else resolves to undefined,
  // which is how an unavailable model behaves in production.
  knownModels: Set<string>;
  setModelResult: boolean;
  pi: FakePi;
  ctx: FakeCtx;
};

export function makeHarness(provenance: Provenance = "interactive", acknowledgement: Acknowledgement = "yes"): Harness {
  const handlers = new Map<string, HookHandler>();
  const tools = new Map<string, ToolSpec>();
  const commands = new Map<string, RoleCommandSpec>();
  const knownModels = new Set<string>();
  const setModelCalls: ModelKey[] = [];
  const thinkingCalls: string[] = [];
  const notifications: NotifyCall[] = [];
  const confirmPrompts: string[] = [];
  const h: Harness = {
    handlers,
    tools,
    commands,
    activeTools: ["bash"],
    setModelCalls,
    thinkingCalls,
    notifications,
    confirmPrompts,
    knownModels,
    setModelResult: true,
    pi: {
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerTool(spec) {
        tools.set(spec.name, spec);
      },
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      getActiveTools() {
        return [...h.activeTools];
      },
      async setActiveTools(names) {
        h.activeTools = [...names];
      },
      async setModel(model) {
        setModelCalls.push(model);
        return h.setModelResult;
      },
      setThinkingLevel(level) {
        thinkingCalls.push(level);
      },
      // Minimal stand-in for the zod surface the extension uses. enum() keeps
      // its values so a test can assert the tool's accepted set, which is the
      // scope boundary for this change.
      zod: {
        enum(values) {
          return { kind: "enum", values: [...values] };
        },
        string() {
          const field: FakeZodField & { min: () => FakeZodField; describe: () => FakeZodField } = {
            kind: "string",
            min: () => field,
            describe: () => field,
          };
          return field;
        },
        object(shape) {
          return { kind: "object", shape };
        },
      },
    },
    ctx: {
      modelRegistry: {
        find(provider, modelId) {
          return knownModels.has(`${provider}/${modelId}`) ? { provider, modelId } : undefined;
        },
      },
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
        ...(acknowledgement === "absent"
          ? {}
          : {
              async confirm(message: string) {
                confirmPrompts.push(message);
                return acknowledgement === "yes";
              },
            }),
      },
      ...PROVENANCE_FIELDS[provenance],
    },
  };

  return h;
}

// Points the extension's config loader at a throwaway config.yml. The extension
// resolves the directory from PI_CODING_AGENT_DIR on every lookup, so this is
// the real production path rather than a stubbed loader.
//
// Values are emitted double-quoted because YAML reserves a leading `@`: an
// unquoted alias value such as `FABLE: @ASTRA` is a parse error, not an alias.
export function writeAgentConfig(modelRoles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-role-router-"));
  const body = ["setupVersion: 2", "modelRoles:"]
    .concat(Object.entries(modelRoles).map(([key, value]) => `  ${key}: "${value}"`))
    .join("\n");
  writeFileSync(join(dir, "config.yml"), `${body}\n`, "utf8");
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}
