# Changelog

## 4.0.0

A rewrite for BankID's API version 6.0, built from BankID's OpenAPI spec 6.1.11 and guides. Nothing from 3.x is kept for compatibility: see [Migrating from 3.x](docs/migrating-from-v3.md).

### Breaking

- Node.js 22 or newer is required.
- `BankIdClient` (API 5.1, which BankID has shut down) and `BankIdClientV6` are replaced by `createBankIdClient({ environment, credentials })`.
- The environment is required. The test certificate is no longer a default; import `testCredentials` from `bankid/testing`.
- Certificates are passed as contents. A `pfx` or `ca` string is no longer read as a file path. A `pfx` string that looks like a path, or does not decode to a PKCS#12 file, fails with an error that says so, without echoing the string.
- `collect` and `cancel` take the order reference as a string.
- `authenticate` is renamed `auth`. `authenticateAndCollect`, `signAndCollect` and `awaitPendingCollect` are removed; use `watch`.
- `QrGenerator`, its cache and the `qrEnabled` and `qrOptions` options are removed; use `qrCode`.
- `BankIdError` and `RequestError` are replaced by `BankIdApiError` and `BankIdTransportError`. `BankIdErrorCode`, `BankIdMethod` and `REQUEST_FAILED_ERROR` are removed.
- A request without an IP address as `endUserIp` on `auth` or `sign`, or a `sign` without `userVisibleData`, throws a `TypeError` naming the field instead of an `Error`. A wrong `userVisibleDataFormat` is no longer refused before sending; BankID refuses it.
- The axios dependency is gone, and with it the client's `axios` property and `createAxiosInstance`.

### Added

- Every endpoint in the spec: `auth`, `sign`, `payment`, `payment.bulk`, `phone.auth`, `phone.sign`, `phone.payment`, `phone.payment.bulk`, `other.payment`, `collect` and `cancel`. Text fields are plain strings; the library encodes them.
- Request and response types derived from BankID's spec. `collect` returns a union on `status`. Hint codes, error codes and `completionData.risk` (`RiskLevel`, with the known levels in `KnownRiskLevel`) accept values BankID adds later. `hintCode` is optional on pending and failed results, as in the spec. A success response without the fields the spec requires, with an unknown collect `status`, with a `user.personalNumber` that is not 12 digits, or a collect result for another `orderRef` than the one asked for, throws a `BankIdTransportError` with reason `invalidResponse`.
- Payment requests are checked against the spec before they are sent, including the length of `returnUrl`. `auth` and `sign` check `endUserIp`, `phone.auth` and `phone.sign` check `callInitiator` and `personalNumber`, and `sign` and `phone.sign` a non-empty `userVisibleData`.
- `qrCode` for the animated QR code, and `createReturnUrl` and `verifyReturn` for the return URL nonce.
- `describe`, which gives BankID's recommended user message for a collect result or an error, including unknown codes. It takes anything with a `status` and an optional `hintCode`, so a `RelayedStatus` works too.
- `watch`, which collects every 2 seconds until the order is final. It retries `maintenance` up to `maxConsecutiveRetries` (default 5) times in a row, and decides whether a result is final before yielding it, so changing the result cannot keep it collecting.
- `retryable` on both error classes, true only for `maintenance`. Errors never hold request bodies or credentials. `BankIdTransportError.cause` keeps only allowlisted fields of the underlying error, each only when its value has an allowed form, such as an identifier for `code`, and never a string with a run of 10 or more digits. `BankIdApiError.errorCode` keeps BankID's code only when it is an identifier without such a run, and is `"unknown"` otherwise. `BankIdApiError.details` is BankID's own text, capped in length, with every run of 10 or more digits replaced by `[redacted]`, and `toJSON` leaves it out.
- A `transport` option for fakes, proxies and instrumentation, and a `timeoutMs` option.
- `createNodeTransport({ environment, credentials, ca })`, the built-in mutual TLS transport, exported from `bankid` (not `bankid/client`) so it can be wrapped for metrics, logging or a proxy and passed as `transport`. It takes no timeout; the client's `timeoutMs` aborts each request's signal. It refuses a path that is not in BankID's spec.
- `bankid/client` for browsers and React Native: `startUrl`, `describe` and the `RelayedStatus` types.
- `bankid/testing`: a fake BankID that follows the spec, with pluggable storage, and BankID's test certificate. Fakes in one process that share a store take turns on each order, even when one comes from the ES module build and the other from the CommonJS build. The fake's completion data always carries its marker and the user it was completed as.
- ES module and CommonJS builds, with types that work from TypeScript 4.9.
- No runtime dependencies.
