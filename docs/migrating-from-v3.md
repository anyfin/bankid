# Migrating from 3.x

4.0 is a new library with the same package name. Nothing from 3.x is kept for compatibility, so every call changes. This guide shows the common cases side by side, then maps every export, method and option of 3.2.1 to its replacement.

## Do you have to move?

- **`BankIdClient` no longer works.** It calls BankID's API version 5.1, which BankID [shut down on 30 September 2025](https://developers.bankid.com/news/rp-api-50-and-51-discontinued). Move to 4.0, or at least to 3.x's `BankIdClientV6`.
- **`BankIdClientV6` keeps working.** 3.x calls BankID's API version 6.0 with it, and BankID still serves that version. 3.x gets no new features.
- **4.0 needs Node.js 22 or newer.** 3.x declared Node.js 10.13. 4.0 has no runtime dependencies; 3.x used axios.

What you get by moving: payments, phone orders, the return URL nonce, risk indication, BankID's recommended user messages, typed errors that never hold the request, a QR code without a cache or timers, and a fake BankID for tests. 4.0 ships ES modules and CommonJS, so `require("bankid")` keeps working.

## The big changes

- **The environment is a required choice.** 3.x defaulted to the test environment with BankID's test certificate. In 4.0 you pass `environment: "production"` or `"test"`, and the test certificate is an explicit import from `bankid/testing`.
- **Certificates are contents, never paths.** 3.x read `pfx` and `ca` from a file when given a string. In 4.0 a string `pfx` is the file's bytes in base64, so passing a path fails when you create the client, with an error saying that a `pfx` string must be the file's bytes base64-encoded. The message never includes the string. Read the file yourself and pass its bytes, for example from `readFileSync`.
- **Methods take the order reference, not an object.** `collect({ orderRef })` is now `collect(orderRef)`.
- **No QR generator, cache or timers.** You keep the order and the time it started, and call `qrCode` when the front end asks.
- **No "and collect" helpers.** Start the order, then collect it yourself every 2 seconds or with `watch`.
- **Errors have new classes and fields**, and never hold the request.

## Before and after

The "after" samples use `bankid`, the client from [Create a client](../README.md#create-a-client) in the README, imported from `./bankid.js`.

### Creating a client

Before:

```ts v3
import { readFileSync } from "node:fs";
import { BankIdClientV6 } from "bankid";

export const client = new BankIdClientV6({
  production: true,
  pfx: readFileSync("certs/bankid.p12"), // or the path "certs/bankid.p12"
  passphrase: process.env.BANKID_PASSPHRASE ?? "",
});
```

After:

```ts
import { readFileSync } from "node:fs";
import { createBankIdClient } from "bankid";

export const client = createBankIdClient({
  environment: "production",
  credentials: {
    pfx: readFileSync("certs/bankid.p12"), // contents only, never a path
    passphrase: process.env.BANKID_PASSPHRASE ?? "",
  },
});
```

### Logging in with a QR code

3.x attached a `QrGenerator` to the response, kept the start time in a cache, and gave you a generator to loop over. In 4.0 you keep the order and its start time, and compute the code each time the front end asks, once a second. The QR code needs `qrStartSecret`, so it stays on your server. See [BankID on another device](../README.md#bankid-on-another-device).

Before:

```ts v3
import { BankIdClientV6 } from "bankid";

const client = new BankIdClientV6({ production: false });

export async function login(endUserIp: string, show: (qr: string) => void) {
  const { orderRef, qr } = await client.authenticate({ endUserIp });
  for await (const code of qr?.nextQr(orderRef, { timeout: 30 }) ?? []) {
    show(code);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return orderRef;
}
```

After:

```ts
import { qrCode } from "bankid";
import { bankid } from "./bankid.js";

export async function startLogin(endUserIp: string) {
  const order = await bankid.auth({ endUserIp });
  // Keep both on the server, for example in the user's session.
  return { order, startedAt: Date.now() };
}

/** Called by your front end once a second. */
export function currentQrCode(login: Awaited<ReturnType<typeof startLogin>>) {
  return qrCode(login.order, { startedAt: login.startedAt });
}
```

### Starting BankID on the same device

3.x's examples opened the app with a `redirect` parameter. BankID has deprecated it. In 4.0 the return URL goes in the order, with a nonce you check when the user comes back. See [BankID on the same device](../README.md#bankid-on-the-same-device).

Before:

```ts v3
import { BankIdClientV6 } from "bankid";

const client = new BankIdClientV6({ production: false });

export async function startOnThisDevice(endUserIp: string) {
  const { autoStartToken, orderRef } = await client.authenticate({ endUserIp });
  const redirect = encodeURIComponent("https://example.com/login");
  return {
    orderRef,
    link: `bankid:///?autostarttoken=${autoStartToken}&redirect=${redirect}`,
  };
}
```

After, on the server:

```ts
import { createReturnUrl } from "bankid";
import { bankid } from "./bankid.js";

export async function startOnThisDevice(endUserIp: string) {
  const { returnUrl, nonce } = createReturnUrl("https://example.com/login");
  const { orderRef, autoStartToken } = await bankid.auth({
    endUserIp,
    returnUrl,
  });
  // Keep orderRef and nonce in the session; send autoStartToken to the front end.
  return { orderRef, nonce, autoStartToken };
}
```

And in the browser:

```ts
import { startUrl } from "bankid/client";

export const link = (autoStartToken: string) =>
  startUrl({ autoStartToken, device: "desktop" }); // "phone" on a phone or tablet
```

### Waiting for the result

3.x's `awaitPendingCollect` resolved with a complete response and rejected with a failed one, which was a response object, not an `Error`. It made its first call after `refreshInterval` and stopped at the first error. `watch` yields every result, including pending ones with their hint code, ends after `complete` or `failed`, and retries `maintenance` quietly, up to 5 times in a row by default. It retries nothing else: any other error, including a timeout or a network failure, ends `watch` by throwing it. If your 3.x code retried other errors around `awaitPendingCollect`, keep that retry around `watch`. It makes its first call at once.

Before:

```ts v3
import { BankIdClientV6, type CollectResponseV6 } from "bankid";

const client = new BankIdClientV6({ production: false });

export async function waitForUser(orderRef: string) {
  try {
    const result = await client.awaitPendingCollect(orderRef);
    return result.completionData?.user;
  } catch (failure) {
    console.log((failure as CollectResponseV6).hintCode);
    return undefined;
  }
}
```

After:

```ts
import { bankid } from "./bankid.js";

export async function waitForUser(orderRef: string) {
  for await (const result of bankid.watch(orderRef)) {
    if (result.status === "complete") return result.completionData.user;
    if (result.status === "failed") console.log(result.hintCode);
  }
  return undefined;
}
```

`watch` holds the loop in one process. With several server instances, collect on each request from the front end instead; see [Collecting](../README.md#collecting).

### Signing

Before:

```ts v3
import { BankIdClientV6 } from "bankid";

const client = new BankIdClientV6({ production: false });

export const startSigning = (endUserIp: string) =>
  client.sign({ endUserIp, userVisibleData: "I accept the terms" });
```

After:

```ts
import { bankid } from "./bankid.js";

export const startSigning = (endUserIp: string) =>
  bankid.sign({ endUserIp, userVisibleData: "I accept the terms" });
```

Both encode `userVisibleData` and `userNonVisibleData` for you.

### Handling errors

Before:

```ts v3
import {
  BankIdClientV6,
  BankIdError,
  BankIdErrorCode,
  RequestError,
} from "bankid";

const client = new BankIdClientV6({ production: false });

export async function start(endUserIp: string) {
  try {
    return await client.authenticate({ endUserIp });
  } catch (error) {
    if (
      error instanceof BankIdError &&
      error.code === BankIdErrorCode.ALREADY_IN_PROGRESS
    )
      console.log("already in progress");
    else if (error instanceof RequestError) console.log("no response");
    throw error;
  }
}
```

After:

```ts
import { BankIdApiError, BankIdTransportError, describe } from "bankid";
import { bankid } from "./bankid.js";

export async function start(endUserIp: string) {
  try {
    return await bankid.auth({ endUserIp });
  } catch (error) {
    if (
      error instanceof BankIdApiError &&
      error.errorCode === "alreadyInProgress"
    )
      console.log("already in progress", describe(error)); // "RFA4"
    else if (error instanceof BankIdTransportError)
      console.log("no response:", error.reason);
    throw error;
  }
}
```

Error codes are strings now. Compare with `"alreadyInProgress"` rather than an enum member, and expect codes you do not know.

### Using the test environment

Before, the test certificate was the default:

```ts v3
import { BankIdClientV6 } from "bankid";

export const client = new BankIdClientV6({ production: false });
```

After, you import it:

```ts
import { createBankIdClient } from "bankid";
import { testCredentials } from "bankid/testing";

export const client = createBankIdClient({
  environment: "test",
  credentials: testCredentials,
});
```

For unit tests, use the fake instead. See [Testing](testing.md).

## Every export of 3.2.1

### Classes and values

| 3.x                    | 4.0                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `BankIdClient`         | Removed: it called API version 5.1, which BankID has shut down. Use `createBankIdClient`.                             |
| `BankIdClientV6`       | `createBankIdClient({ environment, credentials })`, which returns a `BankIdClient` object.                            |
| `QrGenerator`          | `qrCode(order, { startedAt })`. Removed, because the code needs only the order and its start time, which you keep.    |
| `BankIdError`          | `BankIdApiError`                                                                                                      |
| `RequestError`         | `BankIdTransportError`                                                                                                |
| `BankIdErrorCode`      | `KnownErrorCode` and `ErrorCode`, string literal types. Removed as an enum, because BankID adds codes without notice. |
| `REQUEST_FAILED_ERROR` | Removed. Check `error instanceof BankIdTransportError`.                                                               |
| `BankIdMethod`         | Removed. A custom transport gets the path as `BankIdPath`, such as `"/auth"`.                                         |

The 4.0 `BankIdClient` is an interface for the object `createBankIdClient` returns, not a class you construct.

### Types

| 3.x                  | 4.0                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `AuthRequestV5`      | `AuthRequest`. Its top-level `personalNumber` is gone: see [Request fields](#request-fields).     |
| `AuthRequestV6`      | `AuthRequest`                                                                                     |
| `SignRequest`        | `SignRequest`                                                                                     |
| `AuthResponse`       | `OrderResponse`                                                                                   |
| `SignResponse`       | `OrderResponse`                                                                                   |
| `CollectRequest`     | Removed: `collect` takes the `orderRef` string.                                                   |
| `CancelRequest`      | Removed: `cancel` takes the `orderRef` string.                                                    |
| `CancelResponse`     | Removed: `cancel` resolves with nothing.                                                          |
| `CollectResponseV5`  | `CollectResponse`, a union of `CollectPending`, `CollectComplete` and `CollectFailed`             |
| `CollectResponseV6`  | `CollectResponse`                                                                                 |
| `CompletionData`     | `CompletionData`, with the API 6.0 fields: see [Response fields](#response-fields).               |
| `CompletionDataV6`   | `CompletionData`                                                                                  |
| `PendingHintCode`    | `PendingHintCode`: the known codes plus any string.                                               |
| `FailedHintCode`     | `FailedHintCode`: the known codes plus any string.                                                |
| `ErrorResponse`      | The fields of `BankIdApiError`: `errorCode` and `details`.                                        |
| `BankIdRequest`      | Removed. A custom transport gets `BankIdTransportRequest`.                                        |
| `BankIdResponse`     | Removed. A custom transport returns `BankIdTransportResponse`.                                    |
| `QrCacheEntry`       | Removed, with the cache. Keep `qrStartToken`, `qrStartSecret` and the start time with your order. |
| `QrGeneratorCache`   | Removed. 4.0 has no storage interface.                                                            |
| `QrGeneratorOptions` | Removed. See `customCache` and `orderTTL` under [Client options](#client-options).                |

## Error fields

| 3.x                               | 4.0                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error.code` on `BankIdError`     | `error.errorCode` on `BankIdApiError`. When BankID sends no code, it is the code BankID documents for the HTTP status, or `"unknown"`.                |
| `error.details` on `BankIdError`  | `error.details` on `BankIdApiError`, an empty string when BankID sends none. Runs of 10 or more digits, such as a personal number, read `[redacted]`. |
| `error.request` on `RequestError` | Removed, because the request can hold personal data. `BankIdTransportError` has `reason`, `path` and a `cause` that keeps only fields such as `code`. |

Both 4.0 classes add `retryable`, true only for `maintenance`, and `toJSON` for logging. `toJSON` leaves out `BankIdApiError.details`, BankID's free text, and `BankIdTransportError.cause`, so log `details` yourself only where request data may be logged. `BankIdApiError` adds the HTTP `status` and the API `path`. An `errorCode` from BankID that is not an identifier, or that has a run of 10 or more digits, becomes `"unknown"`, so a proxy cannot put a personal number in it.

## Client methods and properties

These are the members of `BankIdClient` and `BankIdClientV6`.

| 3.x                                     | 4.0                                                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.authenticate(params)`           | `bankid.auth(request)`                                                                                                                                                                  |
| `client.sign(params)`                   | `bankid.sign(request)`                                                                                                                                                                  |
| `client.collect({ orderRef })`          | `bankid.collect(orderRef)`                                                                                                                                                              |
| `client.cancel({ orderRef })`           | `bankid.cancel(orderRef)`                                                                                                                                                               |
| `client.awaitPendingCollect(orderRef)`  | `bankid.watch(orderRef)`, which yields each result; see [Waiting for the result](#waiting-for-the-result).                                                                              |
| `client._awaitPendingCollect(orderRef)` | Removed; it was a deprecated alias. Use `bankid.watch(orderRef)`.                                                                                                                       |
| `client.authenticateAndCollect(params)` | Removed: call `bankid.auth`, then `bankid.watch`. Logging in needs the autostart token or QR code in between.                                                                           |
| `client.signAndCollect(params)`         | Removed: call `bankid.sign`, then `bankid.watch`.                                                                                                                                       |
| `client.options`                        | Removed. The client keeps its options to itself.                                                                                                                                        |
| `client.version`                        | Removed. 4.0 always calls API version 6.0.                                                                                                                                              |
| `client.axios`                          | Removed, with axios. Pass a `transport` to send requests your own way, for example through a proxy or with instrumentation; wrap `createNodeTransport` to keep the built-in mutual TLS. |
| `client.createAxiosInstance()`          | Removed. See `transport`.                                                                                                                                                               |

4.0 adds `payment`, `payment.bulk`, `phone.auth`, `phone.sign`, `phone.payment`, `phone.payment.bulk` and `other.payment`.

## QrGenerator members

| 3.x                                              | 4.0                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `new QrGenerator(response, options)`             | Keep `{ order, startedAt: Date.now() }` when `auth` or `sign` returns.        |
| `qr.nextQr(orderRef, { maxCycles, timeout })`    | `qrCode(order, { startedAt })`, called once a second while the code is shown. |
| `QrGenerator.latestQrFromCache(orderRef, cache)` | `qrCode(order, { startedAt })` with the order from your own store.            |
| `qr.cache`                                       | Removed: keep the order in your own session or store.                         |
| `qr.orderRef`                                    | `order.orderRef`                                                              |
| `QrGenerator.defaultOptions`                     | Removed, with the cache.                                                      |

## Client options

| 3.x                          | 4.0                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production`                 | `environment: "production"` or `"test"`. Required; there is no default.                                                                                  |
| `pfx`                        | `credentials.pfx`: the PKCS#12 bytes, or the same bytes base64-encoded. A path no longer works. Or `credentials.cert` and `credentials.key` in PEM form. |
| `passphrase`                 | `credentials.passphrase`. Required with `pfx`.                                                                                                           |
| `ca`                         | `ca`: PEM text or bytes, or a list of them. A path no longer works. Defaults to BankID's root CA for the environment, as before.                         |
| `refreshInterval`            | `watch(orderRef, { intervalMs })`. The default is 2000, as before.                                                                                       |
| `qrEnabled`                  | Removed: there is no QR generator to attach. Call `qrCode` when you need a code.                                                                         |
| `qrOptions`                  | Removed, with the generator.                                                                                                                             |
| `customCache`                | Removed. Keep the order in your own store; the library holds no state.                                                                                   |
| `orderTTL`                   | Removed. 3.x deleted cache entries after it with a timer; 4.0 sets no timers. An order nobody scans fails after 30 seconds.                              |
| `maxCycles`                  | Removed: call `qrCode` as often as you show a code.                                                                                                      |
| `timeout`                    | Removed: stop asking for codes when the order is no longer pending. Use `timeoutMs` to limit how long one request to BankID may take.                    |
| The default test certificate | `testCredentials` from `bankid/testing`.                                                                                                                 |

4.0 adds `timeoutMs` (10 000 by default) and `transport`.

## Request fields

| 3.x                                                                                                    | 4.0                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `endUserIp`                                                                                            | `endUserIp`. Phone orders take none.                                                                                                     |
| `personalNumber` (API 5.1)                                                                             | Removed by BankID in API 6.0: an order cannot be started for a personal number. `requirement.personalNumber` limits who may complete it. |
| `userVisibleData`, `userNonVisibleData`                                                                | The same, as plain text. The library encodes them, as 3.x did.                                                                           |
| `userVisibleDataFormat`                                                                                | The same. `"plaintext"` is now allowed besides `"simpleMarkdownV1"`.                                                                     |
| `requirement.cardReader`, `requirement.certificatePolicies`, `requirement.mrtd`, `requirement.pinCode` | The same. They are all optional now.                                                                                                     |
| `requirement.issuerCn`, `requirement.autoStartTokenRequired` (API 5.1)                                 | Removed by BankID in API 6.0.                                                                                                            |
| `requirement.allowFingerprint` (API 5.1)                                                               | Removed by BankID. `requirement.pinCode: true` asks for the security code even when the user has biometrics on.                          |

4.0 adds `returnUrl`, `returnRisk`, `web`, `app` and `requirement.stepUp`.

### Checks before sending

3.x threw an `Error` before sending when `endUserIp` was missing, when `sign` had no `userVisibleData`, or when `userVisibleDataFormat` was not `"simpleMarkdownV1"`. 4.0 throws a `TypeError` before sending, naming the field but never its value, for:

- `auth`, `sign`, `payment` and `payment.bulk` without an IPv4 or IPv6 address as `endUserIp`.
- `phone.auth` and `phone.sign` without `callInitiator` as `"user"` or `"RP"`, or without a 12-digit `personalNumber`.
- `sign` or `phone.sign` without `userVisibleData`, or with an empty one.
- `userVisibleData` or `userNonVisibleData` that is not a string, on every method.
- A payment request that breaks a rule in BankID's spec; [Payments](payments.md#checks-before-sending) lists them.

Everything else, including `userVisibleDataFormat`, `requirement` and `returnUrl` on `auth` and `sign`, is checked by BankID, which answers with a `BankIdApiError` whose `errorCode` is `invalidParameters`.

## Response fields

| 3.x                                                                             | 4.0                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orderRef`, `autoStartToken`, `qrStartToken`, `qrStartSecret`                   | The same, in `OrderResponse`.                                                                                                                                            |
| `qr` (with `qrEnabled`)                                                         | Removed. Call `qrCode`.                                                                                                                                                  |
| `status`, `hintCode`, `completionData`                                          | `CollectResponse` is a union on `status`: `hintCode` is only on `pending` and `failed`, and optional there as in BankID's spec, and `completionData` only on `complete`. |
| `completionData.stepUp`, a boolean in 3.x's types                               | An object, `{ mrtd?, face? }`, as BankID sends it.                                                                                                                       |
| `completionData.cert` (API 5.1)                                                 | Removed by BankID in API 6.0. `bankIdIssueDate` is the closest.                                                                                                          |
| `completionData.user`, `device`, `bankIdIssueDate`, `signature`, `ocspResponse` | The same. BankID's spec marks them optional, so the types do too.                                                                                                        |

`completionData.risk` is new. Its type, `RiskLevel`, is `"low"`, `"moderate"` or `"high"` or any other string, since BankID may add levels; see [Risk indication](../README.md#risk-indication). `completionData.user.personalNumber` must be 12 digits, as BankID's spec gives, or `collect` throws a `BankIdTransportError` with reason `invalidResponse`; so does a collect result for another `orderRef` than the one asked for.
