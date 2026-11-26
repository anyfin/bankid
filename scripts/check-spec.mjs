// Compares spec/openapi-auth-sign.yaml with the file BankID currently
// publishes. BankID puts the revision in the file name, so the link is read
// from the published docs index instead of being hard-coded.
//
//   node scripts/check-spec.mjs [path-to-checked-in-spec]
//
// Exit codes: 0 identical, 1 different, 2 the check itself could not run.
// Set BANKID_DOCS_INDEX to read another copy of the docs index.
import { readFile } from "node:fs/promises";

const indexUrl =
  process.env.BANKID_DOCS_INDEX ??
  "https://developers.bankid.com/llms-full.txt";
const specPath =
  process.argv[2] ?? new URL("../spec/openapi-auth-sign.yaml", import.meta.url);

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  return response.text();
}

const revisionOf = yaml => /^ {2}version:\s*(\S+)\s*$/m.exec(yaml)?.[1];

try {
  const local = await readFile(specPath, "utf8");
  const index = await fetchText(indexUrl);
  const links = [
    ...new Set(
      index.match(/https?:\/\/[^\s)"']*\/openapi-auth-sign-[\w.-]+\.ya?ml/g) ??
        [],
    ),
  ];
  if (links.length !== 1) {
    throw new Error(
      `Expected one auth and sign spec link in ${indexUrl}, found ${links.length}.`,
    );
  }

  const [publishedUrl] = links;
  const published = await fetchText(publishedUrl);
  const localRevision = revisionOf(local);
  const publishedRevision = revisionOf(published);

  if (local === published) {
    console.log(
      `Spec is up to date: revision ${localRevision}, ${publishedUrl}`,
    );
    process.exit(0);
  }

  console.error("The checked-in spec differs from the one BankID publishes.");
  console.error(`  Published:  revision ${publishedRevision}, ${publishedUrl}`);
  console.error(`  Checked in: revision ${localRevision}`);
  console.error(
    localRevision === publishedRevision
      ? "  The revision is the same, but the content changed."
      : "  BankID has published a new revision.",
  );
  const localLines = new Set(local.split("\n"));
  const publishedLines = new Set(published.split("\n"));
  const added = [...publishedLines].filter(line => !localLines.has(line));
  const removed = [...localLines].filter(line => !publishedLines.has(line));
  console.error(`  Lines only in the published file: ${added.length}`);
  console.error(`  Lines only in the checked-in file: ${removed.length}`);
  for (const line of added.slice(0, 20)) console.error(`  + ${line}`);
  for (const line of removed.slice(0, 20)) console.error(`  - ${line}`);
  process.exit(1);
} catch (error) {
  console.error(`Could not check the spec: ${error.message}`);
  process.exit(2);
}
