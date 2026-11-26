// Manual check of payment orders against BankID's test environment. It needs
// a person with a test BankID on a phone, so it is not part of the automated
// tests, and it is not published. Payment orders need BankID app 7.46 or newer.
//
// 1. Get a test BankID on a phone, with the BankID app (7.46 or newer)
//    configured for the test environment:
//    https://developers.bankid.com/test-portal/bankid-for-test
// 2. Build the package: pnpm build
// 3. Run, with the test BankID's personal number (12 digits):
//      node scripts/manual/payment.mjs <personalNumber> card payment
//    It prints a start URL. Open it on the phone (send it to yourself), so
//    the BankID app starts with the order. Note what the app shows: heading,
//    merchant, amount, warning. Approve.
// 4. Run again with `bankgiro payment` (a bank transfer with a date and a
//    warning) and approve.
// 5. Optionally run `card other` and `bankgiro phone`; for those, open the
//    BankID app yourself (and confirm the call for `phone`).
// 6. Copy each printed record and add what the app showed.
//
// It uses BankID's public test certificate, and every order is for the given
// personal number only. Ctrl-C cancels the order.
import { startUrl } from "../../dist/client.mjs";
import { createBankIdClient, describe } from "../../dist/index.mjs";
import { testCredentials } from "../../dist/testing.mjs";

const transactions = {
  card: {
    transactionType: "card",
    recipient: { name: "Manual Test Shop" },
    money: { amount: "123,45", currency: "SEK" },
    riskWarning: "largeAmount",
  },
  bankgiro: {
    transactionType: "bankgiro",
    recipient: { name: "Manual Test Payee", accountNumber: "5050-1055" },
    money: { amount: "678,90", currency: "SEK" },
    date: new Date().toISOString().slice(0, 10),
    riskWarning: "newRecipient",
  },
};

const [personalNumber, type = "card", endpoint = "payment"] =
  process.argv.slice(2);
if (
  !/^[0-9]{12}$/.test(personalNumber ?? "") ||
  !Object.hasOwn(transactions, type) ||
  !["payment", "phone", "other"].includes(endpoint) ||
  (endpoint === "other" && type !== "card")
) {
  console.error(
    "usage: node scripts/manual/payment.mjs <personalNumber> [card|bankgiro] [payment|phone|other]\n(other takes card only)",
  );
  process.exit(2);
}

const bankid = createBankIdClient({
  environment: "test",
  credentials: testCredentials,
});
const common = {
  userVisibleData: `Manual test of a ${type} payment`,
  userVisibleTransaction: transactions[type],
};
const startedAt = Date.now();
let orderRef;
let context;
if (endpoint === "payment") {
  const order = await bankid.payment({
    ...common,
    // BankID allows an internal address where the user's IP is not known.
    endUserIp: "127.0.0.1",
    requirement: { personalNumber },
  });
  orderRef = order.orderRef;
  context = { start: "autoStart", device: "phone" };
  console.log(
    `Started /payment (${type}). Open this on the phone:\n${startUrl({ ...order, device: "phone" })}`,
  );
} else if (endpoint === "phone") {
  ({ orderRef } = await bankid.phone.payment({
    ...common,
    callInitiator: "RP",
    personalNumber,
  }));
  context = { start: "phoneCall" };
  console.log(`Started /phone/payment (${type}). Open the BankID app.`);
} else {
  ({ orderRef } = await bankid.other.payment({ ...common, personalNumber }));
  context = { start: "other" };
  console.log(`Started /other/payment (${type}). Open the BankID app.`);
}

const controller = new AbortController();
process.once("SIGINT", () => {
  controller.abort();
  bankid.cancel(orderRef).then(
    () => console.log("Cancelled the order."),
    error => console.error("Cancel failed:", error),
  );
});

const seconds = () => ((Date.now() - startedAt) / 1000).toFixed(0);
const steps = [];
let last;
for await (const result of bankid.watch(orderRef, {
  signal: controller.signal,
})) {
  const message = describe(result, context);
  const step =
    result.status === "complete"
      ? "complete"
      : `${result.status} ${result.hintCode} (${message})`;
  if (step !== steps.at(-1)?.step) {
    steps.push({ at: seconds(), step });
    console.log(`${seconds()}s  ${step}`);
  }
  last = result;
}

const user = last?.status === "complete" ? last.completionData.user : undefined;
const path = {
  payment: "/payment",
  phone: "/phone/payment",
  other: "/other/payment",
};
console.log(`
--- record ---
Date: ${new Date(startedAt).toISOString()}
Endpoint: ${path[endpoint]}, transactionType ${type}
Collect statuses: ${steps.map(s => `${s.step} at ${s.at}s`).join(", ")}
Final collect status: ${last ? (last.status === "complete" ? "complete" : `${last.status} ${last.hintCode}`) : "none (cancelled)"}
Completion data for the same personal number: ${user ? user.personalNumber === personalNumber : "n/a"}
What the app showed: <fill in>
--------------`);
