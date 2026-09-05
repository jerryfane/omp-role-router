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
    find: 'return "hasUI" in ctx && ctx.hasUI === true;',
    replace: 'return "hasUI" in ctx ? ctx.hasUI === true : true;',
  },
  {
    name: "M8 accept a reported-but-false UI flag as interactive",
    find: 'return "hasUI" in ctx && ctx.hasUI === true;',
    replace: 'return "hasUI" in ctx && ctx.hasUI !== undefined;',
  },
];

async function suiteFails(): Promise<{ failed: boolean; summary: string }> {
  const result = await $`bun test`.cwd(join(import.meta.dir, "..")).quiet().nothrow();
  const text = new TextDecoder().decode(result.stderr) + new TextDecoder().decode(result.stdout);
  const summary = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith("fail") || line.includes(" fail")) ?? "no summary line";
  return { failed: result.exitCode !== 0, summary };
}

const original = readFileSync(SRC, "utf8");
const baselineSha = Bun.SHA256.hash(original, "hex");

const baseline = await suiteFails();
if (baseline.failed) {
  throw new Error(`baseline suite is RED (${baseline.summary}); a mutation proof against a red baseline proves nothing`);
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

  const outcome = await suiteFails();
  writeFileSync(SRC, original, "utf8");
  const restoredSha = Bun.SHA256.hash(readFileSync(SRC), "hex");
  if (restoredSha !== baselineSha) {
    throw new Error(`${mutant.name}: restore failed, ${SRC} is left mutated`);
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
