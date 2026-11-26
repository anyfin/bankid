// The parts of the live check that tests can run without BankID, and the
// text of the public issue for a failed run.
//
// The issue is built only from the structured result live-check.mjs writes:
// per step a fixed step id, the outcome, an HTTP status from 100 to 599, and
// a code from a fixed list of BankID error codes, hint codes and transport
// reasons. Anything else becomes the label "other" or is left out, so no
// text from BankID, an error or the environment reaches the issue.
//
//   node scripts/live-check-report.mjs --issue <result.json> [--run-url <url>]
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

/** Every step id live-check.mjs reports. */
export const stepIds = [
  "auth.start",
  "auth.collect",
  "auth.cancel",
  "auth.collectAfterCancel",
  "phone.auth.config",
  "phone.auth.start",
  "phone.auth.collect",
  "phone.auth.cancel",
  "phone.auth.collectAfterCancel",
  "testClientCertificate.expiry",
  "embeddedRootCas.count",
  "embeddedRootCa.expiry",
  "testServerCertificate.chain",
  "testServerCertificate.expiry",
  "testServerIssuingCa.expiry",
  "liveCheck",
];

/** The codes an issue may name: BankID's documented codes and the reasons. */
export const knownCodes = [
  // Error codes
  "alreadyInProgress",
  "invalidParameters",
  "unauthorized",
  "notFound",
  "methodNotAllowed",
  "requestTimeout",
  "unsupportedMediaType",
  "internalError",
  "maintenance",
  // Pending hint codes
  "outstandingTransaction",
  "noClient",
  "started",
  "userMrtd",
  "userCallConfirm",
  "userSign",
  "processing",
  "userStepUp",
  "userFace",
  // Failed hint codes
  "expiredTransaction",
  "certificateErr",
  "userCancel",
  "cancelled",
  "startFailed",
  "userDeclinedCall",
  "notSupportedByUserApp",
  "mrtdVerificationFailed",
  "facialRecognitionFailed",
  "nfcNotSupportedByDevice",
  "multipleBankIdsOnDevice",
  "stepUpFailed",
  // Transport error reasons
  "timeout",
  "aborted",
  "network",
  "invalidResponse",
];

const steps = new Set(stepIds);
const codes = new Set(knownCodes);
const outcomes = new Set(["pass", "fail", "skip"]);

/**
 * One step's result as it may be published. The step id must be one of
 * `stepIds` (else "other"), the outcome pass, fail or skip (else fail), the
 * status a whole number from 100 to 599 (else left out), and the code one of
 * `knownCodes` (else "other"; left out when absent).
 *
 * @param {unknown} input
 * @returns {{ step: string, outcome: "pass" | "fail" | "skip", status?: number, code?: string }}
 */
export function stepResult(input) {
  const read = field => {
    try {
      return typeof input === "object" && input !== null
        ? input[field]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const step = read("step");
  const outcome = read("outcome");
  const status = read("status");
  const code = read("code");
  return {
    step: typeof step === "string" && steps.has(step) ? step : "other",
    outcome:
      typeof outcome === "string" && outcomes.has(outcome) ? outcome : "fail",
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(code === undefined
      ? {}
      : { code: typeof code === "string" && codes.has(code) ? code : "other" }),
  };
}

/**
 * The HTTP status and code of an error, for {@link stepResult}: the error
 * code of a BankIdApiError, the reason of a BankIdTransportError, and for any
 * other error its `code`, which `stepResult` turns into "other".
 *
 * @param {unknown} error
 * @returns {{ status?: unknown, code?: unknown }}
 */
export function errorFacts(error) {
  try {
    if (typeof error !== "object" || error === null) return {};
    if (error.name === "BankIdApiError")
      return { status: error.status, code: error.errorCode };
    if (error.name === "BankIdTransportError")
      return { status: error.status, code: error.reason };
    return { code: error.code };
  } catch {
    return {};
  }
}

const notes = {
  "phone.auth.config":
    "LIVE_CHECK_PERSONAL_NUMBER is set but is not a personal number.",
  "embeddedRootCas.count": "The build does not embed exactly two root CAs.",
  "testServerCertificate.chain":
    "The test server's certificate chain could not be read or verified.",
};

/**
 * The text of the public issue for a run, built only from its structured
 * result. Each step is passed through {@link stepResult} again.
 *
 * @param {unknown} result the parsed result file, or undefined without one
 * @param {string} [runUrl]
 * @returns {string}
 */
export function issueBody(result, runUrl) {
  const list =
    typeof result === "object" && result !== null && Array.isArray(result.steps)
      ? result.steps.map(stepResult)
      : undefined;
  const run =
    typeof runUrl === "string" &&
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/[0-9]+$/.test(
      runUrl,
    )
      ? runUrl
      : undefined;
  const lines = [
    "The nightly check against BankID's test environment failed.",
    "",
    ...(run ? [`Run: ${run}`, ""] : []),
  ];
  if (list === undefined) {
    lines.push("The check did not finish. See the run log.");
  } else {
    lines.push(
      "| Step | Outcome | HTTP status | Code |",
      "| --- | --- | --- | --- |",
    );
    for (const { step, outcome, status, code } of list)
      lines.push(`| ${step} | ${outcome} | ${status ?? ""} | ${code ?? ""} |`);
    const failed = new Set(
      list.filter(({ outcome }) => outcome === "fail").map(({ step }) => step),
    );
    const explained = [...failed].flatMap(step =>
      step.endsWith(".expiry")
        ? [
            `- ${step}: the certificate expires within the warning period, or could not be read.`,
          ]
        : Object.hasOwn(notes, step)
          ? [`- ${step}: ${notes[step]}`]
          : [],
    );
    if (explained.length > 0) lines.push("", ...explained);
  }
  lines.push(
    "",
    "The run log has the details. Run `pnpm build && node scripts/live-check.mjs` to reproduce. Close this issue once the check passes again.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Replaces the personal number the run was given, in any common way of
 * writing it, with "[redacted]".
 *
 * @param {string | undefined} personalNumber
 * @returns {(text: string) => string}
 */
export function redactor(personalNumber) {
  const value = personalNumber?.trim() ?? "";
  if (value === "") return text => text;
  const forms = new Set([value]);
  if (/^[0-9]{12}$/.test(value)) {
    forms.add(`${value.slice(0, 8)}-${value.slice(8)}`);
    forms.add(value.slice(2));
    forms.add(`${value.slice(2, 8)}-${value.slice(8)}`);
  }
  // Longest first, so a shorter form never leaves part of a longer one.
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  return text =>
    ordered.reduce(
      (out, form) => out.replaceAll(form, "[redacted]"),
      String(text),
    );
}

/**
 * One line about an error, for the run log.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  const fields = typeof error === "object" && error !== null ? error : {};
  const word = value =>
    typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
      ? value
      : undefined;
  if (fields.name === "BankIdApiError")
    return `BankID returned ${word(fields.errorCode) ?? "an error"} (HTTP ${Number(fields.status) || "unknown"})`;
  if (fields.name === "BankIdTransportError")
    return `no usable response from BankID: ${word(fields.reason) ?? "unknown"}${Number.isInteger(fields.status) ? ` (HTTP ${fields.status})` : ""}`;
  const code = word(fields.code);
  return `${word(fields.name) ?? "Error"}${code ? ` ${code}` : ""}`;
}

/**
 * The personal number for the phone step, from LIVE_CHECK_PERSONAL_NUMBER,
 * which the maintainers set to one of their test personal numbers. Without
 * it the step is skipped. The number itself is never printed.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ personalNumber: string } | { skip: string } | { fail: string }}
 */
export function phoneStep(env) {
  const value = env.LIVE_CHECK_PERSONAL_NUMBER?.trim() ?? "";
  if (value === "")
    return {
      skip: "LIVE_CHECK_PERSONAL_NUMBER is not set, so the phone.auth step is skipped",
    };
  if (!/^[0-9]{12}$/.test(value))
    return { fail: "LIVE_CHECK_PERSONAL_NUMBER is not 12 digits" };
  return { personalNumber: value };
}

/**
 * A server's certificate chain, leaf first. The server must be trusted by
 * `ca`; verification stays on whatever NODE_TLS_REJECT_UNAUTHORIZED says.
 *
 * @param {{ host: string, port?: number, ca: string, pfx?: Buffer, passphrase?: string, timeoutMs?: number }} options
 * @returns {Promise<X509Certificate[]>}
 */
export const serverChain = ({
  host,
  port = 443,
  ca,
  pfx,
  passphrase,
  timeoutMs = 20_000,
}) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        ca,
        ...(pfx === undefined ? {} : { pfx, passphrase }),
        // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn it off.
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      () => {
        const chain = [];
        let current = socket.getPeerCertificate(true);
        while (current?.raw && !chain.some(c => c.raw.equals(current.raw))) {
          chain.push(current);
          current = current.issuerCertificate;
        }
        socket.destroy();
        resolve(chain.map(c => new X509Certificate(c.raw)));
      },
    );
    socket.on("timeout", () => socket.destroy(new Error("timed out")));
    socket.on("error", reject);
  });

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argument = name => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const file = argument("--issue");
  if (file === undefined) {
    console.error(
      "usage: node scripts/live-check-report.mjs --issue <result.json> [--run-url <url>]",
    );
    process.exit(2);
  }
  let result;
  try {
    result = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    result = undefined;
  }
  process.stdout.write(issueBody(result, argument("--run-url")));
}
