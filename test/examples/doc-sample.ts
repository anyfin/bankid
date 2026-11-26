// Loads a code sample from the documentation as a module, so a test can run
// the sample itself rather than a copy. Imports of "bankid" and
// "bankid/client" point to the sources, and "./bankid.js" to a client that
// forwards every call to `globalThis.readmeBankId`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error: a plain JavaScript script without type declarations
import { extractSamples } from "../../scripts/check-docs.mjs";

const root = resolve(import.meta.dirname, "../..");

/**
 * Imports the first `ts` sample in `document` (relative to the repository)
 * whose code contains `marker`.
 */
export const loadDocSample = async <T>(
  document: string,
  marker: string,
): Promise<T> => {
  const markdown = readFileSync(join(root, document), "utf8");
  const sample = (extractSamples(markdown) as { code: string }[]).find(
    ({ code }) => code.includes(marker),
  );
  if (sample === undefined)
    throw new Error(`no sample with ${marker} in ${document}`);
  const dir = mkdtempSync(join(tmpdir(), "bankid-doc-sample-"));
  try {
    writeFileSync(
      join(dir, "bankid.ts"),
      "export const bankid = new Proxy({}, { get: (_, key) => globalThis.readmeBankId[key] });\n",
    );
    writeFileSync(
      join(dir, "sample.ts"),
      sample.code
        .replace(
          /from "bankid"/g,
          `from ${JSON.stringify(join(root, "src/index.ts"))}`,
        )
        .replace(
          /from "bankid\/client"/g,
          `from ${JSON.stringify(join(root, "src/client/index.ts"))}`,
        )
        .replace(/from "\.\/bankid\.js"/g, 'from "./bankid.ts"'),
    );
    return (await import(join(dir, "sample.ts"))) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
