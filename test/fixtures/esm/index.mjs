import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  BankIdApiError,
  BankIdTransportError,
  createBankIdClient,
  createNodeTransport,
  createReturnUrl,
  describe,
  qrCode,
  verifyReturn,
} from "bankid";
import { describe as describeInBrowser, startUrl } from "bankid/client";
import * as browserEntry from "bankid/client";
import {
  createFakeBankId,
  createMemoryStore,
  fakeMarker,
  testCredentials,
} from "bankid/testing";

if (
  startUrl({ autoStartToken: "a b", device: "phone" }) !==
    "https://app.bankid.com/?autostarttoken=a%20b" ||
  startUrl({ autoStartToken: "a b", device: "desktop" }) !==
    "bankid:///?autostarttoken=a%20b"
)
  throw new Error("unexpected start URL");
if (describeInBrowser({ errorCode: "maintenance" }) !== "RFA5")
  throw new Error("unexpected message");

const fail = message => {
  throw new Error(message);
};

const requests = [];
const bankid = createBankIdClient({
  environment: "test",
  transport: async request => {
    requests.push(request);
    return request.path === "/collect"
      ? { status: 503, body: "" }
      : {
          status: 200,
          body: '{"orderRef":"ref","autoStartToken":"a","qrStartToken":"q","qrStartSecret":"s"}',
        };
  },
});
const order = await bankid.sign({ endUserIp: "::1", userVisibleData: "Åsa" });
if (order.orderRef !== "ref") fail("unexpected order");
if (
  requests[0].path !== "/sign" ||
  requests[0].body.userVisibleData !== "w4VzYQ=="
)
  fail("unexpected sign request");
const error = await bankid.collect("ref").catch(e => e);
if (
  !(error instanceof BankIdApiError) ||
  error.errorCode !== "maintenance" ||
  !error.retryable
)
  fail("unexpected collect error");
if (typeof BankIdTransportError !== "function")
  fail("missing BankIdTransportError");
// A success response without the fields the spec requires is refused.
const malformed = await createBankIdClient({
  environment: "test",
  transport: async () => ({ status: 200, body: '{"orderRef":"ref"}' }),
})
  .sign({ endUserIp: "::1", userVisibleData: "x" })
  .catch(e => e);
if (
  !(malformed instanceof BankIdTransportError) ||
  malformed.reason !== "invalidResponse"
)
  fail("unexpected handling of a malformed response");

// Order helpers: the worked example in BankID's QR code guide.
const qr = qrCode(
  {
    qrStartToken: "67df3917-fa0d-44e5-b327-edcc928297f8",
    qrStartSecret: "d28db9a7-4cde-429e-a983-359be676944c",
  },
  { startedAt: 0, now: 1500 },
);
if (
  qr !==
  "bankid.67df3917-fa0d-44e5-b327-edcc928297f8.1.949d559bf23403952a94d103e67743126381eda00f0b3cbddbf7c96b1adcbce2"
)
  fail(`unexpected QR code ${qr}`);
const { returnUrl, nonce } = createReturnUrl("https://example.com/login");
if (returnUrl !== `https://example.com/login#nonce=${nonce}`)
  fail("unexpected return URL");
if (!verifyReturn({ expected: nonce, received: nonce }))
  fail("nonce not verified");
if (verifyReturn({ expected: nonce, received: undefined }))
  fail("missing nonce verified");
if (
  describe(
    { orderRef: "ref", status: "failed", hintCode: "startFailed" },
    { start: "qrCode" },
  ) !== "RFA17B" ||
  describe({ errorCode: "somethingNew" }) !== "RFA22" ||
  describe({ orderRef: "ref", status: "pending" }, { start: "qrCode" }) !==
    "RFA21" ||
  describeInBrowser(
    { status: "failed", hintCode: "userCancel" },
    { start: "qrCode" },
  ) !== "RFA6" ||
  describe({ status: "complete" }, { start: "qrCode" }) !== undefined
)
  fail("unexpected user message");

// watch: collect once at once, then end on the final state.
const watcher = createBankIdClient({
  environment: "test",
  transport: async () => ({
    status: 200,
    body: '{"orderRef":"ref","status":"complete","completionData":{}}',
  }),
});
const statuses = [];
for await (const result of watcher.watch("ref")) statuses.push(result.status);
if (statuses.join() !== "complete") fail("unexpected watch results");

// The fake: a full QR flow through the client, collected with watch.
const fake = createFakeBankId();
const viaFake = createBankIdClient({
  environment: "test",
  transport: fake.transport,
});
const startedAt = Date.now();
const started = await viaFake.auth({ endUserIp: "192.0.2.1" });
const seen = [];
for await (const result of viaFake.watch(started.orderRef, { intervalMs: 1 })) {
  seen.push(result.status === "pending" ? result.hintCode : result.status);
  if (
    result.status === "pending" &&
    result.hintCode === "outstandingTransaction"
  )
    await fake.scan(started.orderRef, qrCode(started, { startedAt }));
  else if (result.status === "pending")
    await fake.complete(started.orderRef, { personalNumber: "190010101010" });
  else if (
    result.status !== "complete" ||
    result.completionData.device.ipAddress !== "192.0.2.1" ||
    !Buffer.from(result.completionData.signature, "base64")
      .toString("utf8")
      .includes(fakeMarker)
  )
    fail("unexpected completion data");
}
if (seen.join() !== "outstandingTransaction,userSign,complete")
  fail(`unexpected fake flow ${seen.join()}`);
// The fake: a phone order, with the call confirmation, then a declined call.
const phoneOrder = await viaFake.phone.auth({
  callInitiator: "RP",
  personalNumber: "190010101010",
});
if (Object.keys(phoneOrder).join() !== "orderRef")
  fail("unexpected phone order");
await fake.setPending(phoneOrder.orderRef, "userCallConfirm");
const phoneSeen = [];
for await (const result of viaFake.watch(phoneOrder.orderRef, {
  intervalMs: 1,
})) {
  phoneSeen.push(
    `${result.hintCode}:${describe(result, { start: "phoneCall" })}`,
  );
  if (result.status === "pending")
    await fake.fail(phoneOrder.orderRef, "userDeclinedCall");
}
if (phoneSeen.join() !== "userCallConfirm:RFA21,userDeclinedCall:RFA22")
  fail(`unexpected phone flow ${phoneSeen.join()}`);
// The fake: a card payment and a bulk payment, each to completion.
const cardOrder = await viaFake.payment({
  endUserIp: "192.0.2.1",
  userVisibleTransaction: {
    transactionType: "card",
    recipient: { name: "Example Shop" },
    money: { amount: "100,00", currency: "SEK" },
  },
});
if (typeof cardOrder.qrStartToken !== "string") fail("unexpected card order");
const bulkOrder = await viaFake.payment.bulk({
  endUserIp: "192.0.2.1",
  userVisibleTransactionBulk: {
    payments: [
      {
        transactionType: "bankgiro",
        recipient: { name: "Example Utility", accountNumber: "5050-1055" },
        money: { amount: "100,00", currency: "SEK" },
        date: "2026-12-01",
      },
    ],
    sums: [{ amount: "100,00", currency: "SEK" }],
  },
});
const paid = [];
for (const { orderRef } of [cardOrder, bulkOrder]) {
  await fake.setPending(orderRef, "userSign");
  await fake.complete(orderRef, { personalNumber: "190010101010" });
  paid.push((await viaFake.collect(orderRef)).status);
}
if (paid.join() !== "complete,complete")
  fail(`unexpected payment results ${paid.join()}`);
const refused = await viaFake
  .payment({
    endUserIp: "192.0.2.1",
    userVisibleTransaction: {
      transactionType: "npa",
      recipient: { name: "Example Bank" },
      money: { amount: "1", currency: "SEK" },
    },
  })
  .catch(e => e);
if (
  !(refused instanceof TypeError) ||
  refused.message !==
    "payment: userVisibleTransaction.money is not allowed for transactionType npa"
)
  fail("unexpected payment check");
const second = createFakeBankId({ store: createMemoryStore() });
if (typeof second.transport !== "function") fail("no transport");

// A fake from the ESM build and one from the CommonJS build that share a store
// take turns on an order, so only one of two collects at once gets its final
// state.
{
  const commonJs = createRequire(import.meta.url)("bankid/testing");
  if (commonJs.createFakeBankId === createFakeBankId)
    fail("expected a separate CommonJS build of bankid/testing");
  const store = createMemoryStore();
  const fakes = [
    createFakeBankId({ store }),
    commonJs.createFakeBankId({ store }),
  ];
  const [first, second] = fakes.map(({ transport }) =>
    createBankIdClient({ environment: "test", transport }),
  );
  const { orderRef } = await first.auth({ endUserIp: "192.0.2.1" });
  await fakes[0].complete(orderRef, { personalNumber: "190010101010" });
  const results = await Promise.allSettled([
    first.collect(orderRef),
    second.collect(orderRef),
  ]);
  const outcomes = results
    .map(r => (r.status === "fulfilled" ? r.value.status : r.reason.errorCode))
    .sort()
    .join();
  if (outcomes !== "complete,invalidParameters")
    fail(`unexpected collects across the ESM and CommonJS fakes: ${outcomes}`);
}

// Loading credentials also loads the bundled root CA for each environment.
// The certificate file is not in the package; the package check copies it
// from the repository next to this file.
const pfx = readFileSync(
  new URL("./FPTestcert5_20240610.p12", import.meta.url),
);
for (const environment of ["production", "test"]) {
  createBankIdClient({
    environment,
    credentials: { pfx, passphrase: "qwerty123" },
  });
}

// The embedded test certificate is the file, and works as credentials.
if (Buffer.from(testCredentials.pfx, "base64").compare(pfx) !== 0)
  fail("testCredentials differ from the test certificate file");
createBankIdClient({ environment: "test", credentials: testCredentials });
const builtIn = createNodeTransport({
  environment: "test",
  credentials: testCredentials,
});
if (typeof builtIn !== "function") fail("createNodeTransport gave no function");
createBankIdClient({
  environment: "test",
  transport: request => builtIn(request),
});
if ("createNodeTransport" in browserEntry)
  fail("createNodeTransport is reachable from bankid/client");
