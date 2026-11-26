import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStep, stepScript } from "./workflow-step.ts";
// @ts-expect-error: a plain JavaScript script without type declarations
import { checkClientImports } from "../scripts/check-client-imports.mjs";
// @ts-expect-error: a plain JavaScript script without type declarations
import * as generatedCheck from "../scripts/check-generated.mjs";

const { checkGenerated, generated, spec } = generatedCheck as {
  checkGenerated: (options?: {
    specFile?: string;
    target?: string;
  }) => string | undefined;
  generated: string;
  spec: string;
};

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

const temporary: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "bankid-tooling-"));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("check-package: client imports", () => {
  /** A fake client build whose chunk file holds `chunk`. */
  const clientBuild = (chunk: string) => {
    const dist = tempDir();
    writeFileSync(join(dist, "client.mjs"), 'export * from "./chunk.mjs";\n');
    writeFileSync(join(dist, "client.cjs"), 'require("./chunk.mjs");\n');
    writeFileSync(join(dist, "client.d.mts"), 'export * from "./chunk.mjs";\n');
    writeFileSync(join(dist, "client.d.cts"), "export {};\n");
    writeFileSync(join(dist, "chunk.mjs"), chunk);
    return dist;
  };

  it("passes a build that imports only its own files", () => {
    expect(checkClientImports(clientBuild("export const a = 1;\n"))).toBe(5);
  });

  it("does not read prose in a doc comment as an import", () => {
    const chunk = [
      "/**",
      " * - `phoneCall`: an order from `phone.auth`;",
      " * see the note from 'BankID' and import `x` from \"y\" in the guide.",
      " */",
      'import { a } from "./other.mjs";',
      "export { a };",
      "",
    ].join("\n");
    const dist = clientBuild(chunk);
    writeFileSync(join(dist, "other.mjs"), "export const a = 1;\n");
    expect(checkClientImports(dist)).toBe(6);
  });

  it("refuses the package's own server entry point", () => {
    expect(() =>
      checkClientImports(clientBuild('import { BankId } from "bankid";\n')),
    ).toThrow(/imports "bankid"/);
  });

  it("refuses any other package and any Node built-in", () => {
    for (const chunk of [
      'import x from "some-package";\n',
      'import { request } from "node:https";\n',
      'const fs = require("fs");\n',
      '/// <reference types="node" />\n',
    ]) {
      expect(() => checkClientImports(clientBuild(chunk))).toThrow(
        /may import only its own files/,
      );
    }
  });
});

describe("check:generated", () => {
  const copyOfGenerated = () => {
    const target = join(tempDir(), "auth-sign.ts");
    copyFileSync(join(root, generated), target);
    return target;
  };

  it("runs the check script", () => {
    const manifest = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["check:generated"]).toBe(
      "node scripts/check-generated.mjs",
    );
    // The check generates from the same spec into the same file as `generate`.
    expect(manifest.scripts.generate).toBe(
      `openapi-typescript ${spec} -o ${generated}`,
    );
  });

  it("passes when the file matches the spec", () => {
    expect(checkGenerated({ target: copyOfGenerated() })).toBeUndefined();
  }, 60_000);

  it("fails on a hand edit and leaves the edit in place", () => {
    const target = copyOfGenerated();
    appendFileSync(target, "// edited by hand\n");
    expect(checkGenerated({ target })).toMatch(/differs/);
    expect(readFileSync(target, "utf8")).toMatch(/edited by hand\n$/);
  }, 60_000);

  it("fails when the file is missing", () => {
    const target = join(tempDir(), "auth-sign.ts");
    expect(checkGenerated({ target })).toMatch(/missing/);
  });
});

describe("spec-drift workflow", () => {
  const workflow = read(".github/workflows/spec-drift.yml");

  it("passes the run URL to the issue step", () => {
    expect(workflow).toContain(
      "RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    );
  });

  // Runs the issue step on a report and returns the issue body it wrote.
  const issueBodyFor = (report: string, runUrl: string): string => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // A fake GitHub CLI: no open issue, and the body of what it writes is
    // saved to $GH_BODY.
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$2" in',
        '  list) case " $* " in *" --jq "*) ;; *) echo "[]" ;; esac ;;',
        '  create|comment) while [ $# -gt 0 ]; do [ "$1" = --body ] && printf %s "$2" > "$GH_BODY"; shift; done ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    // Steps may run the repository's scripts, from the working directory.
    cpSync(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "report.txt"), report);

    const { status, output } = runStep(
      stepScript(workflow, "Open an issue on a difference"),
      {
        cwd: dir,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GH_BODY: join(dir, "body.md"),
          GH_TOKEN: "unused",
          RUN_URL: runUrl,
        },
      },
    );
    expect(status, output).toBe(0);

    return readFileSync(join(dir, "body.md"), "utf8");
  };

  it("quotes a bounded excerpt of a long report and links to the run", () => {
    const runUrl = "https://github.com/owner/repo/actions/runs/1";
    const body = issueBodyFor(
      `The checked-in spec differs.\n  + ${"x".repeat(200_000)}\n`,
      runUrl,
    );
    expect(body.length).toBeLessThan(21_000);
    expect(body).toContain("The checked-in spec differs.");
    expect(body).toContain(runUrl);
  });

  it("fences the excerpt with more backticks than any run in it", () => {
    const body = issueBodyFor(
      "The checked-in spec differs.\n  + ```yaml\n  + ````\n",
      "https://github.com/owner/repo/actions/runs/1",
    );
    const fences = body.split("\n").filter(line => /^`+$/.test(line));
    expect(fences).toEqual(["`````", "`````"]);
    expect(body).toContain("  + ````\n`````");
  });
});
