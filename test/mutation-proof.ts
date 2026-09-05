// Mutation proof: rewrites the PRODUCTION file, runs `bun test`, and requires
// the suite to go red. Run with `bun test/mutation-proof.ts`.
//
// Every mutant must clear three checks before its result counts, because a
// mutation that silently fails to apply reports a green suite and looks exactly
// like a surviving mutant that nobody noticed:
//   1. the anchor text is present in the file as it stands,
//   2. the file ON DISK changes (sha256 compared, not assumed),
//   3. the original is restored afterwards and the sha256 matches the baseline.
//
// Mutants are SEMANTIC reversions - they break the property a guard protects -
// rather than deletions that would fail to compile and test the parser instead.

import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Mutant = { name: string; find: string; replace: string };

const SRC = join(import.meta.dir, "..", "src", "role-router.ts");

const MUTANTS: Mutant[] = [
  {
    name: "M1 resolve by role name instead of the mapped config key",
    find: "let selector = roles[configKey];",
    replace: "let selector = roles[role];",
  },
  {
    name: "M2 drop fable from ROLE_NAMES",
    find: '["default", "checkin", "incident", "fable"] as const',
    replace: '["default", "checkin", "incident"] as const',
  },
  {
    name: "M3 break a mapping whose config key was already lowercase",
    find: '  incident: "incident",',
    replace: '  incident: "INCIDENT",',
  },
  {
    name: "M4 widen the agent-facing tool enum to accept fable",
    find: 'pi.zod.enum(["incident"])',
    replace: 'pi.zod.enum(["incident", "fable"])',
  },
  {
    name: "M5 hardcode the /role usage list instead of deriving it",
    find: 'const ROLE_USAGE = `/role [${ROLE_NAMES.join("|")}]`;',
    replace: 'const ROLE_USAGE = "/role [default|checkin|incident]";',
  },
  {
    name: "M6 stop gating the scarce role on an interactive ingress",
    find: "const INTERACTIVE_ONLY_ROLES: Partial<Record<RoleName, true>> = {\n  fable: true,\n};",
    replace: "const INTERACTIVE_ONLY_ROLES: Partial<Record<RoleName, true>> = {};",
  },
  {
    name: "M7 fail OPEN when the runtime reports no provenance",
    find: 'return "hasUI" in ctx && ctx.hasUI === true && "mode" in ctx && ctx.mode === "tui";',
    replace: 'return "hasUI" in ctx ? ctx.hasUI === true && ctx.mode === "tui" : true;',
  },
  {
    name: "M8 accept a reported-but-false UI flag as interactive",
    find: 'ctx.hasUI === true && "mode" in ctx',
    replace: 'ctx.hasUI !== undefined && "mode" in ctx',
  },
  {
    name: "M9 trust the UI flag alone and ignore the mode (admits an rpc client)",
    find: 'return "hasUI" in ctx && ctx.hasUI === true && "mode" in ctx && ctx.mode === "tui";',
    replace: 'return "hasUI" in ctx && ctx.hasUI === true;',
  },
  {
    name: "M10 accept a switch that was never acknowledged",
    find: "    return answer === true;",
    replace: "    return true;",
  },
  {
    name: "M13 let the built-in timeout answer with its default (Yes)",
    find: "      initialIndex: 1,",
    replace: "      initialIndex: 0,",
  },
  {
    name: "M14 drop the abort, leaving only the dialog's own deadline",
    find: "      signal: controller.signal,",
    replace: "      signal: undefined,",
  },
  {
    name: "M15 treat a dialog that cannot be presented as an acknowledgement",
    find: "  } catch {\n    // A dialog that cannot be presented, or an abort surfaced as a throw, is a\n    // refusal - never an acknowledgement.\n    return false;",
    replace: "  } catch {\n    return true;",
  },
  {
    name: "M16 never bound the dialog at all, so silence wedges the session",
    find: "      timeout: windowMs + ACKNOWLEDGEMENT_GRACE_MS,\n      initialIndex: 1,\n      signal: controller.signal,",
    replace: "      initialIndex: 1,",
  },
  {
    name: "M17 re-resolve the selector after the acknowledgement",
    find: "    const target = resolved ?? resolveSelector(role);",
    replace: "    const target = resolveSelector(role);",
  },
  {
    name: "M18 activate without recording the gated activation",
    find: "          recordGatedActivation(ctx, requested, target);",
    replace: "          void requested;",
  },
  {
    name: "M19 proceed when the activation cannot be recorded",
    find: '            `@${requested} not activated: the activation could not be recorded (${String(error)}).`,\n            "error",\n          );\n          return;',
    replace: '            `@${requested} activation record failed (${String(error)}).`,\n            "error",\n          );',
  },
  {
    name: "M11 fail OPEN when the ui offers no way to acknowledge",
    find: '  if (!("confirm" in ui) || typeof ui.confirm !== "function") {\n    return false;\n  }',
    replace: '  if (!("confirm" in ui) || typeof ui.confirm !== "function") {\n    return true;\n  }',
  },
  {
    name: "M12 stop validating the requested role name",
    find: "  return ROLE_NAMES.some((role) => role === value);",
    replace: "  return value.length > 0;",
  },
];

type Outcome = { failed: boolean; summary: string };

// A nonzero exit is not by itself a kill: a mutant that fails to parse, or a
// loader error, also exits nonzero while testing nothing about the guard. Only
// a run that actually executed tests AND reported a failing one counts, so a
// mutant that breaks the build is rejected loudly instead of being scored.
async function runSuite(): Promise<Outcome & { executedTests: boolean }> {
  const result = await $`bun test`.cwd(join(import.meta.dir, "..")).quiet().nothrow();
  const text = new TextDecoder().decode(result.stderr) + new TextDecoder().decode(result.stdout);
  const lines = text.split("\n").map((line) => line.trim());
  const summary = lines.find((line) => /^Ran \d+ tests?/.test(line)) ?? "no summary line";
  const firstFailure = lines.find((line) => line.startsWith("(fail)"));
  const ran = /^Ran (\d+) tests?/.exec(summary);
  const executedTests = ran !== null && Number(ran[1]) > 0;
  return {
    failed: result.exitCode !== 0,
    summary: firstFailure ? `${firstFailure} | ${summary}` : summary,
    executedTests,
  };
}

const original = readFileSync(SRC, "utf8");
const baselineSha = Bun.SHA256.hash(original, "hex");

const baseline = await runSuite();
if (baseline.failed) {
  throw new Error(`baseline suite is RED (${baseline.summary}); a mutation proof against a red baseline proves nothing`);
}
if (!baseline.executedTests) {
  throw new Error(`baseline ran no tests (${baseline.summary}); there is nothing for a mutant to break`);
}
console.log(`baseline: green (${baseline.summary}), sha ${baselineSha.slice(0, 12)}`);

const survivors: string[] = [];
for (const mutant of MUTANTS) {
  if (!original.includes(mutant.find)) {
    throw new Error(`${mutant.name}: anchor not found in ${SRC}; the mutant would be a no-op`);
  }
  writeFileSync(SRC, original.replace(mutant.find, mutant.replace), "utf8");
  const appliedSha = Bun.SHA256.hash(readFileSync(SRC), "hex");
  if (appliedSha === baselineSha) {
    writeFileSync(SRC, original, "utf8");
    throw new Error(`${mutant.name}: file on disk unchanged, so the mutant never ran`);
  }

  const outcome = await runSuite();
  writeFileSync(SRC, original, "utf8");
  const restoredSha = Bun.SHA256.hash(readFileSync(SRC), "hex");
  if (restoredSha !== baselineSha) {
    throw new Error(`${mutant.name}: restore failed, ${SRC} is left mutated`);
  }
  if (!outcome.executedTests) {
    throw new Error(
      `${mutant.name}: the suite ran no tests (${outcome.summary}); the mutant broke the build instead of the behaviour, so it scores nothing`,
    );
  }

  console.log(`${outcome.failed ? "KILLED  " : "SURVIVED"} ${mutant.name} | applied ${appliedSha.slice(0, 12)} | ${outcome.summary}`);
  if (!outcome.failed) {
    survivors.push(mutant.name);
  }
}

if (survivors.length > 0) {
  throw new Error(`surviving mutants: ${survivors.join("; ")}`);
}
console.log(`all ${MUTANTS.length} mutants applied to disk and killed; ${SRC} restored at ${baselineSha.slice(0, 12)}`);
