import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript script without type declarations
import { extractSamples, missingFromGuide } from "../scripts/check-docs.mjs";

describe("check-docs: extractSamples", () => {
  it("takes ts blocks with their first code line, kind and file name", () => {
    const markdown = [
      "# Title", // 1
      "", // 2
      "```ts", // 3
      "const a = 1;", // 4
      "```", // 5
      "", // 6
      "```ts file=bankid.ts", // 7
      'export const b = "b";', // 8
      "```", // 9
      "```ts v3", // 10
      "old();", // 11
      "```", // 12
    ].join("\n");
    expect(extractSamples(markdown)).toEqual([
      { kind: "v4", file: undefined, line: 4, code: "const a = 1;" },
      { kind: "v4", file: "bankid.ts", line: 8, code: 'export const b = "b";' },
      { kind: "v3", file: undefined, line: 11, code: "old();" },
    ]);
  });

  it("skips other languages, including ts inside them", () => {
    const markdown = [
      "````md",
      "```ts",
      "not checked",
      "```",
      "````",
      "```sh",
      "npm install bankid",
      "```",
      "```js",
      "require('bankid')",
      "```",
    ].join("\n");
    expect(extractSamples(markdown)).toEqual([]);
  });

  it("refuses an unclosed fence and a file name with a path", () => {
    expect(() => extractSamples("```ts\nconst a = 1;\n")).toThrow(
      "unclosed code fence at line 1",
    );
    expect(() => extractSamples("```ts file=../x.ts\n```\n")).toThrow(
      "file= must be a plain name",
    );
  });
});

describe("check-docs: missingFromGuide", () => {
  const surface = {
    exports: ["QrGenerator", "BankIdError"],
    members: ["collect", "awaitPendingCollect"],
    options: ["production"],
  };

  it("accepts exports and options as code, and members as calls", () => {
    const guide =
      "| `QrGenerator` | `BankIdError` | `production` | `client.collect({ orderRef })` | `awaitPendingCollect()` |";
    expect(missingFromGuide(surface, guide)).toEqual([]);
  });

  it("reports names that appear only as prose or inside other names", () => {
    const guide =
      "QrGenerator and production are gone. `BankIdErrorCode` `recollect()`";
    expect(missingFromGuide(surface, guide)).toEqual([
      "QrGenerator",
      "BankIdError",
      "production",
      "collect",
      "awaitPendingCollect",
    ]);
  });
});
