# Testing

You can test a BankID integration two ways:

- Against the **fake** in `bankid/testing`, in unit and end-to-end tests and in local development. It needs no certificate, no network and no phone.
- Against **BankID's test environment**, with BankID's public test certificate and a test BankID on your phone.

## The fake

`createFakeBankId()` returns a `transport` for `createBankIdClient` and controls to move orders along. Your code under test uses a normal client and does not know it is talking to a fake.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBankIdClient, describe } from "bankid";
import { createFakeBankId } from "bankid/testing";

test("a cancelled login shows RFA6", async () => {
  const fake = createFakeBankId();
  const bankid = createBankIdClient({
    environment: "test",
    transport: fake.transport,
  });

  const { orderRef } = await bankid.auth({ endUserIp: "192.0.2.1" });
  await fake.setPending(orderRef, "userSign");
  await fake.fail(orderRef, "userCancel");

  const result = await bankid.collect(orderRef);
  assert.equal(describe(result, { start: "qrCode" }), "RFA6");
});
```

### Controls

| Control                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fake.complete(orderRef, user, overrides?)` | Completes a pending order as `user` (`{ personalNumber, name?, givenName?, surname? }`). `overrides` replaces `device`, `bankIdIssueDate`, `stepUp` or `risk` in `completionData`, such as `{ risk: "high" }`. Any other field, or one of the wrong type, throws: `user`, `signature` and `ocspResponse` are always the fake's own. Both `user` and `overrides` are copied when you call it, so later changes to them have no effect. |
| `fake.fail(orderRef, hintCode)`             | Fails a pending order, for example with `"userCancel"` or `"certificateErr"`.                                                                                                                                                                                                                                                                                                                                                         |
| `fake.setPending(orderRef, hintCodes)`      | Sets the pending hint code. Given a list, each collect reports the next one and the last one stays.                                                                                                                                                                                                                                                                                                                                   |
| `fake.expire(orderRef)`                     | Fails a pending order with `expiredTransaction`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `fake.scan(orderRef, qrCode)`               | Scans a QR code as the BankID app would. It throws unless the code belongs to the order and is at most 3 seconds old, then sets the order to `userSign`.                                                                                                                                                                                                                                                                              |

The controls throw for an order that is unknown or no longer pending. `userCallConfirm` and `userDeclinedCall` are accepted only for phone orders, and `scan` refuses orders that have no QR code.

### What the fake does

It follows BankID's spec and guides:

- Every endpoint in the spec answers. Start requests are checked against the spec, and a bad one gets HTTP 400 `invalidParameters` with `details` such as `"Incorrect endUserIp"`. Payment requests get the same checks as the client makes before sending.
- `auth`, `sign`, `payment` and `payment.bulk` return an `orderRef`, `autoStartToken`, `qrStartToken` and `qrStartSecret`. Phone orders and `other.payment` return only an `orderRef`.
- A new order starts pending with `outstandingTransaction`.
- A new order with a personal number, while another order with that personal number is pending, gets `alreadyInProgress`, and the pending order fails with `cancelled`.
- A final state can be collected once. Then the order is gone and collect gets `invalidParameters` with `details` `"No such order"`. A completed order can be collected for 3 minutes and a failed one for 5.
- `cancel` removes the order.

Where BankID's documentation is silent, the fake makes a choice:

- An order that no app picks up within 30 seconds fails with `startFailed`. A scan, a pending hint code other than `outstandingTransaction` or `noClient`, or a final state counts as picked up. An order once picked up does not expire by itself.
- Cancelling an order that is already final succeeds.
- A phone order reaches `userCallConfirm` only when you set it.
- The `details` texts, apart from `"No such order"`.

Completion data has the spec's shape: `user`, `device` (with `ipAddress` from the order's `endUserIp`, except on phone orders), `bankIdIssueDate`, `stepUp` when the order required one, `risk: "low"` when the order asked for it, and a `signature` and `ocspResponse`.

### Controlling time

Pass `now` to test expiry and QR codes without waiting:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBankIdClient, qrCode } from "bankid";
import { createFakeBankId } from "bankid/testing";

test("the user scans the QR code after 5 seconds", async () => {
  let now = 1_800_000_000_000;
  const fake = createFakeBankId({ now: () => now });
  const bankid = createBankIdClient({
    environment: "test",
    transport: fake.transport,
  });

  const startedAt = now;
  const order = await bankid.auth({ endUserIp: "192.0.2.1" });
  now += 5000;
  await fake.scan(order.orderRef, qrCode(order, { startedAt, now }));

  assert.deepEqual(await bankid.collect(order.orderRef), {
    orderRef: order.orderRef,
    status: "pending",
    hintCode: "userSign",
  });
});
```

### Local development

With `autoComplete`, every order completes by itself after a delay, so you can click through your login without a phone. Until then it is pending with `userSign`. An order that requires a personal number completes with that number.

```ts
import { createBankIdClient } from "bankid";
import { createFakeBankId } from "bankid/testing";

const fake = createFakeBankId({
  autoComplete: {
    afterMs: 4000,
    user: { personalNumber: "190010101010", name: "Alex Johnson" },
  },
});

export const devBankId = createBankIdClient({
  environment: "test",
  transport: fake.transport,
});
```

### Several processes

The fake keeps orders in memory by default. On each write the fake looks at a few stored entries and removes orders that can no longer be collected, with their personal number lookups. It sets no timers. An order that an app picked up and that is still pending never expires by itself, as described above, so it stays in memory until something ends it: `fake.expire`, `fake.fail` or `fake.complete` and a collect, or a `cancel`. A new fake starts with an empty store. So a test that leaves such orders behind should end them, or create a new fake per test.

To share orders between processes, such as several instances of your server in an end-to-end test, give it a store with `get`, `set` and `delete`. Values are plain JSON. The fake works expiry out from the order's timestamps, so it needs no expiry from the store for correctness. But it deletes an order from your store only when the order is collected in a final state, cancelled, or read after it can no longer be collected. An order nobody touches again stays, so let your store expire the keys after a while, such as an hour: no order stays collectable longer than 5 minutes after it ends.

```ts
import {
  createFakeBankId,
  type FakeBankIdStore,
  type JsonValue,
} from "bankid/testing";

/** A store over any shared key-value service you already run in your tests. */
export function sharedStore(kv: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}): FakeBankIdStore {
  return {
    get: async key => {
      const text = await kv.get(key);
      return text === null ? undefined : (JSON.parse(text) as JsonValue);
    },
    set: (key, value) => kv.set(key, JSON.stringify(value)),
    delete: key => kv.del(key),
  };
}

export const fakeFor = (store: FakeBankIdStore) => createFakeBankId({ store });
```

The keys are `order:<orderRef>` and `personalNumber:<personalNumber>`. The fakes in one process that share a store object, including fakes from the ES module and CommonJS builds, run the operations on an order one at a time, so of two collects of a final state at the same moment only one gets it. Fakes in different processes sharing a store cannot promise that with `get`, `set` and `delete` alone: two of them can both collect the same final state, or both start an order for the same personal number.

### Keeping the fake out of production

The fake's `signature` and `ocspResponse` decode from base64 to text that contains `fakeMarker`. No real BankID response does. If a fake could ever reach your production system by mistake, refuse completion data that contains it:

```ts
import { Buffer } from "node:buffer";
import type { CompletionData } from "bankid";
import { fakeMarker } from "bankid/testing";

export function isFromFake(completion: CompletionData): boolean {
  return [completion.signature, completion.ocspResponse].some(field =>
    Buffer.from(field ?? "", "base64")
      .toString("utf8")
      .includes(fakeMarker),
  );
}
```

## BankID's test environment

BankID's [test environment](https://developers.bankid.com/getting-started/environments) is free and open to all. You need three things:

1. BankID's test certificate. `testCredentials` from `bankid/testing` is BankID's public `FPTestcert5_20240610.p12` and its passphrase, `qwerty123`. It works only with `environment: "test"`.
2. The BankID app configured for test. BankID [explains how](https://developers.bankid.com/test-portal/bankid-for-test); on a phone you reinstall the app to switch.
3. A test BankID, which you [issue yourself](https://developers.bankid.com/test-portal/testing) for any personal number. BankID recommends test personal numbers from the Swedish Tax Agency, since common ones are shared by many testers.

```ts
import { createBankIdClient, qrCode } from "bankid";
import { testCredentials } from "bankid/testing";

const bankid = createBankIdClient({
  environment: "test",
  credentials: testCredentials,
});

const order = await bankid.auth({ endUserIp: "192.0.2.1" });
const startedAt = Date.now();
// Turn each code into a QR image with any QR tool, within 30 seconds.
const timer = setInterval(
  () => console.log(qrCode(order, { startedAt })),
  1000,
);

try {
  for await (const result of bankid.watch(order.orderRef)) {
    console.log(
      result.status,
      result.status === "complete"
        ? result.completionData.user
        : result.hintCode,
    );
  }
} finally {
  clearInterval(timer);
}
```

In the test environment the BankID app shows "BankID test" as your service name. There is no test BankID in production.
