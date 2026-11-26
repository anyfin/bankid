// The client entry point runs in browsers and has no dependencies, so the
// files its build reaches may import only each other: a Node built-in, this
// package's own "bankid" entry or any other package is an error.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Static imports and exports count only at the start of a statement, so prose
// such as "an order from `x`" in a doc comment is not read as an import.
const specifier =
  /(?:(?:^|;)\s*(?:import|export)\b[^;]*?\bfrom\s*|(?:^|;)\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\/\/\/\s*<reference\s+types=)["']([^"']+)["']/gm;

/**
 * Every built file in `dist` that the given entry files reach through
 * relative imports, with its source and the specifiers it imports.
 *
 * @param {string} dist
 * @param {string[]} entries
 * @returns {Map<string, { source: string, specs: string[] }>}
 */
export function reachable(dist, entries) {
  const files = new Map();
  const visit = file => {
    if (files.has(file)) return;
    const source = readFileSync(file, "utf8");
    const specs = [...source.matchAll(specifier)].map(([, spec]) => spec);
    files.set(file, { source, specs });
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      // Declaration files import "./x.mjs" and mean "./x.d.mts".
      const declaration = target.replace(/\.([mc]?)js$/, ".d.$1ts");
      if (existsSync(target)) visit(target);
      else if (/\.d\.[mc]?ts$/.test(file) && existsSync(declaration))
        visit(declaration);
      else throw new Error(`${file} imports missing file "${spec}"`);
    }
  };
  for (const entry of entries) visit(join(dist, entry));
  return files;
}

/** The four build files of the entry point `name`. */
export const builds = name => [
  `${name}.mjs`,
  `${name}.cjs`,
  `${name}.d.mts`,
  `${name}.d.cts`,
];

/**
 * Throws unless every file reachable from the client build in `dist` imports
 * only relative paths that exist. Returns the number of files checked.
 *
 * @param {string} dist
 * @returns {number}
 */
export function checkClientImports(dist) {
  const files = reachable(dist, builds("client"));
  for (const [file, { specs }] of files) {
    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        throw new Error(
          `${file} imports "${spec}"; bankid/client may import only its own files`,
        );
      }
    }
  }
  return files.size;
}
