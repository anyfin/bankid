import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BankIdApiError, BankIdTransportError } from "../src/index.ts";
import { testRootCa } from "../src/root-ca.ts";
import {
  errorMessages,
  failedMessages,
  pendingMessages,
} from "../src/shared/describe.ts";
import { createTlsFixtures, type TlsFixtures } from "./tls-fixtures.ts";
import { runStep, stepScript } from "./workflow-step.ts";
// @ts-expect-error: a plain JavaScript script without type declarations
import { checkRelease, semver } from "../scripts/check-release.mjs";
// @ts-expect-error: a plain JavaScript script without type declarations
import * as liveCheck from "../scripts/live-check-report.mjs";
// @ts-expect-error: a plain JavaScript script without type declarations
import { reportIssue } from "../scripts/report-issue.mjs";

const {
  describeError,
  errorFacts,
  issueBody,
  knownCodes,
  phoneStep,
  redactor,
  serverChain,
  stepIds,
  stepResult,
} = liveCheck as {
  describeError: (error: unknown) => string;
  errorFacts: (error: unknown) => { status?: unknown; code?: unknown };
  issueBody: (result: unknown, runUrl?: string) => string;
  knownCodes: string[];
  phoneStep: (env: Record<string, string | undefined>) => unknown;
  redactor: (personalNumber: string | undefined) => (text: string) => string;
  stepIds: string[];
  stepResult: (input: unknown) => {
    step: string;
    outcome: string;
    status?: number;
    code?: string;
  };
  serverChain: (options: {
    host: string;
    port?: number;
    ca: string;
  }) => Promise<{ subject: string }[]>;
};

/** A fake GitHub CLI over an in-memory list of issues. */
const fakeGh = () => {
  const issues: { number: number; title: string; comments: string[] }[] = [];
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    const [, command] = args;
    if (command === "list")
      return JSON.stringify(
        issues.map(({ number, title }) => ({ number, title })),
      );
    if (command === "create") {
      issues.push({
        number: issues.length + 1,
        title: args[args.indexOf("--title") + 1] ?? "",
        comments: [],
      });
      return "";
    }
    if (command === "comment") {
      issues
        .find(issue => issue.number === Number(args[2]))
        ?.comments.push(args[args.indexOf("--body") + 1] ?? "");
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, issues, calls };
};

describe("report-issue", () => {
  const title = "Scheduled check failed";

  it("opens one issue, then comments on it on later failures", () => {
    const { gh, issues } = fakeGh();
    expect(reportIssue({ title, body: "night 1", gh }).action).toBe("create");
    expect(reportIssue({ title, body: "night 2", gh })).toMatchObject({
      action: "comment",
      issue: 1,
    });
    reportIssue({ title, body: "night 3", gh });
    expect(issues).toEqual([
      { number: 1, title, comments: ["night 2", "night 3"] },
    ]);
  });

  it("ignores open issues whose title only contains the words", () => {
    const { gh, issues } = fakeGh();
    issues.push({ number: 7, title: `Re: ${title}`, comments: [] });
    expect(reportIssue({ title, body: "x", gh }).action).toBe("create");
    expect(issues.map(issue => issue.title)).toEqual([`Re: ${title}`, title]);
  });

  it("writes nothing in a dry run", () => {
    const { gh, issues, calls } = fakeGh();
    expect(reportIssue({ title, body: "x", gh, dryRun: true }).action).toBe(
      "create",
    );
    expect(issues).toEqual([]);
    expect(calls.map(args => args[1])).toEqual(["list"]);
  });

  it("truncates a body GitHub would refuse", () => {
    const { gh, issues } = fakeGh();
    issues.push({ number: 1, title, comments: [] });
    reportIssue({ title, body: "x".repeat(70_000), gh });
    expect(issues[0]?.comments[0]?.length).toBeLessThan(65_536);
  });
});

describe("live-check report", () => {
  const personalNumber = "190010101010";

  it("reports an API error by code and status, never its details", () => {
    const error = new BankIdApiError({
      errorCode: "invalidParameters",
      details: `Incorrect personalNumber ${personalNumber}`,
      status: 400,
      path: "/phone/auth",
    });
    expect(describeError(error)).toBe(
      "BankID returned invalidParameters (HTTP 400)",
    );
  });

  it("reports a transport error by reason, never its cause", () => {
    const error = new BankIdTransportError({
      reason: "network",
      path: "/auth",
      cause: Object.assign(new Error(`for ${personalNumber}`), {
        code: "ECONNRESET",
      }),
    });
    expect(describeError(error)).toBe(
      "no usable response from BankID: network",
    );
  });

  it("reports any other error by name and code only", () => {
    const error = Object.assign(
      new Error(`personal number ${personalNumber}`),
      {
        code: "CERT_HAS_EXPIRED",
        cause: new Error(personalNumber),
      },
    );
    expect(describeError(error)).toBe("Error CERT_HAS_EXPIRED");
    expect(describeError(personalNumber)).toBe("Error");
    expect(describeError({ name: `x ${personalNumber}` })).toBe("Error");
  });
});

describe("live-check public result", () => {
  const secret = "200001012384";

  it("keeps only fixed step ids, outcomes, bounded statuses and known codes", () => {
    expect(
      stepResult({
        step: "auth.collect",
        outcome: "fail",
        status: 503,
        code: "maintenance",
      }),
    ).toEqual({
      step: "auth.collect",
      outcome: "fail",
      status: 503,
      code: "maintenance",
    });
    for (const field of ["errorCode", "name", "code", "hintCode"])
      expect(
        JSON.stringify(
          stepResult({
            step: `auth.start ${secret}`,
            outcome: secret,
            status: Number(secret),
            code: secret,
            [field]: secret,
          }),
        ),
      ).toBe('{"step":"other","outcome":"fail","code":"other"}');
    expect(
      stepResult({ step: "auth.start", outcome: "pass", status: 99.5 }),
    ).toEqual({ step: "auth.start", outcome: "pass" });
    expect(stepResult(null)).toEqual({ step: "other", outcome: "fail" });
  });

  it("reads an error's status and code, and never its text", () => {
    const apiError = new BankIdApiError({
      errorCode: secret,
      details: secret,
      status: 400,
      path: "/phone/auth",
    });
    expect(
      stepResult({
        step: "phone.auth.start",
        outcome: "fail",
        ...errorFacts(apiError),
      }),
    ).toEqual({
      step: "phone.auth.start",
      outcome: "fail",
      status: 400,
      code: "other",
    });
    const transportError = new BankIdTransportError({
      reason: "network",
      path: "/auth",
      cause: { code: secret },
    });
    expect(errorFacts(transportError)).toEqual({
      status: undefined,
      code: "network",
    });
    expect(
      stepResult({
        step: "liveCheck",
        outcome: "fail",
        ...errorFacts(Object.assign(new Error(secret), { code: secret })),
      }),
    ).toEqual({ step: "liveCheck", outcome: "fail", code: "other" });
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw new Error(secret);
        },
      },
    );
    expect(errorFacts(throwing)).toEqual({});
  });

  it("builds the issue from the structured result alone", () => {
    const body = issueBody(
      {
        version: 1,
        steps: [
          { step: "auth.start", outcome: "pass" },
          { step: "auth.collect", outcome: "fail", status: 200, code: secret },
          {
            step: "phone.auth.start",
            outcome: "fail",
            status: 400,
            code: "invalidParameters",
            details: secret,
            name: secret,
          },
          { step: "testServerCertificate.expiry", outcome: "fail" },
          { step: secret, outcome: "fail", hintCode: secret },
        ],
        log: secret,
      },
      "https://github.com/example/bankid/actions/runs/123",
    );
    expect(body).not.toContain(secret);
    expect(body).toContain(
      "Run: https://github.com/example/bankid/actions/runs/123",
    );
    expect(body).toContain("| auth.collect | fail | 200 | other |");
    expect(body).toContain(
      "| phone.auth.start | fail | 400 | invalidParameters |",
    );
    expect(body).toContain("| other | fail |  |  |");
    expect(body).toContain("- testServerCertificate.expiry:");
  });

  it("says the check did not finish when there is no result, and drops an odd run URL", () => {
    const body = issueBody(undefined, `https://example.com/${secret}`);
    expect(body).toContain("The check did not finish. See the run log.");
    expect(body).not.toContain(secret);
  });

  it("writes the issue from a result file on the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankid-live-check-"));
    try {
      const file = join(dir, "result.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          steps: [{ step: "auth.start", outcome: "fail", code: secret }],
        }),
      );
      const script = new URL(
        "../scripts/live-check-report.mjs",
        import.meta.url,
      ).pathname;
      const out = execFileSync(process.execPath, [script, "--issue", file], {
        encoding: "utf8",
      });
      expect(out).toContain("| auth.start | fail |  | other |");
      expect(out).not.toContain(secret);
      const missing = execFileSync(
        process.execPath,
        [script, "--issue", join(dir, "none.json")],
        { encoding: "utf8" },
      );
      expect(missing).toContain("did not finish");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists exactly the codes the library documents", () => {
    expect([...knownCodes].sort()).toEqual(
      [
        ...Object.keys(errorMessages),
        ...Object.keys(pendingMessages),
        ...Object.keys(failedMessages),
        "timeout",
        "aborted",
        "network",
        "invalidResponse",
      ].sort(),
    );
  });

  it("names every step live-check.mjs reports, and only those", () => {
    const script = readFileSync(
      new URL("../scripts/live-check.mjs", import.meta.url),
      "utf8",
    );
    // Every step id reaches the result through one of these helpers, as a
    // string literal, as `${name}.x` inside orderRoundTrip, or as the
    // helper's own `step` parameter passed on.
    const roundTrips = [
      ...script.matchAll(/\borderRoundTrip\(\s*"([^"]+)"/g),
    ].map(([, name]) => name ?? "");
    expect(roundTrips).toEqual(["auth", "phone.auth"]);
    const emitted = new Set<string>();
    const calls = [
      ...script.matchAll(
        /\b(?:record|pass|fail|failWith|checkExpiry)\(\s*([^,)]+)/g,
      ),
    ];
    expect(calls.length).toBeGreaterThan(10);
    for (const [call, argument = ""] of calls) {
      const literal = /^"([^"]+)"$/.exec(argument.trim());
      const template = /^`\$\{name\}(\.\w+)`$/.exec(argument.trim());
      if (literal?.[1]) emitted.add(literal[1]);
      else if (template?.[1])
        for (const name of roundTrips) emitted.add(`${name}${template[1]}`);
      else expect(argument.trim(), call).toBe("step");
    }
    expect(emitted).toEqual(new Set(stepIds));
  });

  it("redacts the personal number in every common form", () => {
    const redact = redactor(` ${secret} `);
    expect(
      redact(`a ${secret} b 20000101-2384 c 0001012384 d 000101-2384`),
    ).toBe("a [redacted] b [redacted] c [redacted] d [redacted]");
    expect(redactor(undefined)("unchanged")).toBe("unchanged");
    expect(redactor("")("unchanged")).toBe("unchanged");
  });
});

describe("live-check workflow", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/live-check.yml", import.meta.url),
    "utf8",
  );

  it("takes the personal number from a secret, not a variable", () => {
    expect(workflow).toContain(
      "LIVE_CHECK_PERSONAL_NUMBER: ${{ secrets.LIVE_CHECK_PERSONAL_NUMBER }}",
    );
    expect(workflow).not.toContain("vars.LIVE_CHECK_PERSONAL_NUMBER");
  });

  it("runs one at a time, so overlapping runs cannot each open an issue", () => {
    const [top = ""] = workflow.split(/^jobs:\n/m);
    expect(top).toMatch(
      /^concurrency:\n {2}group: live-check\n {2}cancel-in-progress: false\n/m,
    );
  });

  it("builds the issue only from the structured result", () => {
    expect(workflow).toContain(
      "node scripts/live-check.mjs --result live-check-result.json",
    );
    expect(workflow).toContain(
      "node scripts/live-check-report.mjs --issue live-check-result.json",
    );
    expect(workflow).not.toMatch(/\btee\b|report\.txt|\bcat\b|2>&1/);
  });
});

describe("live-check server chain", () => {
  let tls: TlsFixtures;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    tls = createTlsFixtures();
    server = createServer(
      { cert: tls.serverCert, key: tls.serverKey },
      socket => socket.end(),
    );
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  it("reads the chain of a server the CA trusts", async () => {
    const chain = await serverChain({
      host: "localhost",
      port,
      ca: tls.caCert,
    });
    expect(chain[0]?.subject).toContain("CN=localhost");
  });

  it("refuses a server the CA does not trust even when NODE_TLS_REJECT_UNAUTHORIZED is 0", async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(
        serverChain({ host: "localhost", port, ca: testRootCa }),
      ).rejects.toThrow();
    } finally {
      if (previous === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });
});

describe("live-check phone step", () => {
  it("is skipped without LIVE_CHECK_PERSONAL_NUMBER", () => {
    expect(phoneStep({})).toEqual({
      skip: "LIVE_CHECK_PERSONAL_NUMBER is not set, so the phone.auth step is skipped",
    });
    expect(phoneStep({ LIVE_CHECK_PERSONAL_NUMBER: " " })).toHaveProperty(
      "skip",
    );
  });

  it("uses the number from the environment, without naming it on failure", () => {
    expect(phoneStep({ LIVE_CHECK_PERSONAL_NUMBER: "192110101414" })).toEqual({
      personalNumber: "192110101414",
    });
    const result = phoneStep({ LIVE_CHECK_PERSONAL_NUMBER: "19211010-1414" });
    expect(result).toEqual({
      fail: "LIVE_CHECK_PERSONAL_NUMBER is not 12 digits",
    });
  });

  it("has no personal number in the script or the workflow", () => {
    for (const file of [
      "../scripts/live-check.mjs",
      "../scripts/live-check-report.mjs",
      "../.github/workflows/live-check.yml",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text).not.toMatch(/\b(19|20)[0-9]{10}\b/);
    }
  });
});

describe("personal numbers in the repository", () => {
  const root = new URL("../", import.meta.url);
  const spec = readFileSync(
    new URL("spec/openapi-auth-sign.yaml", root),
    "utf8",
  );
  // The project's own files; BankID's spec and the code generated from it
  // are BankID's.
  const authored = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      file =>
        file !== "" &&
        !file.startsWith("spec/") &&
        !file.startsWith("src/generated/") &&
        !file.startsWith("cert/") &&
        file !== "pnpm-lock.yaml",
    );
  const personalNumber = /(?<![0-9])((?:19|20)[0-9]{6})-?([0-9]{4})(?![0-9])/g;

  it("uses only numbers BankID's spec shows as examples", () => {
    const found = new Map<string, string>();
    for (const file of authored) {
      const text = readFileSync(new URL(file, root), "utf8");
      for (const [, date, last] of text.matchAll(personalNumber))
        found.set(`${date}${last}`, file);
    }
    const unknown = [...found].filter(([number]) => !spec.includes(number));
    expect(unknown).toEqual([]);
    expect([...found.keys()].sort()).toEqual([
      "190010101010",
      "192110101414",
      "200001012384",
    ]);
  });
});

/** Repository URLs both release gates must accept or refuse. */
const repositoryUrls = {
  accepted: [
    "git+https://github.com/anyfin/bankid.git",
    "https://github.com/anyfin/bankid",
    "https://github.com/anyfin/bankid.git",
    "https://GitHub.com/Anyfin/BankID.git",
  ],
  refused: [
    "",
    "https://evil.example/github.com/anyfin/bankid.git",
    "https://github.com.evil.example/anyfin/bankid.git",
    "https://github.com@evil.example/anyfin/bankid.git",
    "https://github.com:8443/anyfin/bankid.git",
    "https://github.com/anyfin/bankid-fork.git",
    "https://github.com/someone/bankid.git",
    "https://github.com/evil/anyfin/bankid.git",
    "git@github.com:anyfin/bankid.git",
    "github.com/anyfin/bankid",
  ],
};

describe("check-release", () => {
  const manifest = (version: string) => ({
    version,
    repository: {
      type: "git",
      url: "git+https://github.com/anyfin/bankid.git",
    },
  });
  const release = {
    repository: "anyfin/bankid",
    dryRun: false,
  };

  it("publishes a prerelease under next and a normal version under latest", () => {
    expect(
      checkRelease({
        ...release,
        manifest: manifest("4.0.0-beta.1"),
        tag: "v4.0.0-beta.1",
        prerelease: "true",
      }),
    ).toEqual({ distTag: "next", problems: [] });
    expect(
      checkRelease({
        ...release,
        manifest: manifest("4.0.0"),
        tag: "4.0.0",
        prerelease: "false",
      }),
    ).toEqual({ distTag: "latest", problems: [] });
  });

  it("refuses a tag that is not the package version", () => {
    const { problems } = checkRelease({
      ...release,
      manifest: manifest("4.0.0"),
      tag: "v4.0.1",
      prerelease: "false",
    });
    expect(problems).toEqual([
      "release tag v4.0.1 does not match package.json version 4.0.0",
    ]);
  });

  it("refuses a prerelease flag that disagrees with the version", () => {
    const { problems } = checkRelease({
      ...release,
      manifest: manifest("4.0.0"),
      tag: "v4.0.0",
      prerelease: "true",
    });
    expect(problems).toHaveLength(1);
  });

  it("refuses any repository but the public one", () => {
    const { problems } = checkRelease({
      ...release,
      repository: "anyfin/bankid-fork",
      manifest: manifest("4.0.0"),
      tag: "v4.0.0",
      prerelease: "false",
    });
    expect(problems).toEqual([
      "this repository is anyfin/bankid-fork; publish from anyfin/bankid",
    ]);
  });

  it.each(repositoryUrls.refused)(
    "refuses the package.json repository URL %j",
    url => {
      const { problems } = checkRelease({
        ...release,
        manifest: { version: "4.0.0", repository: url },
        tag: "v4.0.0",
        prerelease: "false",
      });
      expect(problems).toEqual([
        `package.json's repository URL ${url || "(none)"} is not https://github.com/anyfin/bankid`,
      ]);
    },
  );

  it("reads the prerelease part of the version as SemVer does", () => {
    const { distTag } = checkRelease({
      ...release,
      manifest: manifest("4.0.0+build-1"),
      tag: "v4.0.0+build-1",
      prerelease: "false",
    });
    expect(distTag).toBe("latest");
    expect(
      checkRelease({
        ...release,
        manifest: manifest("4.0.0-rc-1"),
        tag: "v4.0.0-rc-1",
        prerelease: "true",
      }),
    ).toEqual({ distTag: "next", problems: [] });
  });

  it("refuses build metadata and versions that are not SemVer", () => {
    for (const [version, prerelease] of [
      ["4.0.0+build-1", "false"],
      ["4.0.0-beta.1+sha.5114f85", "true"],
    ] as const)
      expect(
        checkRelease({
          ...release,
          manifest: manifest(version),
          tag: `v${version}`,
          prerelease,
        }).problems,
      ).toEqual([
        `version ${version} has build metadata, which a release cannot have`,
      ]);
    expect(
      checkRelease({
        ...release,
        manifest: manifest("4.0"),
        tag: "v4.0",
        prerelease: "false",
      }).problems,
    ).toEqual(["version 4.0 is not a SemVer version"]);
  });

  it("checks only the repository in a dry run", () => {
    expect(
      checkRelease({
        manifest: manifest("4.0.0-beta.0"),
        repository: "example/other",
        dryRun: true,
      }).problems,
    ).toHaveLength(1);
    expect(
      checkRelease({
        manifest: manifest("4.0.0-beta.0"),
        repository: "Anyfin/Bankid",
        dryRun: true,
      }).problems,
    ).toEqual([]);
  });
});

describe("release workflow", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const [top = "", jobsText = ""] = workflow.split(/^jobs:\n/m);
  /** Each job's text, by job id. */
  const jobs = Object.fromEntries(
    jobsText
      .split(/^(?=  [a-z][\w-]*:\n)/m)
      .filter(block => block.trim() !== "")
      .map(block => [/^  ([\w-]+):/.exec(block)?.[1] ?? "", block]),
  );

  it("has a read-only check job and a separate publish job", () => {
    expect(Object.keys(jobs)).toEqual(["check", "publish"]);
    expect(top).not.toContain("id-token");
  });

  it("checks, packs and dry-runs in the read-only job, for every trigger", () => {
    const check = jobs.check ?? "";
    expect(check).not.toContain("id-token");
    expect(check).not.toMatch(/^ {4}if:/m);
    expect(check).toMatch(/permissions:\n\s+contents: read\n/);
    for (const step of [
      "pnpm install --frozen-lockfile",
      "node scripts/check-package.mjs --keep package/bankid.tgz",
      "pnpm check:docs",
      "npm publish ./package/*.tgz --dry-run",
      "actions/upload-artifact@",
    ])
      expect(check).toContain(step);
  });

  it("uploads the very tarball the package check verified", () => {
    const check = jobs.check ?? "";
    // No second pack: the only tarball is the one check-package kept.
    expect(check).not.toMatch(/\b(pnpm|npm) pack\b/);
    expect(check).toMatch(/path: package\/\*\.tgz\n/);
    const keep = check.indexOf("--keep package/bankid.tgz");
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(check.indexOf("npm publish"));
    expect(keep).toBeLessThan(check.indexOf("actions/upload-artifact@"));
  });

  it("publishes the checked tarball from a job that runs no repository code", () => {
    const publish = jobs.publish ?? "";
    expect(publish).toContain(
      "if: github.event_name == 'release' && github.repository == 'anyfin/bankid'",
    );
    expect(publish).toContain("needs: check");
    expect(publish).toContain("environment: npm");
    expect(publish).toMatch(/permissions:\n\s+id-token: write\n/);
    expect(publish).toContain("actions/download-artifact@");
    expect(publish).toContain("RELEASE_TAG");
    expect(publish).toContain("GITHUB_REPOSITORY");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("pnpm");
    expect(publish).not.toContain("scripts/");
    expect(publish).toMatch(
      /npm publish \.\/package\/\*\.tgz [^\n]*--ignore-scripts/,
    );
  });
});

describe("release gates", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  // The publish job runs no repository code, so it carries its own copy of
  // the rules. Both gates are driven from the same tables.
  const inline = /const semver = \/(.+)\/\.exec\(version\);/.exec(workflow);
  const publishCheck = stepScript(
    workflow,
    "Check the tarball against the repository and the release tag",
  );
  const isPrerelease = (version: string) => /^[^+]*-/.test(version);

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bankid-release-gate-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the publish job's own check on a tarball with this manifest. */
  const workflowAccepts = (
    manifest: { version: string; repository: string },
    distTag: string,
  ) => {
    const work = mkdtempSync(join(dir, "run-"));
    mkdirSync(join(work, "staging/package"), { recursive: true });
    mkdirSync(join(work, "package"));
    writeFileSync(
      join(work, "staging/package/package.json"),
      JSON.stringify(manifest),
    );
    execFileSync("tar", [
      "-czf",
      join(work, "package/bankid.tgz"),
      "-C",
      join(work, "staging"),
      "package/package.json",
    ]);
    return runStep(publishCheck, {
      cwd: work,
      env: {
        GITHUB_REPOSITORY: "anyfin/bankid",
        RELEASE_TAG: manifest.version,
        RELEASE_PRERELEASE: String(isPrerelease(manifest.version)),
        DIST_TAG: distTag,
      },
    });
  };

  const scriptAccepts = (version: string, repository: string): boolean =>
    checkRelease({
      manifest: { version, repository },
      repository: "anyfin/bankid",
      tag: version,
      prerelease: String(isPrerelease(version)),
      dryRun: false,
    }).problems.length === 0;

  const url = "https://github.com/anyfin/bankid";
  const valid = [
    "4.0.0",
    "0.0.0",
    "10.20.30",
    "4.0.0-0",
    "4.0.0-beta.0",
    "4.0.0-beta.1",
    "4.0.0-rc-1",
    "4.0.0-alpha.0a",
    "1.2.3-x.7.z.92",
    "1.0.0--",
  ];
  const invalid = [
    "4.0.0-01",
    "4.0.0-beta.01",
    "04.0.0",
    "4.00.0",
    "4.0",
    "4.0.0.0",
    "v4.0.0",
    "4.0.0-",
    "4.0.0-beta..1",
    "4.0.0-beta_1",
    "4.0.0+build-1",
    "4.0.0-beta.1+sha.5114f85",
    " 4.0.0",
    "4.0.0\n",
  ];

  it("finds the pattern in the workflow", () => {
    expect(inline).not.toBeNull();
    expect(inline?.[1]).toBe(semver.source);
  });

  it.each(valid)("accepts %j in the workflow and the script", version => {
    const distTag = isPrerelease(version) ? "next" : "latest";
    const { status, output } = workflowAccepts(
      { version, repository: url },
      distTag,
    );
    expect(status, output).toBe(0);
    expect(output).toContain(`Publishing ${version} under ${distTag}.`);
    expect(scriptAccepts(version, url)).toBe(true);
  });

  it.each(invalid)("refuses %j in the workflow and the script", version => {
    const { status, output } = workflowAccepts(
      { version, repository: url },
      isPrerelease(version) ? "next" : "latest",
    );
    expect(status).toBe(1);
    expect(output).toContain(
      `Refused: version ${version} is not a release version`,
    );
    expect(scriptAccepts(version, url)).toBe(false);
  });

  it.each(repositoryUrls.accepted)(
    "accepts the repository URL %j in the workflow and the script",
    repository => {
      const { status, output } = workflowAccepts(
        { version: "4.0.0", repository },
        "latest",
      );
      expect(status, output).toBe(0);
      expect(scriptAccepts("4.0.0", repository)).toBe(true);
    },
  );

  it.each(repositoryUrls.refused)(
    "refuses the repository URL %j in the workflow and the script",
    repository => {
      const { status, output } = workflowAccepts(
        { version: "4.0.0", repository },
        "latest",
      );
      expect(status).toBe(1);
      expect(output).toContain(
        `Refused: the package names repository ${repository}, not https://github.com/anyfin/bankid`,
      );
      expect(scriptAccepts("4.0.0", repository)).toBe(false);
    },
  );
});

describe("type generator", () => {
  const read = (file: string) =>
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  it("pins openapi-typescript to the exact version in the lockfile", () => {
    const manifest = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
    };
    const pinned = manifest.devDependencies["openapi-typescript"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const locked =
      /\n {6}openapi-typescript:\n {8}specifier: (\S+)\n {8}version: (\S+)\n/.exec(
        read("pnpm-lock.yaml"),
      );
    expect(locked?.slice(1)).toEqual([pinned, pinned]);
  });

  it("gives openapi-typescript its own TypeScript 5", async () => {
    const { createRequire } = await import("node:module");
    const pnpmfile = createRequire(import.meta.url)("../.pnpmfile.cjs") as {
      hooks: { readPackage: (pkg: object) => { dependencies?: object } };
    };
    const pkg = pnpmfile.hooks.readPackage({
      name: "openapi-typescript",
      peerDependencies: { typescript: "^5.x" },
    });
    expect(pkg).toEqual({
      name: "openapi-typescript",
      peerDependencies: {},
      dependencies: { typescript: expect.stringMatching(/^5\.\d+\.\d+$/) },
    });
  });
});
