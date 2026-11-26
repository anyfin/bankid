// Checks the documentation against the code, so it cannot go stale:
//
// 1. Every fenced `ts` block in README.md and docs/*.md is type-checked
//    against the built package, as a consumer would import it. Blocks fenced
//    `ts v3` are type-checked against bankid 3.2.1 instead, so the "before"
//    half of the migration guide is checked too.
// 2. A deliberately broken sample (test/fixtures/docs/broken.md) must fail,
//    so a check that passes everything is caught.
// 3. docs/migrating-from-v3.md names every export of bankid 3.2.1, every
//    member of its classes and every client option.
//
//   node scripts/check-docs.mjs
//
// Run it after `pnpm build`. Conventions for samples:
// - Each block is its own module. A block without an import or export is made
//   one, so names never leak between blocks.
// - `ts file=<name>.ts` gives the block a file name. Other blocks of the same
//   kind (4.0 or v3) can then import it as "./<name>.js", in any document.
//   Use this for shared setup, such as creating the client.
// - Anything that should not be checked uses another language: `sh`, `text`,
//   `json`, or `js` for plain JavaScript.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const tsc = join(root, "node_modules/typescript/bin/tsc");

/**
 * The fenced code blocks of a Markdown document that are checked.
 *
 * @param {string} markdown
 * @returns {{ kind: "v4" | "v3", file: string | undefined, line: number, code: string }[]}
 *   `line` is the 1-based line of the block's first code line.
 */
export function extractSamples(markdown) {
  const samples = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*(\S*)(.*)$/.exec(lines[i] ?? "");
    if (open === null) continue;
    const [, indent, fence, lang, rest] = open;
    const end = lines.findIndex(
      (line, j) =>
        j > i &&
        line.startsWith(indent) &&
        line.trim().startsWith(fence) &&
        line.trim().replace(/[`~]/g, "") === "",
    );
    if (end === -1) throw new Error(`unclosed code fence at line ${i + 1}`);
    if (lang === "ts" || lang === "typescript") {
      const words = rest.trim().split(/\s+/).filter(Boolean);
      const file = words.find(word => word.startsWith("file="))?.slice(5);
      if (file !== undefined && !/^[\w-]+\.ts$/.test(file))
        throw new Error(
          `line ${i + 1}: file= must be a plain name ending in .ts`,
        );
      samples.push({
        kind: words.includes("v3") ? "v3" : "v4",
        file,
        line: i + 2,
        code: lines
          .slice(i + 1, end)
          .map(line => line.slice(indent.length))
          .join("\n"),
      });
    }
    i = end;
  }
  return samples;
}

const isModule = code => /^\s*(import|export)\s/m.test(code);

const symlink = (target, path) => {
  mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(realpathSync(target), path, "dir");
};

const tsconfig = {
  compilerOptions: {
    target: "es2023",
    lib: ["es2023", "dom", "dom.iterable"],
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
  },
  include: ["samples"],
};

/**
 * Type-checks the samples of the given Markdown files in a temporary project
 * per kind. Returns the compiler output with each generated file name turned
 * back into the Markdown file and line it came from.
 *
 * @param {string[]} markdownFiles absolute paths
 * @param {string} work an empty directory
 * @returns {{ ok: boolean, count: number, output: string }}
 */
export function checkSamples(markdownFiles, work) {
  const projects = {
    v4: { dir: join(work, "v4"), files: new Map() },
    v3: { dir: join(work, "v3"), files: new Map() },
  };
  const origin = new Map();
  let count = 0;
  for (const path of markdownFiles) {
    const name = relative(root, path);
    for (const sample of extractSamples(readFileSync(path, "utf8"))) {
      const project = projects[sample.kind];
      const file =
        sample.file ??
        // The compiler skips files whose names start with a dot.
        `${name.replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "")}.L${sample.line}.ts`;
      if (project.files.has(file))
        throw new Error(
          `${name}:${sample.line}: ${file} is already defined by ${origin.get(`${sample.kind}/${file}`).name}`,
        );
      // Pad with blank lines, so the compiler's line numbers are the
      // Markdown file's.
      const padded =
        "\n".repeat(sample.line - 1) +
        sample.code +
        (isModule(sample.code) ? "\n" : "\nexport {};\n");
      project.files.set(file, padded);
      origin.set(`${sample.kind}/${file}`, { name, line: sample.line });
      count++;
    }
  }

  let ok = true;
  let output = "";
  for (const [kind, project] of Object.entries(projects)) {
    if (project.files.size === 0) continue;
    const samples = join(project.dir, "samples");
    mkdirSync(samples, { recursive: true });
    for (const [file, code] of project.files)
      writeFileSync(join(samples, file), code);
    writeFileSync(
      join(project.dir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    writeFileSync(
      join(project.dir, "tsconfig.json"),
      JSON.stringify(tsconfig, null, 2),
    );
    symlink(
      join(root, "node_modules/@types/node"),
      join(project.dir, "node_modules/@types/node"),
    );
    if (kind === "v4") {
      // The package as published: package.json and the build.
      const pkg = join(project.dir, "node_modules/bankid");
      mkdirSync(pkg, { recursive: true });
      cpSync(join(root, "package.json"), join(pkg, "package.json"));
      cpSync(join(root, "dist"), join(pkg, "dist"), { recursive: true });
    } else {
      symlink(
        join(root, "node_modules/bankid-v3"),
        join(project.dir, "node_modules/bankid"),
      );
    }
    try {
      execFileSync(process.execPath, [tsc, "-p", "."], {
        cwd: project.dir,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      ok = false;
      const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      output += text.replace(
        /samples\/([^\s(:]+\.ts)[(:](\d+)[,:](\d+)\)?/g,
        (match, file, line, column) => {
          const from = origin.get(`${kind}/${file}`);
          return from === undefined
            ? match
            : `${from.name}:${line}:${column} (${kind} sample at line ${from.line})`;
        },
      );
    }
  }
  return { ok, count, output };
}

/**
 * Names the migration guide must mention, read from bankid 3.2.1's
 * declarations: its exports, the members of its classes and its options.
 *
 * @param {string} lib the directory holding bankid 3.2.1's .d.ts files
 * @returns {{ exports: string[], members: string[], options: string[] }}
 */
export function v3Surface(lib) {
  const exports = new Set();
  const members = new Set();
  const options = new Set();
  for (const file of readdirSync(lib).filter(f => f.endsWith(".d.ts"))) {
    const source = readFileSync(join(lib, file), "utf8");
    for (const [, name] of source.matchAll(
      /^export (?:declare )?(?:interface|type|enum|const|class) (\w+)/gm,
    ))
      exports.add(name);
    for (const [, body] of source.matchAll(
      /^export declare class \w+[^{]*\{\n([\s\S]*?)^\}/gm,
    ))
      for (const [, name] of body.matchAll(
        /^ {4}(?:static )?(?:readonly )?(\w+)[?(:]/gm,
      ))
        if (name !== "constructor") members.add(name);
    for (const [, body] of source.matchAll(
      /^(?:interface (?:BankIdClientSettings\w*|QRGenerateOptions)[^{]*|export type QrGeneratorOptions =[^{]*)\{\n([\s\S]*?)^\}/gm,
    ))
      for (const [, name] of body.matchAll(/^ {4}(\w+)\??:/gm))
        options.add(name);
    // The second branch of the QrGeneratorOptions union.
    for (const [, name] of source.matchAll(/^\} \| \{\n {4}(\w+)\??:/gm))
      options.add(name);
  }
  return {
    exports: [...exports].sort((a, b) => a.localeCompare(b)),
    members: [...members].sort((a, b) => a.localeCompare(b)),
    options: [...options].sort((a, b) => a.localeCompare(b)),
  };
}

/** The names in the guide that are written as code, without decoration. */
const codeSpans = markdown =>
  [...markdown.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span);

/**
 * The names from {@link v3Surface} that the guide does not mention as code.
 * An export or option must be a code span of its own, such as `QrGenerator`;
 * a member may also be written as a call or property, such as
 * `client.collect({ orderRef })` or `collect()`.
 */
export function missingFromGuide(surface, markdown) {
  const spans = codeSpans(markdown);
  const exact = new Set(spans.map(span => span.trim()));
  const missing = [];
  for (const name of [...surface.exports, ...surface.options])
    if (!exact.has(name)) missing.push(name);
  for (const name of surface.members) {
    const pattern = new RegExp(`(^|\\.)${name}\\b`);
    if (!spans.some(span => pattern.test(span.trim()))) missing.push(name);
  }
  return missing;
}

const main = () => {
  const docs = [
    join(root, "README.md"),
    ...readdirSync(join(root, "docs"))
      .filter(file => file.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b))
      .map(file => join(root, "docs", file)),
  ];
  const work = mkdtempSync(join(tmpdir(), "bankid-docs-"));
  try {
    const result = checkSamples(docs, join(work, "docs"));
    if (!result.ok) {
      console.error(result.output);
      throw new Error("a code sample in the documentation does not compile");
    }
    console.log(
      `${result.count} code samples in ${docs.map(d => relative(root, d)).join(", ")} type-check`,
    );

    const broken = join(root, "test/fixtures/docs/broken.md");
    const negative = checkSamples([broken], join(work, "broken"));
    const brokenName = relative(root, broken);
    if (negative.ok || !negative.output.includes(`${brokenName}:`))
      throw new Error(
        `${brokenName} should fail to type-check with an error pointing into it, but got:\n${negative.output || "no errors"}`,
      );
    console.log(
      `the deliberately broken sample fails as it should:\n${negative.output.trim()}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const guide = "docs/migrating-from-v3.md";
  const surface = v3Surface(join(root, "node_modules/bankid-v3/lib"));
  const missing = missingFromGuide(
    surface,
    readFileSync(join(root, guide), "utf8"),
  );
  if (missing.length > 0)
    throw new Error(
      `${guide} does not mention these names from bankid 3.2.1: ${missing.join(", ")}`,
    );
  console.log(
    `${guide} covers bankid 3.2.1: ${surface.exports.length} exports, ${surface.members.length} class members, ${surface.options.length} options`,
  );
  console.log("Docs checks passed");
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
