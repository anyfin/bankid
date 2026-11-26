// Checks the built package against BankID's test environment with BankID's
// public test certificate, and that no certificate the package depends on is
// about to expire. It is run nightly, needs no person or phone, and is not
// published.
//
//   pnpm build && node scripts/live-check.mjs [--result <path>]
//
// Steps:
// 1. auth, then collect once (expects pending), cancel, and collect again
//    (expects BankID to refuse it, since the order is gone).
// 2. The same for phone.auth, only when LIVE_CHECK_PERSONAL_NUMBER holds a
//    test personal number the maintainers chose; otherwise it is skipped
//    with a note. The number is redacted from everything printed.
// 3. The expiry dates of the test client certificate, the root CAs embedded
//    in the build and the test server's certificate chain. Each must be valid
//    for at least WARN_DAYS more days (60 unless the WARN_DAYS environment
//    variable says otherwise; a large value makes the run fail on purpose).
//
// It prints a line per step for the run log. With --result it also writes
// the structured result that live-check-report.mjs turns into the text of a
// public issue: per step only a fixed step id, the outcome, a bounded HTTP
// status and a code from a fixed list.
//
// Exit codes: 0 everything passed, 1 something failed.
import { X509Certificate } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import { BankIdApiError, createBankIdClient } from "../dist/index.mjs";
import { testCredentials } from "../dist/testing.mjs";
import {
  describeError,
  errorFacts,
  phoneStep,
  redactor,
  serverChain,
  stepResult,
} from "./live-check-report.mjs";

const host = "appapi2.test.bankid.com";
const warnDays = Number(process.env.WARN_DAYS || 60);
if (!Number.isInteger(warnDays) || warnDays < 0)
  throw new Error("WARN_DAYS must be a whole number of days");
// From the documentation address range (RFC 5737), so it is no one's address.
const endUserIp = "192.0.2.1";
const resultIndex = process.argv.indexOf("--result");
const resultPath =
  resultIndex === -1 ? undefined : process.argv[resultIndex + 1];

const dist = new URL("../dist/", import.meta.url);
const day = 24 * 60 * 60 * 1000;
const redact = redactor(process.env.LIVE_CHECK_PERSONAL_NUMBER);
const steps = [];

const log = line => console.log(redact(line));

/** Records a step's outcome and prints a line about it for the run log. */
const record = (step, outcome, detail, facts = {}) => {
  steps.push(stepResult({ step, outcome, ...facts }));
  log(`${outcome.toUpperCase().padEnd(4)}  ${step}: ${detail}`);
};
const pass = (step, detail, facts) => record(step, "pass", detail, facts);
const fail = (step, detail, facts) => record(step, "fail", detail, facts);
const failWith = (step, error) =>
  fail(step, describeError(error), errorFacts(error));

const bankid = createBankIdClient({
  environment: "test",
  credentials: testCredentials,
  timeoutMs: 20_000,
});

/**
 * Starts an order, collects it once expecting pending, cancels it, and
 * collects again expecting BankID to refuse.
 */
async function orderRoundTrip(name, start) {
  let orderRef;
  try {
    ({ orderRef } = await start());
    pass(`${name}.start`, "order started");
  } catch (error) {
    failWith(`${name}.start`, error);
    return;
  }
  try {
    const result = await bankid.collect(orderRef);
    const facts = { code: result.hintCode };
    if (result.status === "pending")
      pass(`${name}.collect`, `pending ${result.hintCode ?? ""}`, facts);
    else
      fail(
        `${name}.collect`,
        `expected pending, got ${result.status} ${result.hintCode ?? ""}`,
        facts,
      );
  } catch (error) {
    failWith(`${name}.collect`, error);
  }
  try {
    await bankid.cancel(orderRef);
    pass(`${name}.cancel`, "cancelled");
  } catch (error) {
    failWith(`${name}.cancel`, error);
    return;
  }
  try {
    const result = await bankid.collect(orderRef);
    fail(
      `${name}.collectAfterCancel`,
      `expected a refusal, got ${result.status} ${result.hintCode ?? ""}`,
      { code: result.hintCode },
    );
  } catch (error) {
    if (error instanceof BankIdApiError && error.status === 400)
      pass(
        `${name}.collectAfterCancel`,
        `refused: ${describeError(error)}`,
        errorFacts(error),
      );
    else failWith(`${name}.collectAfterCancel`, error);
  }
}

const commonName = certificate =>
  /^CN=(.*)$/m.exec(certificate.subject)?.[1] ?? certificate.subject;

function checkExpiry(step, certificate) {
  const validTo = new Date(certificate.validTo);
  const daysLeft = Math.floor((validTo.getTime() - Date.now()) / day);
  const detail = `${commonName(certificate)}, valid to ${validTo.toISOString().slice(0, 10)} (${daysLeft} days)`;
  if (daysLeft < warnDays) fail(step, `${detail}, less than ${warnDays} days`);
  else pass(step, detail);
}

/** The certificate in a PKCS#12 file, read by serving it over local TLS. */
const certificateInPfx = ({ pfx, passphrase }) =>
  new Promise((resolve, reject) => {
    const server = tls.createServer(
      { pfx: Buffer.from(pfx, "base64"), passphrase },
      socket => socket.end(),
    );
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const socket = tls.connect(
        {
          host: "127.0.0.1",
          port: server.address().port,
          // Only reads the certificate this script itself serves on loopback.
          rejectUnauthorized: false,
        },
        () => {
          const certificate = socket.getPeerX509Certificate();
          socket.destroy();
          server.close();
          resolve(certificate);
        },
      );
      socket.on("error", error => {
        server.close();
        reject(error);
      });
    });
  });

/** The PEM certificates embedded in the build, without duplicates. */
function embeddedCertificates() {
  const found = new Map();
  for (const file of readdirSync(dist).filter(f => f.endsWith(".mjs"))) {
    const source = readFileSync(join(dist.pathname, file), "utf8");
    for (const [pem] of source.matchAll(
      /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s\\n]+?-----END CERTIFICATE-----/g,
    )) {
      const certificate = new X509Certificate(pem.replaceAll("\\n", "\n"));
      found.set(certificate.fingerprint256, certificate);
    }
  }
  return [...found.values()];
}

try {
  log(`Live check against ${host}, ${new Date().toISOString()}`);

  await orderRoundTrip("auth", () =>
    bankid.auth({ endUserIp, userVisibleData: "Automated check" }),
  );
  const phone = phoneStep(process.env);
  if ("skip" in phone) record("phone.auth.config", "skip", phone.skip);
  else if ("fail" in phone) fail("phone.auth.config", phone.fail);
  else
    await orderRoundTrip("phone.auth", () =>
      bankid.phone.auth({
        personalNumber: phone.personalNumber,
        callInitiator: "RP",
        userVisibleData: "Automated check",
      }),
    );

  try {
    checkExpiry(
      "testClientCertificate.expiry",
      await certificateInPfx(testCredentials),
    );
  } catch (error) {
    failWith("testClientCertificate.expiry", error);
  }

  const roots = embeddedCertificates();
  if (roots.length !== 2)
    fail("embeddedRootCas.count", `expected 2 in dist/, found ${roots.length}`);
  for (const root of roots) checkExpiry("embeddedRootCa.expiry", root);

  const testRoot = roots.find(root => /\bTest\b/.test(commonName(root)));
  if (testRoot === undefined) {
    fail("testServerCertificate.chain", "no test root CA embedded in dist/");
  } else {
    try {
      const [leaf, ...issuers] = await serverChain({
        host,
        ca: testRoot.toString(),
        pfx: Buffer.from(testCredentials.pfx, "base64"),
        passphrase: testCredentials.passphrase,
      });
      checkExpiry("testServerCertificate.expiry", leaf);
      for (const issuer of issuers.filter(
        c => c.fingerprint256 !== testRoot.fingerprint256,
      ))
        checkExpiry("testServerIssuingCa.expiry", issuer);
    } catch (error) {
      failWith("testServerCertificate.chain", error);
    }
  }
} catch (error) {
  failWith("liveCheck", error);
}

if (resultPath !== undefined)
  writeFileSync(resultPath, `${JSON.stringify({ version: 1, steps })}\n`);
const failed = steps.filter(({ outcome }) => outcome === "fail");
if (failed.length === 0) {
  log("Live check passed.");
} else {
  log(`Live check failed: ${failed.map(({ step }) => step).join(", ")}.`);
  process.exitCode = 1;
}
