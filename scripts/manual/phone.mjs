// Manual check of phone authentication and signing against BankID's test
// environment. It needs a person with a test BankID on a phone, so it is not
// part of the automated tests, and it is not published.
//
// 1. Get a test BankID on a phone, with the BankID app configured for the test
//    environment: https://developers.bankid.com/test-portal/bankid-for-test
// 2. Build the package: pnpm build
// 3. Run, with the test BankID's personal number (12 digits):
//      node scripts/manual/phone.mjs <personalNumber> auth RP
//    Open the BankID app on the phone, confirm the call when asked, and
//    identify. Note what the app shows at each step.
// 4. Run again with `sign user`, and sign.
// 5. Run once more with `auth user` and decline the call in the app. It should
//    end with `failed userDeclinedCall`.
// 6. Copy each printed record and add what the app showed.
//
// It uses BankID's public test certificate. Ctrl-C cancels the order.
import { createBankIdClient, describe } from "../../dist/index.mjs";
import { testCredentials } from "../../dist/testing.mjs";

const [personalNumber, endpoint = "auth", callInitiator = "RP"] =
  process.argv.slice(2);
if (
  !/^[0-9]{12}$/.test(personalNumber ?? "") ||
  !["auth", "sign"].includes(endpoint) ||
  !["user", "RP"].includes(callInitiator)
) {
  console.error(
    "usage: node scripts/manual/phone.mjs <personalNumber> [auth|sign] [user|RP]",
  );
  process.exit(2);
}

const bankid = createBankIdClient({
  environment: "test",
  credentials: testCredentials,
});
const text =
  endpoint === "auth"
    ? "Manual test of phone authentication"
    : "Manual test of phone signing";
const startedAt = Date.now();
const { orderRef } = await bankid.phone[endpoint]({
  callInitiator,
  personalNumber,
  userVisibleData: text,
});
console.log(`Started /phone/${endpoint}. Open the BankID app on the phone.`);

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
  const message = describe(result, { start: "phoneCall" });
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
console.log(`
--- record ---
Date: ${new Date(startedAt).toISOString()}
Endpoint: /phone/${endpoint}, callInitiator ${callInitiator}
Collect statuses: ${steps.map(s => `${s.step} at ${s.at}s`).join(", ")}
Final collect status: ${last ? (last.status === "complete" ? "complete" : `${last.status} ${last.hintCode}`) : "none (cancelled)"}
Completion data for the same personal number: ${user ? user.personalNumber === personalNumber : "n/a"}
What the app showed: <fill in>
--------------`);
