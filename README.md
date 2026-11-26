# bankid

A TypeScript client for the Swedish [BankID](https://www.bankid.com/en/) relying-party API, version 6.0.

It covers every endpoint in BankID's [OpenAPI spec 6.1.11](https://developers.bankid.com/api-references/auth--sign/overview): identification, signing, payments, phone orders, collect and cancel. It also gives you the parts BankID's guides ask you to get right yourself: the animated QR code, the return URL nonce, the recommended user messages, and a fake BankID for tests.

The library has no runtime dependencies and holds no state. You keep the order wherever you like.

> Upgrading from 3.x? Read [Migrating from 3.x](docs/migrating-from-v3.md). 3.x keeps working with its `BankIdClientV6` client.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Entry points](#entry-points)
- [Create a client](#create-a-client)
- [Choose a flow](#choose-a-flow)
- [BankID on the same device](#bankid-on-the-same-device)
- [BankID on another device](#bankid-on-another-device)
- [BankID in a phone call](#bankid-in-a-phone-call)
- [Signing](#signing)
- [Payments](#payments)
- [Collecting](#collecting)
- [Cancelling](#cancelling)
- [Risk indication](#risk-indication)
- [Errors and user messages](#errors-and-user-messages)
- [Testing](#testing)
- [Certificates](#certificates)
- [Wrapping the built-in transport](#wrapping-the-built-in-transport)

## Requirements

- Node.js 22 or newer for the server entry point.
- A relying-party certificate from your bank for production. The test environment uses BankID's public test certificate, which this package includes.
- TypeScript is optional. The types work from TypeScript 4.9, with `moduleResolution` set to `node`, `node16`, `nodenext` or `bundler`.

The package ships ES modules and CommonJS.

## Install

While 4.0 is in beta, it is published under the `next` tag:

```sh
npm install bankid@next
```

## Entry points

| Import           | Use it in                         | What it holds                                                              |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `bankid`         | Your server (Node.js 22 or newer) | The client, the QR code, the return URL nonce, user messages, errors       |
| `bankid/client`  | Browsers and React Native         | The start URL, user messages, the types your server sends to the front end |
| `bankid/testing` | Tests and local development       | A fake BankID and BankID's public test certificate                         |

`bankid/client` uses no Node.js APIs. The test certificate is only reachable from `bankid/testing`.

## Create a client

Create one client when your server starts and reuse it. It keeps connections to BankID open between calls.

```ts file=bankid.ts
import { readFileSync } from "node:fs";
import { createBankIdClient } from "bankid";

export const bankid = createBankIdClient({
  environment: "production", // or "test"; there is no default
  credentials: {
    pfx: readFileSync("/run/secrets/bankid.p12"),
    passphrase: process.env.BANKID_PASSPHRASE ?? "",
  },
});
```

- `environment` picks BankID's production or test service. You must choose one.
- `credentials` is your relying-party certificate as contents, never as a file path. Pass `{ pfx, passphrase }` with the PKCS#12 file's bytes or the same bytes as a base64 string, or `{ cert, key, passphrase? }` in PEM form. A bad certificate or passphrase, or a file path given as `pfx`, throws when you create the client, not on the first call.
- `ca` is optional. It defaults to BankID's root CA for the environment, which the package includes. See [Certificates](#certificates).
- `timeoutMs` is optional, in whole milliseconds. A request that takes longer fails with a `BankIdTransportError`. The default is 10 000.

The samples below import this client as `bankid` from `./bankid.js`.

## Choose a flow

BankID starts an order in one of three ways. Pick by where the user's BankID app is.

| The user is                                   | Flow                                                     | Start with                                  |
| --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| On the device that has the BankID app         | [Same device](#bankid-on-the-same-device): autostart     | `auth`, `sign` or `payment`                 |
| On a computer, with the BankID app on a phone | [Another device](#bankid-on-another-device): animated QR | `auth`, `sign` or `payment`                 |
| On the phone with you                         | [Phone call](#bankid-in-a-phone-call)                    | `phone.auth`, `phone.sign`, `phone.payment` |

Every order then ends the same way: your server [collects](#collecting) it every 2 seconds until it is complete or failed.

It is not always possible to tell whether the user has the BankID app on the device they are using. BankID [recommends](https://developers.bankid.com/use-cases/fallback) offering the other flow as a fallback: a QR code next to "Open BankID on this device", or "Open BankID on this device" next to a QR code. The same order serves both, since `auth` returns an autostart token and the QR code data.

You cannot start an order with a personal number. `requirement.personalNumber` only limits who may complete it.

## BankID on the same device

Your front end opens the BankID app with the order's autostart token. When the user is done, the BankID app opens your return URL. Your server checks that the order completed and that the browser that comes back is the one that started it. This is BankID's [same-device flow](https://developers.bankid.com/use-cases/mobile-bankid-on-the-same-device) with a [return URL](https://developers.bankid.com/how-to-guides/return-url).

1. Your server makes a return URL with a fresh nonce, starts the order with it, and keeps the nonce and the `orderRef` in the user's session.
2. Your front end opens the BankID app with `startUrl`.
3. Your server collects the order as usual, and saves the result in the session when it is `complete`.
4. The BankID app opens the return URL. Your page reads the nonce from the URL fragment and sends it to your server. The server logs the user in only if `verifyReturn` accepts the nonce and the session holds the completed result of that order.

A matching nonce shows only that the user came back to the browser that started the order. Who they are comes from the completed collect result, never from the nonce.

On the server:

```ts
import {
  createReturnUrl,
  verifyReturn,
  type CollectComplete,
  type CollectResponse,
} from "bankid";
import { bankid } from "./bankid.js";

/** What the user's session holds for a login on their own device. */
export interface SameDeviceLogin {
  orderRef: string;
  nonce: string;
  /** Saved by your collect when the order completes. */
  completed?: CollectComplete;
}

/** Starts the login. Keep the session on the server. */
export async function startLogin(endUserIp: string) {
  const { returnUrl, nonce } = createReturnUrl("https://example.com/login");
  const order = await bankid.auth({ endUserIp, returnUrl });
  const session: SameDeviceLogin = { orderRef: order.orderRef, nonce };
  // Send only the autostart token to the front end. It needs nothing else.
  return { session, autoStartToken: order.autoStartToken };
}

/** Call with each collect result of the session's order. */
export function saveResult(session: SameDeviceLogin, result: CollectResponse) {
  if (result.status === "complete" && result.orderRef === session.orderRef)
    session.completed = result;
}

/** The user to log in, or undefined. Called with the nonce from the return page. */
export function finishLogin(
  session: SameDeviceLogin,
  returnedNonce: string | null,
) {
  if (!verifyReturn({ expected: session.nonce, received: returnedNonce }))
    return undefined;
  return session.completed?.completionData.user;
}
```

- `createReturnUrl` adds `#nonce=<random>` to your URL, 50 characters. The URL must not have a fragment already. BankID allows at most 512 characters in all, and `createReturnUrl` throws if the result is longer.
- `verifyReturn` compares in constant time and returns `false` when either value is missing or empty.
- When the order completes, check that `completionData.device.ipAddress` matches the user's IP address as your server sees it. BankID's [same-device guide](https://developers.bankid.com/use-cases/mobile-bankid-on-the-same-device) asks for this to prevent session fixation.

In the browser or app:

```ts
import { startUrl } from "bankid/client";

/** Opens the BankID app. Call it from a click, so the browser allows it. */
export function openBankId(autoStartToken: string, onPhoneOrTablet: boolean) {
  const link = document.createElement("a");
  link.href = startUrl({
    autoStartToken,
    device: onPhoneOrTablet ? "phone" : "desktop",
  });
  link.referrerPolicy = "origin";
  link.click();
}

/** On the page the return URL points to: the nonce to send to your server. */
export const returnedNonce = new URLSearchParams(location.hash.slice(1)).get(
  "nonce",
);
```

`startUrl` gives `https://app.bankid.com/?autostarttoken=…` for a phone or tablet and `bankid:///?autostarttoken=…` for a computer, as BankID's [autostart guide](https://developers.bankid.com/how-to-guides/autostart) describes. Telling the two apart is up to you. A native app opens the phone URL too: as a universal link on iOS and with an `ACTION_VIEW` intent on Android.

`startUrl` never adds a `redirect` parameter. BankID has deprecated it and ignores it when the order has a `returnUrl`. A native app passes its own return URL, such as `myapp://login`, to `createReturnUrl`, which adds the nonce.

If the user's desktop BankID app is too old to read the return URL from the order, BankID cancels the order and asks the user to update.

## BankID on another device

The user scans an animated QR code with the BankID app on their phone. This is BankID's [other-device flow](https://developers.bankid.com/use-cases/mobile-bankid-on-another-device). The QR code changes every second, and only your server can compute it.

1. Your server starts the order and keeps it, with the time BankID answered.
2. Your front end asks your server for the QR code every second and draws it.
3. Your server collects the order every 2 seconds until the user has scanned the code and finished.

On the server:

```ts
import { qrCode, type OrderResponse } from "bankid";
import { bankid } from "./bankid.js";

/** What your server keeps for an order shown as a QR code. Never send it to the front end. */
export interface QrOrder {
  order: OrderResponse;
  startedAt: number;
}

export async function startQrLogin(endUserIp: string): Promise<QrOrder> {
  const order = await bankid.auth({ endUserIp });
  return { order, startedAt: Date.now() };
}

/** The QR code data right now. Your front end asks for it every second. */
export function currentQrCode({ order, startedAt }: QrOrder): string {
  return qrCode(order, { startedAt });
}
```

- `qrCode` returns `bankid.<qrStartToken>.<seconds>.<code>`, as in BankID's [QR code guide](https://developers.bankid.com/how-to-guides/qr-code). Compute it when it is asked for, not in advance.
- `qrStartSecret` must stay on your server. Send only the result of `qrCode`.
- An order that nobody scans fails after 30 seconds. To show a QR code for longer, start a new order, for example when the user presses an "extend" button. BankID's guide suggests up to five minutes in total.

[With several server instances](#with-several-server-instances) says how to serve the QR code next to the order's status.

In the browser, draw the QR code with any QR library. BankID asks for black on white, never inverted, a low error correction level, and a button that shows the code full screen. This package has no UI.

## BankID in a phone call

You are on a call with the user and want to identify them or have them sign. You start the order with their personal number and tell them to open the BankID app, where the order is waiting. There is no QR code and no autostart.

```ts
import { describe, type UserMessage } from "bankid";
import { bankid } from "./bankid.js";

/** Identifies the person your agent is talking to. Returns their name. */
export async function identifyCaller(
  personalNumber: string,
  showAgent: (message: UserMessage | undefined) => void,
): Promise<string | undefined> {
  const { orderRef } = await bankid.phone.auth({
    callInitiator: "user", // "RP" when you called them
    personalNumber,
    userVisibleData: "You are identifying yourself to Example Bank",
  });
  for await (const result of bankid.watch(orderRef)) {
    showAgent(describe(result, { start: "phoneCall" }));
    if (result.status === "complete") return result.completionData.user?.name;
  }
  return undefined;
}
```

- `callInitiator` tells BankID who placed the call. BankID treats [incoming and outgoing calls](https://developers.bankid.com/api-references/auth--sign/overview) differently.
- Phone orders take no `endUserIp`, `returnUrl`, `returnRisk`, `web` or `app`. The response is `{ orderRef }` only.
- While the user confirms the call, collect reports `userCallConfirm`. If they decline, the order fails with `userDeclinedCall`.
- `phone.sign` and `phone.payment` work the same way.

## Signing

`sign` works like `auth` and uses the same flows. `userVisibleData` is required: it is the text the user signs.

```ts
import { bankid } from "./bankid.js";

export async function startSigning(endUserIp: string) {
  return bankid.sign({
    endUserIp,
    userVisibleData: "I accept the terms of my loan agreement",
    userNonVisibleData: "agreement-id=1234", // signed but not shown
  });
}
```

Text fields are plain strings. The library base64-encodes them. Set `userVisibleDataFormat: "simpleMarkdownV1"` to use BankID's [formatting](https://developers.bankid.com/how-to-guides/formatting-text/overview). BankID accepts text with invalid formatting, such as `**bold**` for `*bold*`; the app then shows an error and the order fails with `userCancel`, so test your texts in BankID's [test portal](https://developers.bankid.com/test-portal/testing/test-formatted-descriptive-text).

## Payments

`payment` asks the user to approve a transaction, such as a card purchase or a bank transfer. Start the BankID app and collect the order as for `sign`.

```ts
import { bankid } from "./bankid.js";

export async function approvePurchase(endUserIp: string) {
  const order = await bankid.payment({
    endUserIp,
    userVisibleTransaction: {
      transactionType: "card",
      recipient: { name: "Example Shop" },
      money: { amount: "249,00", currency: "SEK" },
      riskWarning: "newRecipient", // at most one warning, shown in the app
    },
  });
  // Keep both on the server: the order for its autostart token and QR code,
  // the start time for the QR code.
  return { order, startedAt: Date.now() };
}
```

The request types follow the spec's rules for each transaction type, so TypeScript catches `money` on a non-payment authentication or a transfer without a `date`. Rules a type cannot express, such as lengths and patterns, are checked before sending: the call rejects with a `TypeError` that names the field and the rule, never the value.

`payment.bulk`, `phone.payment`, `phone.payment.bulk` and `other.payment` cover the other cases. Payment orders need BankID app 7.46 or newer. See [Payments](docs/payments.md) for every transaction type and endpoint.

## Collecting

Collect an order every 2 seconds until its status is `complete` or `failed`, then stop. BankID's [collect endpoint](https://developers.bankid.com/api-references/auth--sign/overview) asks for this cadence.

`collect` returns a union on `status`:

| `status`   | What it has      | What to do                                                             |
| ---------- | ---------------- | ---------------------------------------------------------------------- |
| `pending`  | `hintCode`?      | Show the user the matching message and collect again in 2 seconds.     |
| `complete` | `completionData` | The user is done. Check `completionData` and keep it for your records. |
| `failed`   | `hintCode`?      | Show the message. Start a new order if the user wants to try again.    |

BankID returns a final status once. After that, and once an order is too old, collect fails with `invalidParameters`. Completed orders can be collected for 3 minutes and failed ones for 5.

`completionData` holds `user` (personal number and name), `device`, `bankIdIssueDate`, `stepUp`, `risk` when you asked for it, and the `signature` and `ocspResponse`. BankID asks you to keep it for audit. Hint codes are open strings: BankID may add new ones without notice, and [`describe`](#errors-and-user-messages) handles them. BankID's spec does not require a hint code, so `hintCode` is optional; `describe` handles a missing one as an unknown one.

### In a single process: `watch`

`watch` collects until the order is final and yields each result. It makes the first call at once, then one every 2 seconds, counted from the end of the previous call. Errors whose `retryable` is true are retried quietly, up to `maxConsecutiveRetries` (default 5, at most 100) in a row; then the last one is thrown, and you show RFA5. The count starts again after each successful collect. Any other error is thrown at once.

```ts
import { bankid } from "./bankid.js";

export async function waitForOrder(orderRef: string, signal: AbortSignal) {
  for await (const result of bankid.watch(orderRef, { signal })) {
    if (result.status === "pending") console.log("waiting:", result.hintCode);
    else return result;
  }
  return undefined; // aborted
}
```

`watch` keeps its loop in the process that called it. Use it in scripts, workers, and servers that run as one process.

### With several server instances

When several instances of your server share the work, the request that started the order and the next request from the same user may reach different instances. Do not hold a `watch` loop in one of them. Keep the order in a store every instance can reach, such as your session store or database, let your front end ask your server for the status about once a second, and keep to these rules:

- **One collector per order at a time.** Claim the order atomically in your store before you collect it, and make the claim outlast the client's `timeoutMs`, so a slow collect still holds it.
- **Every 2 seconds.** Record the time of the attempt when you claim it, not when the collect returns, and claim only when the last attempt is at least 2 seconds old. A collect that fails or is slow then still counts, and no other instance repeats it at once.
- **Serve the QR code on its own.** Compute it from the stored order on every status request, whether or not that request collects, so a slow collect never freezes it.
- **Save and process the final result before you report it.** BankID returns `complete` or `failed` only once. Save it in your store, process it (log the user in, keep the signature) in a way that is safe to run twice for the same `orderRef`, and only then tell the front end the order is complete. If saving fails, do not act on the result: show an error, such as RFA22, and let the user start a new order.

The library calls in such a handler are these:

```ts
import { qrCode, type CollectResponse, type OrderResponse } from "bankid";
import type { RelayedStatus } from "bankid/client";
import { bankid } from "./bankid.js";

/** The QR code on every status request, from what your store keeps. */
export const currentQrCode = (order: OrderResponse, startedAt: number) =>
  qrCode(order, { startedAt });

/** One collect, made only by the instance that holds the claim. */
export const collectOnce = (orderRef: string): Promise<CollectResponse> =>
  bankid.collect(orderRef);

/** The parts of a collect result the front end may see. */
export const relay = (result: CollectResponse): RelayedStatus =>
  result.status === "complete"
    ? { status: "complete" }
    : result.status === "pending"
      ? { status: "pending", hintCode: result.hintCode }
      : { status: "failed", hintCode: result.hintCode };
```

`RelayedStatus` from `bankid/client` is plain JSON: the status and hint code, and the QR code while the order is pending. It carries nothing from the completed order. In the browser:

```ts
import { describe, type RelayedStatus, type UserMessage } from "bankid/client";

/** Polls your server and shows the QR code and message until the order is final. */
export async function showOrder(
  url: string,
  show: (qrCode: string | undefined, message: UserMessage | undefined) => void,
): Promise<"complete" | "failed"> {
  for (;;) {
    const status = (await (await fetch(url)).json()) as RelayedStatus;
    show(
      status.status === "pending" ? status.qrCode : undefined,
      describe(status, { start: "qrCode" }),
    );
    if (status.status !== "pending") return status.status;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

## Cancelling

Cancel an order that is still pending when the user gives up, for example when they press "Cancel" or leave the page, or before you start a new order for the same user.

```ts
import { bankid } from "./bankid.js";

export async function cancelLogin(orderRef: string) {
  await bankid.cancel(orderRef);
}
```

After a cancel, collect fails with `invalidParameters`.

If you start an order with a `requirement.personalNumber` while another order for that personal number is pending, BankID refuses the new order with `alreadyInProgress` and cancels the pending one. Tell the user (`describe` gives RFA4) and let them start again.

## Risk indication

BankID can tell you how likely it is that an order was started by a fraudster. Ask for it with `returnRisk: true` and give BankID as much as you know about the user's device. This is BankID's [risk indication](https://developers.bankid.com/how-to-guides/risk-indication).

```ts
import type { CompletionData } from "bankid";
import { bankid } from "./bankid.js";

export async function startWithRisk(
  endUserIp: string,
  userAgent: string,
  deviceIdentifier: string,
) {
  return bankid.auth({
    endUserIp, // must be the user's own address, not a proxy's
    returnRisk: true,
    web: { referringDomain: "example.com", userAgent, deviceIdentifier },
  });
}

export function acceptRisk({ risk }: CompletionData): boolean {
  switch (risk) {
    case "high":
      return false; // BankID recommends stopping the order
    case "moderate":
      return false; // weigh it against what is at stake, or ask for an extra control
    case "low":
    case undefined: // BankID could not calculate it
      return true;
    default:
      return false; // a level BankID added later
  }
}
```

- Send `web` from a web page or `app` from your own app (`appIdentifier`, `deviceOS`, `deviceModelName`, `deviceIdentifier`), not both. `deviceIdentifier` must not be a session cookie; use a separate long-lived value or a hash of one.
- `risk` is in `completionData` when the order completes: `"low"`, `"moderate"` or `"high"`, or missing when BankID could not calculate it. BankID's guide calls the middle level "medium"; the API sends `"moderate"`. The type, `RiskLevel`, also allows any other string, since BankID may add levels; the sample above accepts only the levels it knows.
- For a "moderate" risk you can start a new order with `requirement: { stepUp: ["mrtd"] }`, BankID's [extra control](https://developers.bankid.com/how-to-guides/extra-control).
- Phone orders have no risk indication.

## Errors and user messages

The client throws two error classes. Neither holds the request body or your credentials.

| Class                  | When                                 | Fields                                                                                                |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `BankIdApiError`       | BankID answered with an error status | `errorCode`, `details`, `status`, `path`, `retryable`                                                 |
| `BankIdTransportError` | No usable response                   | `reason` (`timeout`, `aborted`, `network`, `invalidResponse`), `path`, `status`, `retryable`, `cause` |

`invalidResponse` means a response whose HTTP status is not a whole number from 100 to 599, or BankID, or something in between such as a proxy, answered with a success status but a body without the fields BankID's spec requires for the endpoint: the start tokens of an order, or a collect `status` of `pending`, `complete` or `failed`, with `completionData` for `complete`. A `hintCode`, which the spec does not require, must be a string when present, and so must the known fields of `completionData`, such as `signature`; `user.personalNumber` must be 12 digits. A collect result for another `orderRef` than the one asked for is `invalidResponse` too. Unknown hint codes, risk levels and fields BankID adds later pass through. `status` is the HTTP status of an `invalidResponse` when it was a valid status code, and undefined otherwise.

What they contain, so you can decide what to log:

- `details` is the text BankID returned with the error, as a string of at most 1000 characters. It is free text that BankID, or a proxy in between, may fill with request data, so every run of 10 or more digits, such as a personal number, is replaced by `[redacted]`. The rest is kept as it came. `toJSON` leaves `details` out; log it only where request data may be logged.
- `cause` is never the value a transport threw or your signal's abort reason. It is a new frozen plain object with only these fields, each kept only when its value has this form: `name` and `code` an identifier such as `ECONNRESET` (a letter, then up to 63 letters, digits or `_`), `errno` a whole number from -9999 to 9999, `syscall` up to 32 lowercase letters or `_`, `hostname` a DNS name, `address` an IP address without a zone index (`%...`), and `port` a whole number from 0 to 65535. A string with a run of 10 or more digits, which may be a personal number, is dropped from every field, and anything else is dropped too. For a socket failure of the default transport it also has Node's `message` about the connection, as the transport saw it. `toJSON` leaves `cause` out.
- Anything a custom transport throws, or a signal gives as its abort reason, becomes a new `BankIdTransportError`, even when it is itself a `BankIdApiError` or `BankIdTransportError`. Return an error status from a transport instead of throwing.

`retryable` is true only for `maintenance`, the one error BankID's [errors guide](https://developers.bankid.com/api-references/errors) lets you retry without telling the user. Do not retry anything else automatically. `watch` retries `maintenance` for you, up to 5 times in a row.

Bad arguments throw a `TypeError` that names the field, never its value, before anything is sent: a missing environment, an `auth`, `sign`, `payment` or `payment.bulk` without an IP address as `endUserIp`, a `phone.auth` or `phone.sign` without `callInitiator` as `"user"` or `"RP"` or a 12-digit `personalNumber`, a `sign` or `phone.sign` without `userVisibleData`, or a payment BankID would refuse.

```ts
import { BankIdApiError, BankIdTransportError, describe } from "bankid";
import { bankid } from "./bankid.js";

export async function startOrExplain(endUserIp: string) {
  try {
    return { order: await bankid.auth({ endUserIp }) };
  } catch (error) {
    if (error instanceof BankIdApiError) {
      // "RFA4" for alreadyInProgress, "RFA5" for maintenance, "RFA22" for anything unknown
      return { message: describe(error) };
    }
    if (error instanceof BankIdTransportError)
      return { message: "RFA5" as const };
    throw error;
  }
}
```

`errorCode` is BankID's code, such as `alreadyInProgress`. A code is kept only when it is an identifier (a letter, then up to 63 letters, digits or `_`) without a run of 10 or more digits; any other code becomes `"unknown"`. When the response has none, it is the code BankID documents for the HTTP status, or `"unknown"`. Error codes and hint codes are typed as the known values plus any other string, because BankID adds codes without notice.

### User messages

`describe` turns a collect result or an error into the name of one of BankID's [recommended user messages](https://developers.bankid.com/ui-resources/user-messages), such as `"RFA9"`. You supply the text in your own language and design.

- For a collect result, or a `RelayedStatus` on the front end, pass how the order was started: `{ start: "autoStart", device: "phone" }` or `device: "desktop"`, `{ start: "qrCode" }`, `{ start: "phoneCall" }` or `{ start: "other" }`. Some codes have a different message per start. A complete order gives `undefined`.
- For an error, pass the error, or anything with an `errorCode`.
- Unknown hint codes give RFA21 while pending and RFA22 when failed, and so does a result without a hint code. Unknown error codes give RFA22. That is what BankID requires.
- `notSupportedByUserApp` gives RFA22 too, since BankID names no message for it. But BankID asks you to tell the user to update the BankID app, so check for it yourself:

```ts
import { describe, type CollectResponse, type UserMessage } from "bankid";

/** What to show for a collect result: a message name, or "updateApp". */
export function messageName(
  result: CollectResponse,
): UserMessage | "updateApp" | undefined {
  if (result.status === "failed" && result.hintCode === "notSupportedByUserApp")
    return "updateApp"; // "Update your BankID app and try again."
  return describe(result, { start: "qrCode" });
}
```

`describe` is the same function in `bankid` and `bankid/client`, so your server and front end agree. [User messages](docs/user-messages.md) lists every code and the message it gets.

## Testing

`bankid/testing` has a fake BankID. Pass its `transport` to `createBankIdClient`, then script the order the way a user would move it.

```ts
import { createBankIdClient } from "bankid";
import { createFakeBankId } from "bankid/testing";

const fake = createFakeBankId();
const bankid = createBankIdClient({
  environment: "test",
  transport: fake.transport,
});

const { orderRef } = await bankid.auth({ endUserIp: "192.0.2.1" });
await fake.complete(orderRef, {
  personalNumber: "190010101010",
  name: "Alex Johnson",
});

const result = await bankid.collect(orderRef);
console.log(result.status); // "complete"
```

The fake follows the rules in BankID's spec and guides: request checks, one order per personal number, the 30-second start window, a final state collected once. It needs no certificate, no network and no phone.

To try the real test environment, use BankID's public test certificate and a test BankID on your phone:

```ts
import { createBankIdClient } from "bankid";
import { testCredentials } from "bankid/testing";

export const testBankId = createBankIdClient({
  environment: "test",
  credentials: testCredentials,
});
```

[Testing](docs/testing.md) covers the fake's controls, local development without a phone, sharing the fake between processes, and setting up a test BankID.

## Certificates

BankID uses mutual TLS. Two certificates are involved.

**Your relying-party certificate** identifies your organisation to BankID. You order it from the bank you have a BankID agreement with, as a PKCS#12 file. Production and test use different certificates. Read BankID's [certificate guide](https://developers.bankid.com/getting-started/order-certificate/request-a-certificate) to get one. Pass it as `credentials`, as contents: read the file or a secret yourself.

**BankID's root CA** lets your server trust BankID's server certificate. The package includes both, as text, and picks the one for your environment:

| Environment | Root CA                           | Valid until |
| ----------- | --------------------------------- | ----------- |
| production  | `BankID SSL Root CA v1`           | 2034-12-31  |
| test        | `Test BankID SSL Root CA v1 Test` | 2034-12-31  |

To trust other CAs, for example if BankID announces a new issuer, pass `ca` with one PEM certificate or a list of them. It replaces the bundled CA.

```ts
import { readFileSync } from "node:fs";
import { createBankIdClient } from "bankid";

export const bankidWithOwnCa = createBankIdClient({
  environment: "production",
  credentials: {
    pfx: readFileSync("/run/secrets/bankid.p12"),
    passphrase: process.env.BANKID_PASSPHRASE ?? "",
  },
  ca: [readFileSync("/etc/bankid/root-ca.pem", "utf8")],
});
```

If creating the client fails with "Could not load the BankID client certificate or CA" and the cause says `unsupported`, your PKCS#12 file uses an old cipher that OpenSSL 3 no longer reads. Convert it once. Without `-nodes`, OpenSSL asks for a pass phrase and keeps the private key encrypted in the intermediate file:

```sh
openssl pkcs12 -legacy -in old.p12 -out combined.pem
openssl pkcs12 -export -in combined.pem -out new.p12
rm combined.pem
```

Delete `combined.pem` as soon as `new.p12` works, and keep `new.p12` and its passphrase as secrets, like the original.

## Wrapping the built-in transport

`createNodeTransport` from `bankid` creates the transport the client uses when you pass `credentials`: HTTP/1.1 to BankID over mutual TLS. It takes the same `environment`, `credentials` and optional `ca`. Wrap it to add metrics, logging or a proxy, and pass the wrapper as `transport`:

```ts
import { readFileSync } from "node:fs";
import {
  createBankIdClient,
  createNodeTransport,
  type BankIdTransport,
} from "bankid";

const builtIn = createNodeTransport({
  environment: "production",
  credentials: {
    pfx: readFileSync("/run/secrets/bankid.p12"),
    passphrase: process.env.BANKID_PASSPHRASE ?? "",
  },
});

const timed: BankIdTransport = async request => {
  const started = performance.now();
  try {
    const response = await builtIn(request);
    console.log(request.path, response.status, performance.now() - started);
    return response;
  } catch (error) {
    console.log(request.path, "no response", performance.now() - started);
    throw error;
  }
};

export const bankidWithTimings = createBankIdClient({
  environment: "production",
  transport: timed,
});
```

The transport takes no timeout: the client's `timeoutMs` aborts each request's `signal`, which the built-in transport honours. Log the path and status, not the request body, which can hold personal numbers. Whatever a custom transport throws, including this wrapper, is rebuilt as a `BankIdTransportError` with reason `network`, as described under [Errors and user messages](#errors-and-user-messages).

## More

- [Migrating from 3.x](docs/migrating-from-v3.md)
- [Payments](docs/payments.md)
- [Testing](docs/testing.md)
- [User messages](docs/user-messages.md)
- [Development and releasing](docs/development.md)
- [Changelog](CHANGELOG.md)

## License

MIT
