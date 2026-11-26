// Checks that every public export has a doc comment, as consumers see it in
// their editor: it reads the built declarations of the three entry points and
// fails for any export whose declaration has no documentation.
//
//   node scripts/check-doc-comments.mjs
//
// Run it after `pnpm build`. It uses the TypeScript 4.9 compiler API, which the
// repository already installs for the TypeScript 4.9 fixture.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const ts = createRequire(import.meta.url)(
  join(root, "node_modules/typescript-4.9"),
);

const entryPoints = {
  bankid: "dist/index.d.mts",
  "bankid/client": "dist/client.d.mts",
  "bankid/testing": "dist/testing.d.mts",
};

/**
 * The exports of each entry point that have no doc comment.
 *
 * @param {Record<string, string>} entries entry point name to absolute path
 * @returns {{ entry: string, name: string }[]}
 */
export function undocumentedExports(entries) {
  const program = ts.createProgram(Object.values(entries), {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const missing = [];
  for (const [entry, file] of Object.entries(entries)) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`cannot read ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      const documented =
        symbol.getDocumentationComment(checker).length > 0 ||
        (symbol.declarations ?? []).some(
          declaration => ts.getJSDocCommentsAndTags(declaration).length > 0,
        );
      if (!documented) missing.push({ entry, name: exported.name });
    }
  }
  return missing;
}

const main = () => {
  const entries = Object.fromEntries(
    Object.entries(entryPoints).map(([entry, file]) => [
      entry,
      join(root, file),
    ]),
  );
  const missing = undocumentedExports(entries);
  if (missing.length > 0) {
    for (const { entry, name } of missing)
      console.error(`${entry}: ${name} has no doc comment`);
    throw new Error(`${missing.length} public exports have no doc comment`);
  }
  console.log(
    `every export of ${Object.keys(entryPoints).join(", ")} has a doc comment`,
  );
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
