// Packs the built package and checks it the way consumers will see it: the
// tarball holds only the build, README, LICENSE and package.json, every path
// in package.json's exports is in it, each fixture project imports all three
// entry points and must type-check, the client entry point must import
// nothing but its own files, and only the testing entry point may carry the
// test certificate.
//
//   node scripts/check-package.mjs [--keep <path>]
//
// --keep writes the checked tarball to <path>, so that exactly that file can
// be published.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  builds,
  checkClientImports,
  reachable,
} from "./check-client-imports.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const fixtures = join(root, "test/fixtures");
const tsc = join(root, "node_modules/typescript/bin/tsc");
const tsc49 = join(root, "node_modules/typescript-4.9/bin/tsc");

const run = (cmd, args, cwd) => {
  console.log(`$ ${[cmd, ...args].join(" ")}  (in ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
};

// The test certificate is embedded in bankid/testing only. Look for the start
// of its base64 text in everything the other entry points reach.
const checkTestCertificateOnlyInTesting = () => {
  const needle = readFileSync(join(root, "cert/FPTestcert5_20240610.p12"))
    .toString("base64")
    .slice(0, 64);
  const contains = files =>
    [...files].filter(([, { source }]) => source.includes(needle));
  const leaks = contains(
    reachable(dist, [...builds("index"), ...builds("client")]),
  );
  if (leaks.length > 0)
    throw new Error(
      `the test certificate is reachable from bankid or bankid/client: ${leaks.map(([file]) => file).join(", ")}`,
    );
  for (const build of ["testing.mjs", "testing.cjs"]) {
    if (contains(reachable(dist, [build])).length === 0)
      throw new Error(`the test certificate is missing from ${build}`);
  }
  console.log("the test certificate is reachable from bankid/testing only");
};

// The tarball's file list, without npm's "package/" prefix.
const tarballFiles = tarball =>
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(line => line !== "" && !line.endsWith("/"))
    .map(line => line.replace(/^package\//, ""))
    .sort();

const allowedInTarball = file =>
  file.startsWith("dist/") ||
  ["package.json", "README.md", "LICENSE"].includes(file);

const exportTargets = value =>
  typeof value === "string"
    ? [value]
    : Object.values(value ?? {}).flatMap(exportTargets);

const checkTarballContents = files => {
  console.log(`Tarball contents (${files.length} files):`);
  for (const file of files) console.log(`  ${file}`);
  const unexpected = files.filter(file => !allowedInTarball(file));
  if (unexpected.length > 0)
    throw new Error(
      `the tarball holds files outside dist/, README.md, LICENSE and package.json: ${unexpected.join(", ")}`,
    );
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!files.includes(required))
      throw new Error(`the tarball is missing ${required}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const targets = new Set(
    [
      manifest.main,
      manifest.module,
      manifest.types,
      ...exportTargets(manifest.exports),
      ...exportTargets(manifest.typesVersions),
    ]
      .filter(target => target !== undefined)
      .map(target => target.replace(/^\.\//, "")),
  );
  const missing = [...targets].filter(target => !files.includes(target));
  if (missing.length > 0)
    throw new Error(
      `package.json points at files the tarball lacks: ${missing.join(", ")}`,
    );
  console.log(
    `the tarball holds only allowed files, and all ${targets.size} paths in package.json resolve`,
  );
};

const keepIndex = process.argv.indexOf("--keep");
const keep = keepIndex === -1 ? undefined : process.argv[keepIndex + 1];
if (keepIndex !== -1 && keep === undefined)
  throw new Error("--keep needs a path");

console.log(
  `bankid/client imports only its own files (${checkClientImports(dist)} files checked)`,
);
checkTestCertificateOnlyInTesting();

// Fixtures run in a temporary directory, so nothing resolves from this
// repository's node_modules.
const work = mkdtempSync(join(tmpdir(), "bankid-pack-"));
try {
  const tarball = join(work, "bankid.tgz");
  run("pnpm", ["pack", "--out", tarball], root);
  checkTarballContents(tarballFiles(tarball));
  run("tar", ["-xzf", tarball, "-C", work], root);

  const checks = [
    ["esm", tsc],
    ["esm", tsc49],
    ["cjs", tsc],
    ["cjs", tsc49],
    ["ts4.9", tsc49],
  ];
  for (const name of new Set(checks.map(([n]) => n))) {
    const dir = join(work, "fixtures", name);
    cpSync(join(fixtures, name), dir, { recursive: true });
    cpSync(join(work, "package"), join(dir, "node_modules/bankid"), {
      recursive: true,
    });
    cpSync(
      join(root, "cert/FPTestcert5_20240610.p12"),
      join(dir, "FPTestcert5_20240610.p12"),
    );
  }
  for (const [name, compiler] of checks) {
    run(process.execPath, [compiler, "-p", "."], join(work, "fixtures", name));
  }
  run(process.execPath, ["index.mjs"], join(work, "fixtures/esm"));
  run(process.execPath, ["index.cjs"], join(work, "fixtures/cjs"));
  if (keep !== undefined) {
    cpSync(tarball, resolve(keep));
    console.log(`Kept the checked tarball as ${resolve(keep)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("Package checks passed");
