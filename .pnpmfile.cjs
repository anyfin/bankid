// openapi-typescript, the type generator, is unmaintained and pinned to an
// exact version. It drives the TypeScript 5 compiler API, which TypeScript 7
// no longer ships, so it gets its own TypeScript 5.9 instead of the project's
// one. Only the generator uses this copy. See "The type generator" in
// docs/development.md.
function readPackage(pkg) {
  if (pkg.name === "openapi-typescript") {
    delete pkg.peerDependencies?.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: "5.9.3" };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
