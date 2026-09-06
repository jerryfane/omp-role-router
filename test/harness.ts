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

// The event registry captures callbacks with different runtime signatures.
// Tests supply the production event shape for each registered entry point.
export type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

export type FakeZodField = { kind: string; values?: string[] };
export type ToolSpec = {
  name: string;
  parameters: { kind: string; shape: Record<string, FakeZodField> };
  execute: (
    toolCallId: string,
    params: { role: "incident"; reason: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
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

export type DialogOptions = { timeout?: number; initialIndex?: number; signal?: AbortSignal };

export type FakeCtx = {
  modelRegistry: { find: (provider: string, modelId: string) => ModelKey | undefined };
  ui: {
    notify: (message: string, level?: string) => void;
    confirm?: (title: string, message: string, options?: DialogOptions) => Promise<boolean>;
  };
  sessionManager?: { getSessionId: () => string };
  hasUI?: boolean;
  mode?: string;
};

// What the fake ui.confirm does. Measured on omp 18.1.10, each in its own pty
// with nobody answering: `{signal}` aborted at 5s resolved FALSE at 5003ms;
// `{timeout:5000}` resolved TRUE at 5002ms (the built-in timeout answers with
// the cursor position); `{timeout:5, initialIndex:1}` resolved false at 7ms.
// Silence with neither option set does not resolve at all.
//
//   "yes" / "no"       - answered by a keystroke
//   "absent"           - a build with no confirm on ctx.ui
//   "throws"           - a dialog that cannot be presented
//   "silent"           - nobody answers; honours BOTH deadlines
//   "ignoresSignal"    - honours only the built-in timeout
//   "ignoresDefault"   - honours the signal; its timeout answers YES, i.e. a
//                        build that ignores initialIndex
export type Acknowledgement =
  | "yes"
  | "no"
  | "absent"
  | "throws"
  | "silent"
  | "ignoresSignal"
  | "ignoresDefault";

export type Harness = {
  handlers: Map<string, HookHandler>;
  tools: Map<string, ToolSpec>;
  commands: Map<string, RoleCommandSpec>;
  activeTools: string[];
  setModelCalls: ModelKey[];
  thinkingCalls: string[];
  notifications: NotifyCall[];
  confirmPrompts: string[];
  confirmDetails: string[];
  confirmOptions: DialogOptions[];
  // Dialogs presented but never settled. A refusal that leaves one of these
  // behind is the wedge: omp keeps that selector focused and queues later
  // dialogs, so the session stops accepting commands.
  dialogsOpen: number;
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
  const confirmDetails: string[] = [];
  const confirmOptions: DialogOptions[] = [];
  const h: Harness = {
    handlers,
    tools,
    commands,
    activeTools: ["bash"],
    setModelCalls,
    thinkingCalls,
    notifications,
    confirmPrompts,
    confirmDetails,
    confirmOptions,
    dialogsOpen: 0,
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
      sessionManager: {
        getSessionId: () => "01a07000-0000-7000-8000-000000000abc",
      },
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
        ...(acknowledgement === "absent"
          ? {}
          : {
              async confirm(title: string, message: string, options?: DialogOptions) {
                confirmPrompts.push(title);
                confirmDetails.push(message);
                confirmOptions.push({ ...options });
                if (acknowledgement === "throws") {
                  throw new Error("no terminal to present a dialog on");
                }
                if (acknowledgement === "yes" || acknowledgement === "no") {
                  return acknowledgement === "yes";
                }

                // Nobody answers. Settle only on a deadline the fake honours,
                // exactly as the real dialog does, and count the dialog as open
                // until then: a refusal that leaves it open is the wedge.
                h.dialogsOpen += 1;
                const honoursSignal = acknowledgement !== "ignoresSignal";
                // The built-in timeout answers with the CURSOR position: index 0
                // is Yes, index 1 is No. "ignoresDefault" models a build that
                // ignores initialIndex, so its timeout answers Yes.
                const timeoutAnswer = acknowledgement === "ignoresDefault" ? true : options?.initialIndex !== 1;
                const { promise, resolve } = Promise.withResolvers<boolean>();
                const settle = (answer: boolean) => {
                  h.dialogsOpen -= 1;
                  resolve(answer);
                };
                if (honoursSignal && options?.signal) {
                  options.signal.addEventListener("abort", () => settle(false), { once: true });
                }
                if (options?.timeout !== undefined) {
                  setTimeout(() => settle(timeoutAnswer), options.timeout);
                }
                return await promise;
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
