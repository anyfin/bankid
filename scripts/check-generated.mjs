// Checks that the generated types match what `pnpm generate` makes from the
// checked-in spec. It generates into a temporary directory and compares byte
// for byte, so it never touches the file it checks.
//
//   node scripts/check-generated.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

/** The spec and the file generated from it, as `pnpm generate` names them. */
export const spec = "spec/openapi-auth-sign.yaml";
export const generated = "src/generated/auth-sign.ts";

/**
 * Generates from `specFile` into a temporary file and compares it with
 * `target`. Returns a message saying why they differ, or undefined if they
 * are identical.
 *
 * @param {{ specFile?: string, target?: string }} [options]
 * @returns {string | undefined}
 */
export function checkGenerated({
  specFile = join(root, spec),
  target = join(root, generated),
} = {}) {
  if (!existsSync(target)) return `${target} is missing`;
  const work = mkdtempSync(join(tmpdir(), "bankid-generated-"));
  try {
    const fresh = join(work, "generated.ts");
    execFileSync(
      join(root, "node_modules/.bin/openapi-typescript"),
      [specFile, "-o", fresh],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
    );
    return readFileSync(fresh).equals(readFileSync(target))
      ? undefined
      : `${target} differs from what the spec generates`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problem = checkGenerated();
  if (problem !== undefined) {
    console.error(`${problem}. Run \`pnpm generate\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${generated} matches ${spec}`);
}
