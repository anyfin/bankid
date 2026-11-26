// Errors never hold the request body, the credentials or a raw thrown value.
// Only the fields below are kept. `BankIdApiError.details` is text BankID
// returned, with runs of 10 or more digits redacted and capped in length.
import { isIP } from "node:net";
import type { BankIdPath } from "./transport.ts";
import type { ErrorCode } from "./types.ts";

const maxErrorCodeLength = 100;
const maxDetailsLength = 1000;
const maxCauseMessageLength = 500;

// A personal number is 12 digits, or 10 without the century; any run of 10 or
// more digits is redacted, wherever it appears.
const longDigitRun = /[0-9]{10,}/g;

/** The text with every run of 10 or more digits replaced by `[redacted]`. */
const redactDigits = (text: string): string =>
  text.replace(longDigitRun, "[redacted]");

/** Whether the text has a run of 10 or more digits, such as a personal number. */
export const hasLongDigitRun = (text: string): boolean =>
  /[0-9]{10}/.test(text);

/** At most `max` UTF-16 code units, without splitting a surrogate pair. */
const cap = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
};

/** BankID answered with an error status. */
export class BankIdApiError extends Error {
  override readonly name = "BankIdApiError";
  /**
   * BankID's error code. The client keeps a response's code only when it is an
   * identifier, a letter then up to 63 letters, digits or `_`, without a run
   * of 10 or more digits; any other code becomes `"unknown"`. When the
   * response carries no code, it is the code BankID documents for the HTTP
   * status, or `"unknown"` for an undocumented status.
   */
  readonly errorCode: ErrorCode;
  /**
   * The `details` text BankID returned with the error, or an empty string,
   * cut to at most 1000 characters. It is free text that BankID, or a proxy
   * in between, may fill with request data, so every run of 10 or more digits,
   * such as a personal number, is replaced by `[redacted]`. Other text is kept
   * as it came. It is left out of {@link BankIdApiError.toJSON}; log it only
   * where request data may be logged.
   */
  readonly details: string;
  /** HTTP status code. */
  readonly status: number;
  /** The API path that was called. */
  readonly path: BankIdPath;

  constructor(init: {
    errorCode: ErrorCode;
    details: string;
    status: number;
    path: BankIdPath;
  }) {
    const errorCode = cap(String(init.errorCode), maxErrorCodeLength);
    super(
      `BankID returned ${errorCode} (HTTP ${init.status}) for ${init.path}`,
    );
    this.errorCode = errorCode;
    // Redacted before capping, so a cut cannot leave part of a digit run.
    this.details = cap(
      redactDigits(String(init.details ?? "")),
      maxDetailsLength,
    );
    this.status = init.status;
    this.path = init.path;
  }

  /**
   * Whether to try the same request again without telling the user. BankID
   * allows this only for `maintenance`.
   */
  get retryable(): boolean {
    return this.errorCode === "maintenance";
  }

  /**
   * The error's fields as plain JSON, for logging. It leaves out
   * {@link BankIdApiError.details}, BankID's free text, which may hold request
   * data even after redaction.
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      errorCode: this.errorCode,
      status: this.status,
      path: this.path,
      retryable: this.retryable,
    };
  }
}

/**
 * Why a request got no usable response:
 * - `timeout`: the client's `timeoutMs` passed.
 * - `aborted`: the caller's signal fired.
 * - `network`: the connection or TLS handshake failed, or the transport threw.
 * - `invalidResponse`: the response's HTTP status is not a whole number from
 *   100 to 599, or BankID answered with a success status but a body that is
 *   not a JSON object with the fields BankID's spec requires for the
 *   endpoint, such as a collect response whose `status` is not `pending`,
 *   `complete` or `failed`.
 */
export type BankIdTransportErrorReason =
  "timeout" | "aborted" | "network" | "invalidResponse";

const messages: Record<BankIdTransportErrorReason, string> = {
  timeout: "timed out",
  aborted: "aborted",
  network: "no response",
  invalidResponse: "response is not in the shape BankID's spec gives",
};

/** The fields of a thrown value that a {@link BankIdTransportError} keeps. */
type SanitizedCause = {
  readonly name?: string;
  readonly code?: string;
  readonly errno?: number;
  readonly syscall?: string;
  readonly hostname?: string;
  readonly address?: string;
  readonly port?: number;
  readonly message?: string;
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);

const isIntegerFrom =
  (min: number, max: number) =>
  (value: unknown): value is number =>
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max;

// Letters, digits and hyphens per label, the last starting with a letter so
// it is never all digits, as RFC 3696 asks of top-level domains.
const isDnsName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 253 &&
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/.test(
    value,
  );

// A zone index (`fe80::1%eth0`) is free text, so an address with one is refused.
const isIpAddress = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("%") && isIP(value) !== 0;

/**
 * The value each kept field may have. A value of another type or form is
 * dropped, whatever threw it, since a custom transport or an abort reason can
 * put anything in these fields. A string with a run of 10 or more digits,
 * which may be a personal number, is dropped too.
 */
const causeFields: readonly [
  Exclude<keyof SanitizedCause, "message">,
  (value: unknown) => boolean,
][] = [
  ["name", isIdentifier],
  ["code", isIdentifier],
  ["errno", isIntegerFrom(-9999, 9999)],
  [
    "syscall",
    value => typeof value === "string" && /^[a-z_]{1,32}$/.test(value),
  ],
  ["hostname", isDnsName],
  ["address", isIpAddress],
  ["port", isIntegerFrom(0, 65_535)],
];

/**
 * The message of a socket error of the Node transport as a cause keeps it:
 * capped in length, or undefined when it is not a non-empty string or has a
 * run of 10 or more digits.
 */
export const causeMessage = (message: unknown): string | undefined =>
  typeof message === "string" && message !== "" && !hasLongDigitRun(message)
    ? cap(message, maxCauseMessageLength)
    : undefined;

/**
 * A fresh frozen plain object with only the allowlisted fields of a thrown
 * value or abort reason, each read once and kept only when its value has the
 * allowed form; or undefined when none is kept. A property that throws when
 * read is skipped. The value's own `message` is never read: `message` is the
 * one given, which the Node transport recorded from its socket error when it
 * saw it, since Node writes those about the connection, never the request.
 */
const sanitizeCause = (
  value: unknown,
  message: string | undefined,
): SanitizedCause | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const read = (field: string): unknown => {
    try {
      return (value as Record<string, unknown>)[field];
    } catch {
      return undefined;
    }
  };
  const out: Record<string, string | number> = {};
  for (const [field, allowed] of causeFields) {
    const item = read(field);
    if (allowed(item) && !(typeof item === "string" && hasLongDigitRun(item)))
      out[field] = item as string | number;
  }
  if (message !== undefined) out.message = message;
  return Object.keys(out).length === 0 ? undefined : Object.freeze(out);
};

// Set only while transportErrorWithMessage constructs an error.
let keptMessage: string | undefined;

/**
 * A {@link BankIdTransportError} whose cause also has `message`, the message
 * the Node transport recorded for its socket error; see {@link causeMessage}.
 */
export const transportErrorWithMessage = (
  init: ConstructorParameters<typeof BankIdTransportError>[0],
  message: string,
): BankIdTransportError => {
  keptMessage = message;
  try {
    return new BankIdTransportError(init);
  } finally {
    keptMessage = undefined;
  }
};

/** The request got no usable response from BankID. */
export class BankIdTransportError extends Error {
  override readonly name = "BankIdTransportError";
  /** Why there was no usable response; see {@link BankIdTransportErrorReason}. */
  readonly reason: BankIdTransportErrorReason;
  /** The API path that was called. */
  readonly path: BankIdPath;
  /**
   * HTTP status, for `invalidResponse` only, and only when it was a valid
   * status code.
   */
  readonly status: number | undefined;
  /**
   * A summary of what went wrong underneath, never the thrown value itself: a
   * new frozen plain object with only these fields, each kept only when its
   * value has the given form, from any transport or abort reason:
   * - `name` and `code`: an identifier of a letter then up to 63 letters,
   *   digits or `_`, such as `"ECONNRESET"`.
   * - `errno`: a whole number from -9999 to 9999.
   * - `syscall`: 1 to 32 lowercase letters or `_`, such as `"connect"`.
   * - `hostname`: a DNS name.
   * - `address`: an IPv4 or IPv6 address, without a zone index (`%...`).
   * - `port`: a whole number from 0 to 65535.
   *
   * A string with a run of 10 or more digits, which may be a personal number,
   * is dropped from every field. For a socket failure of the default
   * transport it also has Node's `message` about the connection, as the
   * transport saw it, capped in length. Undefined when there is nothing to
   * keep.
   */
  declare readonly cause?: SanitizedCause;

  constructor(init: {
    reason: BankIdTransportErrorReason;
    path: BankIdPath;
    status?: number;
    cause?: unknown;
  }) {
    const cause = sanitizeCause(init.cause, keptMessage);
    super(
      `BankID request to ${init.path} failed: ${messages[init.reason]}`,
      cause === undefined ? undefined : { cause },
    );
    this.reason = init.reason;
    this.path = init.path;
    this.status = init.status;
  }

  /** Always `false`: BankID allows silent retries only for `maintenance`. */
  get retryable(): boolean {
    return false;
  }

  /** The error's fields as plain JSON, for logging. */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      path: this.path,
      status: this.status,
      retryable: this.retryable,
    };
  }
}
