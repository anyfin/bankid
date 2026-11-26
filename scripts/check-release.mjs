// Decides whether a release may be published, and under which npm dist-tag.
// Run by the release workflow before anything is built.
//
//   node scripts/check-release.mjs
//
// Reads GITHUB_REPOSITORY, and for a real release RELEASE_TAG and
// RELEASE_PRERELEASE ("true" or "false"). Set DRY_RUN=true for a dry run, which
// reports problems as warnings. Writes dist-tag to GITHUB_OUTPUT when set.
//
// A real release is refused when:
// - the tag is not package.json's version (with or without a leading "v"),
// - the version is not SemVer, or has build metadata (`+...`),
// - the release's prerelease flag disagrees with the version's prerelease
//   part,
// - the repository is not anyfin/bankid, or package.json's repository URL
//   does not point at it on github.com, so a fork or a private working copy
//   cannot publish by accident.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// SemVer 2.0.0: major.minor.patch, an optional prerelease part after "-" and
// optional build metadata after "+". The publish job in release.yml carries a
// copy, since it runs no repository code; a test keeps the two the same.
export const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The only repository that publishes. */
export const publicRepository = "anyfin/bankid";

/**
 * Whether `url` points at the public repository: host github.com and path
 * /anyfin/bankid, with or without ".git". The publish job in release.yml
 * applies the same rule; a test keeps the two the same.
 */
export const isPublicRepositoryUrl = url => {
  let parsed;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return false;
  }
  return (
    parsed.host === "github.com" &&
    /^\/anyfin\/bankid(?:\.git)?$/i.test(parsed.pathname)
  );
};

/**
 * @param {{ manifest: { version: string, repository?: string | { url?: string } }, repository?: string, tag?: string, prerelease?: string, dryRun: boolean }} input
 * @returns {{ distTag: "next" | "latest", problems: string[] }}
 */
export function checkRelease({
  manifest,
  repository,
  tag,
  prerelease,
  dryRun,
}) {
  const { version } = manifest;
  const parsed = semver.exec(version);
  // Only the prerelease part decides; a "-" in build metadata does not. A
  // version that does not parse is refused below and would go to "next".
  const isPrerelease = parsed === null || parsed[4] !== undefined;
  const distTag = isPrerelease ? "next" : "latest";
  const problems = [];

  const url =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository?.url;
  if (!isPublicRepositoryUrl(url))
    problems.push(
      `package.json's repository URL ${url || "(none)"} is not https://github.com/${publicRepository}`,
    );
  if ((repository ?? "").toLowerCase() !== publicRepository)
    problems.push(
      `this repository is ${repository || "unknown"}; publish from ${publicRepository}`,
    );

  if (!dryRun) {
    if (parsed === null)
      problems.push(`version ${version} is not a SemVer version`);
    else if (parsed[5] !== undefined)
      problems.push(
        `version ${version} has build metadata, which a release cannot have`,
      );
    if (tag !== version && tag !== `v${version}`)
      problems.push(
        `release tag ${tag || "(none)"} does not match package.json version ${version}`,
      );
    if (parsed !== null && prerelease !== String(isPrerelease))
      problems.push(
        `the release is ${prerelease === "true" ? "" : "not "}marked as a prerelease, but version ${version} is ${isPrerelease ? "" : "not "}a prerelease`,
      );
  }
  return { distTag, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const dryRun = process.env.DRY_RUN === "true";
  const { distTag, problems } = checkRelease({
    manifest,
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.RELEASE_TAG,
    prerelease: process.env.RELEASE_PRERELEASE,
    dryRun,
  });
  console.log(
    `${manifest.name}@${manifest.version} would publish under the "${distTag}" dist-tag${dryRun ? " (dry run)" : ""}.`,
  );
  for (const problem of problems)
    console.log(`${dryRun ? "Warning" : "Refused"}: ${problem}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `dist-tag=${distTag}\n`);
  if (problems.length > 0 && !dryRun) process.exit(1);
}
