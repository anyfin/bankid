// Opens a GitHub issue for a failed scheduled check, or comments on the open
// issue with the same title, so a check that keeps failing keeps one issue.
// Needs the GitHub CLI with GH_TOKEN set.
//
//   node scripts/report-issue.mjs --title <title> --body-file <path> [--dry-run]
//
// --dry-run looks up the open issues and prints what it would do instead of
// writing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// GitHub refuses issue and comment bodies over 65536 characters.
const maxBody = 60_000;

/**
 * Comments on the open issue titled `title`, or opens one. `gh` runs the
 * GitHub CLI with the given arguments and returns its output.
 *
 * @param {{ title: string, body: string, gh: (args: string[]) => string, dryRun?: boolean }} options
 * @returns {{ action: "comment" | "create", issue?: number, args: string[] }}
 */
export function reportIssue({ title, body, gh, dryRun = false }) {
  const open = JSON.parse(
    gh([
      "issue",
      "list",
      "--state",
      "open",
      "--search",
      `"${title}" in:title`,
      "--json",
      "number,title",
      "--limit",
      "100",
    ]),
  );
  // The search matches words, so keep only an exact title, and the oldest.
  const existing = open
    .filter(issue => issue.title === title)
    .sort((a, b) => a.number - b.number)[0];
  const text =
    body.length > maxBody ? `${body.slice(0, maxBody)}\n\n(truncated)` : body;
  const plan = existing
    ? {
        action: "comment",
        issue: existing.number,
        args: ["issue", "comment", String(existing.number), "--body", text],
      }
    : {
        action: "create",
        args: ["issue", "create", "--title", title, "--body", text],
      };
  if (!dryRun) gh(plan.args);
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argument = name => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const title = argument("--title");
  const bodyFile = argument("--body-file");
  if (!title || !bodyFile) {
    console.error(
      "usage: node scripts/report-issue.mjs --title <title> --body-file <path> [--dry-run]",
    );
    process.exit(2);
  }
  const dryRun = process.argv.includes("--dry-run");
  const plan = reportIssue({
    title,
    body: readFileSync(bodyFile, "utf8"),
    dryRun,
    gh: args => execFileSync("gh", args, { encoding: "utf8" }),
  });
  const what =
    plan.action === "comment"
      ? `comment on open issue #${plan.issue}`
      : "open a new issue";
  console.log(dryRun ? `Dry run: would ${what}.` : `Done: ${what}.`);
}
