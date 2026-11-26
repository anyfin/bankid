import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { OrderResponse } from "./types.ts";

/** A point in time, as a `Date` or as milliseconds since the epoch. */
export type Instant = Date | number;

/** Options for {@link qrCode}. */
export interface QrCodeOptions {
  /** When BankID returned the order. */
  startedAt: Instant;
  /** The time to compute the code for. Defaults to the current time. */
  now?: Instant;
}

const milliseconds = (value: Instant, name: string): number => {
  const ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== "number" || !Number.isFinite(ms))
    throw new TypeError(`qrCode: ${name} must be a valid Date or number`);
  return ms;
};

/**
 * Returns the content of the animated QR code for an order at one moment:
 * `bankid.<qrStartToken>.<time>.<qrAuthCode>`, where `time` is the whole
 * seconds since the order started and `qrAuthCode` is the HMAC-SHA256 of
 * `time` keyed with `qrStartSecret`, in hex. Call it every second while the
 * code is shown. A `now` before `startedAt`, as from clock skew between
 * servers, counts as time 0.
 *
 * Keep `qrStartSecret` on the server and send only the result to the browser
 * or app.
 */
export const qrCode = (
  order: Pick<OrderResponse, "qrStartToken" | "qrStartSecret">,
  { startedAt, now = Date.now() }: QrCodeOptions,
): string => {
  const elapsed =
    milliseconds(now, "now") - milliseconds(startedAt, "startedAt");
  const time = String(Math.max(0, Math.floor(elapsed / 1000)));
  const authCode = createHmac("sha256", order.qrStartSecret)
    .update(time)
    .digest("hex");
  return `bankid.${order.qrStartToken}.${time}.${authCode}`;
};

/** A return URL and the nonce it carries; see {@link createReturnUrl}. */
export interface ReturnUrl {
  /** The URL to send as `returnUrl` when starting the order. */
  returnUrl: string;
  /** The nonce in the URL's fragment. Store it with the user's session. */
  nonce: string;
}

// The spec's maxLength for `returnUrl`.
const maxReturnUrlLength = 512;

/**
 * Adds a random nonce to a return URL, as `#nonce=<nonce>`, so the return can
 * be bound to the session that started the order. Store the nonce with the
 * session, send `returnUrl` in the order, and when the user comes back, pass
 * the nonce your page reads from the fragment to {@link verifyReturn}. The URL
 * must be absolute and must not have a fragment of its own, and the result
 * must fit BankID's limit of 512 characters; otherwise it throws a
 * `TypeError` that does not repeat the URL.
 */
export const createReturnUrl = (url: string | URL): ReturnUrl => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Node's error keeps the input, which can hold a session or user data.
    throw new TypeError("createReturnUrl: the URL must be an absolute URL");
  }
  if (parsed.hash !== "" || parsed.href.endsWith("#"))
    throw new TypeError("createReturnUrl: the URL must not have a fragment");
  const nonce = randomBytes(32).toString("base64url");
  parsed.hash = `nonce=${nonce}`;
  if (parsed.href.length > maxReturnUrlLength)
    throw new TypeError(
      `createReturnUrl: the URL with its nonce is longer than the ${maxReturnUrlLength} characters BankID allows`,
    );
  return { returnUrl: parsed.href, nonce };
};

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/**
 * Whether the nonce the user came back with is the one stored for their
 * session. The comparison takes the same time whatever the values. Returns
 * `false` when either value is missing or empty.
 */
export const verifyReturn = ({
  expected,
  received,
}: {
  expected: string | null | undefined;
  received: string | null | undefined;
}): boolean => {
  if (typeof expected !== "string" || typeof received !== "string")
    return false;
  if (expected === "" || received === "") return false;
  // Hashing first gives equal lengths, so the length is not leaked either.
  return timingSafeEqual(digest(expected), digest(received));
};
