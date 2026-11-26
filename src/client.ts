import { Buffer } from "node:buffer";
import {
  BankIdApiError,
  BankIdTransportError,
  hasLongDigitRun,
  transportErrorWithMessage,
} from "./errors.ts";
import {
  createNodeTransport,
  isCredentials,
  isEnvironment,
  nodeSocketErrorMessage,
  type BankIdCredentials,
  type BankIdEnvironment,
  type CertificateInput,
} from "./node-transport.ts";
import {
  checkPhoneRequired,
  checkStartRequired,
  encodePaymentRequest,
  type PaymentPath,
} from "./payment.ts";
import type { BankIdPath, BankIdTransport } from "./transport.ts";
import type {
  AuthRequest,
  CollectResponse,
  ErrorCode,
  OrderResponse,
  OtherOrderResponse,
  OtherPaymentRequest,
  PaymentBulkRequest,
  PaymentRequest,
  PhoneAuthRequest,
  PhoneOrderResponse,
  PhonePaymentBulkRequest,
  PhonePaymentRequest,
  PhoneSignRequest,
  SignRequest,
} from "./types.ts";

const defaultTimeoutMs = 10_000;
const defaultWatchIntervalMs = 2000;
const defaultMaxConsecutiveRetries = 5;
// At the default interval, 100 retries outlast any order by minutes.
const maxRetries = 100;

/** Waits, resolving early when the signal aborts. Leaves no timer behind. */
const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

// The largest delay setTimeout and AbortSignal.timeout take.
const maxDelayMs = 2_147_483_647;

const isDelay = (value: unknown): boolean =>
  Number.isInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= maxDelayMs;

const isRetryable = (error: unknown): boolean =>
  (error instanceof BankIdApiError || error instanceof BankIdTransportError) &&
  error.retryable;

interface CommonOptions {
  /** `"production"` or `"test"`. There is no default. */
  environment: BankIdEnvironment;
  /**
   * How long one request may take before it fails with a
   * {@link BankIdTransportError} whose reason is `timeout`, in whole
   * milliseconds from 1 to 2147483647. Default 10 000.
   */
  timeoutMs?: number;
}

/** Options for the default transport, which calls BankID over mutual TLS. */
export interface BankIdCredentialOptions extends CommonOptions {
  /** The relying party's client certificate. */
  credentials: BankIdCredentials;
  /**
   * Root CAs to trust for BankID's server certificate. Defaults to BankID's
   * root CA for the environment, which the package bundles.
   */
  ca?: CertificateInput | readonly CertificateInput[];
  transport?: never;
}

/** Options for a custom transport, such as a fake or a proxy. */
export interface BankIdTransportOptions extends CommonOptions {
  /** Sends requests instead of the default transport. */
  transport: BankIdTransport;
  credentials?: never;
  ca?: never;
}

/** Options for {@link createBankIdClient}. */
export type BankIdClientOptions =
  BankIdCredentialOptions | BankIdTransportOptions;

/** Per-call options. */
export interface CallOptions {
  /** Aborts the request; it then fails with reason `aborted`. */
  signal?: AbortSignal;
}

/** Options for {@link BankIdClient.watch}. */
export interface WatchOptions {
  /** Stops watching: the iteration ends and no further collect is made. */
  signal?: AbortSignal;
  /**
   * Time between the end of one collect and the start of the next, in whole
   * milliseconds from 1 to 2147483647. Default 2000.
   */
  intervalMs?: number;
  /**
   * How many retryable errors in a row to retry before throwing the last one.
   * The count starts again after any successful collect. A whole number from
   * 0 to 100; default 5, and 0 throws the first. BankID's user message for
   * `maintenance` that keeps failing is RFA5.
   */
  maxConsecutiveRetries?: number;
}

/**
 * Starts a payment order: the user approves one transaction, such as a card
 * payment or a bank transfer. Start the BankID app and collect the order as
 * for {@link BankIdClient.sign}. Call `payment.bulk` for several payments at
 * once.
 *
 * The request is checked against the rules in BankID's spec before it is
 * sent, such as which transaction types need `money` or a `date`, and the
 * call rejects with a `TypeError` naming the field and the rule. The message
 * never contains the value. Text fields, including recipient names, are plain
 * strings; the library base64-encodes them into the spec's `...B64` fields.
 * Payment orders need BankID app 7.46 or newer.
 */
export interface BankIdPaymentClient {
  (request: PaymentRequest, options?: CallOptions): Promise<OrderResponse>;
  /**
   * Starts a bulk payment order: 1 to 40 bankgiro, plusgiro or bank transfer
   * payments, with 1 to 4 sums. Checked before sending in the same way.
   */
  bulk(
    request: PaymentBulkRequest,
    options?: CallOptions,
  ): Promise<OrderResponse>;
}

/**
 * Starts a payment order for the user on the call, checked and encoded as for
 * {@link BankIdPaymentClient}. Call `phone.payment.bulk` for several payments.
 */
export interface BankIdPhonePaymentClient {
  (
    request: PhonePaymentRequest,
    options?: CallOptions,
  ): Promise<PhoneOrderResponse>;
  /** Starts a bulk payment order for the user on the call. */
  bulk(
    request: PhonePaymentBulkRequest,
    options?: CallOptions,
  ): Promise<PhoneOrderResponse>;
}

/**
 * Orders for when you cannot use autostart or a QR code and are not on a call
 * with the user. BankID prefers {@link BankIdClient.payment}.
 */
export interface BankIdOtherClient {
  /**
   * Starts a card payment or non-payment authentication order for the user
   * with `personalNumber`, who opens the BankID app themselves. Checked and
   * encoded as for {@link BankIdPaymentClient}.
   */
  payment(
    request: OtherPaymentRequest,
    options?: CallOptions,
  ): Promise<OtherOrderResponse>;
}

/**
 * Orders for a user you are talking to on the phone. The user opens the BankID
 * app themselves; there is no QR code or autostart. Collect the order as any
 * other, with {@link BankIdClient.collect} or {@link BankIdClient.watch}.
 */
export interface BankIdPhoneClient {
  /**
   * Starts an authentication order for the user on the call. Before sending,
   * the call rejects with a `TypeError` naming the field, never its value,
   * when `callInitiator` is not `"user"` or `"RP"` or `personalNumber` is not
   * 12 digits.
   */
  auth(
    request: PhoneAuthRequest,
    options?: CallOptions,
  ): Promise<PhoneOrderResponse>;
  /**
   * Starts a signature order for the user on the call. Before sending, the
   * call rejects with a `TypeError` naming the field, never its value, when
   * `callInitiator` is not `"user"` or `"RP"`, `personalNumber` is not 12
   * digits, or `userVisibleData` is missing or empty.
   */
  sign(
    request: PhoneSignRequest,
    options?: CallOptions,
  ): Promise<PhoneOrderResponse>;
  /** Starts a payment order for the user on the call. */
  payment: BankIdPhonePaymentClient;
}

/** A client for BankID's relying-party API, version 6.0. */
export interface BankIdClient {
  /**
   * Starts an authentication order. Before sending, the call rejects with a
   * `TypeError` naming the field, never its value, when `endUserIp` is not an
   * IPv4 or IPv6 address.
   */
  auth(request: AuthRequest, options?: CallOptions): Promise<OrderResponse>;
  /**
   * Starts a signature order. Before sending, the call rejects with a
   * `TypeError` naming the field, never its value, when `endUserIp` is not an
   * IPv4 or IPv6 address or `userVisibleData` is empty.
   */
  sign(request: SignRequest, options?: CallOptions): Promise<OrderResponse>;
  /** Starts a payment order; `payment.bulk` starts a bulk payment order. */
  payment: BankIdPaymentClient;
  /** Orders for a user you are talking to on the phone. */
  phone: BankIdPhoneClient;
  /** Orders started without autostart, a QR code or a phone call. */
  other: BankIdOtherClient;
  /**
   * Gets the status of an order. Collect every two seconds until the status is
   * `complete` or `failed`, and not after that. A response for another
   * `orderRef` than the one asked for is refused with a
   * {@link BankIdTransportError} whose reason is `invalidResponse`.
   */
  collect(orderRef: string, options?: CallOptions): Promise<CollectResponse>;
  /** Cancels an order that is still pending. */
  cancel(orderRef: string, options?: CallOptions): Promise<void>;
  /**
   * Collects an order until it is final, yielding each result. The first
   * collect is made at once, then one every `intervalMs` (two seconds, as
   * BankID asks), counted from the end of the previous one. The iteration ends
   * after a `complete` or `failed` result, or when `signal` aborts. Errors
   * whose `retryable` is true are retried at the same interval without being
   * yielded, up to `maxConsecutiveRetries` (5) in a row, after which the last
   * one is thrown; any other error is thrown at once. Leaving the loop early
   * stops it too.
   *
   * It holds the order in this process only, so it does not suit several
   * instances sharing an order; call {@link BankIdClient.collect} there.
   */
  watch(
    orderRef: string,
    options?: WatchOptions,
  ): AsyncGenerator<CollectResponse, void, undefined>;
}

// Error codes BankID documents per HTTP status, used when an error response
// carries no error code of its own.
const errorCodeByStatus: Partial<Record<number, ErrorCode>> = {
  401: "unauthorized",
  403: "unauthorized",
  404: "notFound",
  405: "methodNotAllowed",
  408: "requestTimeout",
  415: "unsupportedMediaType",
  500: "internalError",
  503: "maintenance",
};

// An error code from a response is kept only in this form, so a proxy cannot
// put request data, such as a personal number, into an error's message.
const isErrorCode = (value: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !hasLongDigitRun(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

// What a success response must hold, per endpoint, from the response schemas
// in BankID's spec. Fields the spec adds later, and unknown hint codes, pass.
const orderResponse = (body: Record<string, unknown>): boolean =>
  isText(body.orderRef) &&
  isText(body.autoStartToken) &&
  isText(body.qrStartToken) &&
  isText(body.qrStartSecret);
const limitedResponse = (body: Record<string, unknown>): boolean =>
  isText(body.orderRef);
interface FieldTypes {
  [field: string]:
    "string" | "boolean" | ((value: unknown) => boolean) | FieldTypes;
}

// The known fields of completionData and their types, from the spec. Each is
// optional; one that is present must have its type. Other fields pass, and so
// does a `risk` level the spec does not list yet.
const completionDataTypes: FieldTypes = {
  user: {
    // The spec gives 12 digits.
    personalNumber: value =>
      typeof value === "string" && /^[0-9]{12}$/.test(value),
    name: "string",
    givenName: "string",
    surname: "string",
  },
  device: { ipAddress: "string", uhi: "string" },
  stepUp: { mrtd: "boolean", face: "boolean" },
  bankIdIssueDate: "string",
  signature: "string",
  ocspResponse: "string",
  risk: "string",
};

const hasFieldTypes = (
  value: Record<string, unknown>,
  types: FieldTypes,
): boolean =>
  Object.entries(types).every(([field, type]) => {
    const item = value[field];
    if (item === undefined) return true;
    if (typeof type === "string") return typeof item === type;
    if (typeof type === "function") return type(item);
    return isObject(item) && hasFieldTypes(item, type);
  });

// The orderRef must be the one asked for, so a proxy or transport that mixes
// up orders cannot hand one order's result to another.
const collectResponse = (
  body: Record<string, unknown>,
  requestedOrderRef: unknown,
): boolean => {
  if (!isText(body.orderRef) || body.orderRef !== requestedOrderRef)
    return false;
  switch (body.status) {
    case "pending":
    case "failed":
      // The spec requires only orderRef and status.
      return body.hintCode === undefined || isText(body.hintCode);
    case "complete":
      return (
        isObject(body.completionData) &&
        hasFieldTypes(body.completionData, completionDataTypes)
      );
    default:
      return false;
  }
};
const validResponse: Record<
  BankIdPath,
  (body: Record<string, unknown>, requestedOrderRef: unknown) => boolean
> = {
  "/auth": orderResponse,
  "/sign": orderResponse,
  "/payment": orderResponse,
  "/payment/bulk": orderResponse,
  "/phone/auth": limitedResponse,
  "/phone/sign": limitedResponse,
  "/phone/payment": limitedResponse,
  "/phone/payment/bulk": limitedResponse,
  "/other/payment": limitedResponse,
  "/collect": collectResponse,
  "/cancel": () => true,
};

/**
 * The body as plain JSON data: raw text is parsed, and an object a transport
 * already parsed is copied through JSON, so getters, proxies and `toJSON` are
 * read once here and never reach the caller. Undefined when that fails.
 */
const parseBody = (body: unknown): unknown => {
  try {
    if (typeof body === "string") return JSON.parse(body);
    if (typeof body === "object" && body !== null)
      return JSON.parse(JSON.stringify(body) ?? "null");
  } catch {
    // Not JSON.
  }
  return undefined;
};

/** The status and body of a transport's response, each read once, or undefined. */
const readResponse = (
  response: unknown,
): { status: number; body: unknown } | undefined => {
  if (typeof response !== "object" || response === null) return undefined;
  try {
    const { status, body } = response as Record<string, unknown>;
    // An HTTP status code is a three-digit number.
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599
    )
      return undefined;
    return { status, body };
  } catch {
    return undefined;
  }
};

const base64 = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64");

/**
 * Base64-encodes the plain-text fields BankID expects encoded. Throws a
 * `TypeError` naming the field, never its value, for one that is not a string.
 */
const encodeText = (
  method: string,
  request: { userVisibleData?: string; userNonVisibleData?: string },
): Record<string, unknown> => {
  if (!isObject(request))
    throw new TypeError(`${method} needs a request object`);
  const body: Record<string, unknown> = { ...request };
  for (const field of ["userVisibleData", "userNonVisibleData"] as const) {
    const text: unknown = request[field];
    if (text === undefined) continue;
    if (typeof text !== "string")
      throw new TypeError(`${method}: ${field} must be a string`);
    body[field] = base64(text);
  }
  return body;
};

const validate = (options: BankIdClientOptions): void => {
  if (!isObject(options))
    throw new TypeError("createBankIdClient needs an options object");
  if (!isEnvironment(options.environment))
    throw new TypeError(
      'createBankIdClient: environment must be "production" or "test"',
    );
  if (options.timeoutMs !== undefined && !isDelay(options.timeoutMs))
    throw new TypeError(
      "createBankIdClient: timeoutMs must be a whole number from 1 to 2147483647",
    );
  if (options.transport !== undefined) {
    if (typeof options.transport !== "function")
      throw new TypeError("createBankIdClient: transport must be a function");
    if (options.credentials !== undefined || options.ca !== undefined)
      throw new TypeError(
        "createBankIdClient: credentials and ca are not used with a custom transport",
      );
    return;
  }
  if (!isCredentials(options.credentials))
    throw new TypeError(
      "createBankIdClient: credentials must be { pfx, passphrase } or { cert, key, passphrase? }, as strings or bytes",
    );
};

/**
 * Creates a client for BankID's relying-party API. It holds no state besides
 * its configuration and a pool of keep-alive connections.
 */
export const createBankIdClient = (
  options: BankIdClientOptions,
): BankIdClient => {
  validate(options);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const transport =
    options.transport ??
    createNodeTransport({
      environment: options.environment,
      credentials: options.credentials,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    });
  const call = async (
    path: BankIdPath,
    body: Record<string, unknown>,
    { signal: callerSignal }: CallOptions = {},
  ): Promise<Record<string, unknown>> => {
    // Read before the transport gets the body, which it could change.
    const requestedOrderRef = body.orderRef;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;

    let response: unknown;
    try {
      // Race the transport against the signal, so a transport that ignores
      // the signal still cannot outlive the timeout.
      response = await new Promise<unknown>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        new Promise<unknown>(settle =>
          settle(transport({ method: "POST", path, body, signal })),
        )
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    } catch (error) {
      // Whatever was thrown, even an error of this library's own classes, is
      // never rethrown or kept: it or the abort reason can hold request data.
      // A fresh error keeps only a summary of allowlisted fields.
      const reason = callerSignal?.aborted
        ? "aborted"
        : timeout.aborted
          ? "timeout"
          : "network";
      // Node writes the messages of its own socket errors, so those are kept,
      // as the Node transport recorded them.
      const message =
        reason === "network" ? nodeSocketErrorMessage(error) : undefined;
      if (message !== undefined)
        throw transportErrorWithMessage(
          { reason, path, cause: error },
          message,
        );
      throw new BankIdTransportError({ reason, path, cause: error });
    }

    const read = readResponse(response);
    if (read === undefined)
      throw new BankIdTransportError({ reason: "invalidResponse", path });
    const { status } = read;
    const parsed = parseBody(read.body);
    if (status >= 200 && status < 300) {
      if (!isObject(parsed) || !validResponse[path](parsed, requestedOrderRef))
        throw new BankIdTransportError({
          reason: "invalidResponse",
          path,
          status,
        });
      return parsed;
    }
    const errorBody = isObject(parsed) ? parsed : {};
    throw new BankIdApiError({
      errorCode: !isText(errorBody.errorCode)
        ? (errorCodeByStatus[status] ?? "unknown")
        : isErrorCode(errorBody.errorCode)
          ? errorBody.errorCode
          : "unknown",
      details: typeof errorBody.details === "string" ? errorBody.details : "",
      status,
      path,
    });
  };

  const collect = async (orderRef: string, callOptions?: CallOptions) =>
    (await call(
      "/collect",
      { orderRef },
      callOptions,
    )) as unknown as CollectResponse;

  async function* watch(
    orderRef: string,
    {
      signal,
      intervalMs = defaultWatchIntervalMs,
      maxConsecutiveRetries = defaultMaxConsecutiveRetries,
    }: WatchOptions = {},
  ): AsyncGenerator<CollectResponse, void, undefined> {
    if (!isDelay(intervalMs))
      throw new TypeError(
        "watch: intervalMs must be a whole number from 1 to 2147483647",
      );
    if (!(
      Number.isSafeInteger(maxConsecutiveRetries) &&
      maxConsecutiveRetries >= 0 &&
      maxConsecutiveRetries <= maxRetries
    ))
      throw new TypeError(
        `watch: maxConsecutiveRetries must be a whole number from 0 to ${maxRetries}`,
      );
    let retries = 0;
    for (let first = true; ; first = false) {
      if (!first) await sleep(intervalMs, signal);
      if (signal?.aborted) return;
      let result: CollectResponse;
      try {
        result = await collect(orderRef, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return;
        if (isRetryable(error) && retries < maxConsecutiveRetries) {
          retries += 1;
          continue;
        }
        throw error;
      }
      retries = 0;
      // Decided before yielding, since the consumer may change the result.
      const final = result.status !== "pending";
      yield result;
      if (final) return;
    }
  }

  /** A payment endpoint: encode and check the request, then call. */
  const pay =
    <Request extends object, Response>(method: string, path: PaymentPath) =>
    async (request: Request, callOptions?: CallOptions): Promise<Response> =>
      (await call(
        path,
        encodePaymentRequest(method, path, request),
        callOptions,
      )) as Response;

  /** `/auth` or `/sign`: encode the text and check the required fields. */
  const start =
    (method: string, path: "/auth" | "/sign") =>
    async (
      request: AuthRequest | SignRequest,
      callOptions?: CallOptions,
    ): Promise<OrderResponse> => {
      const body = encodeText(method, request);
      const found = checkStartRequired(path, body);
      if (found !== undefined)
        throw new TypeError(`${method}: ${found.field} ${found.reason}`);
      return (await call(path, body, callOptions)) as OrderResponse;
    };

  /** `/phone/auth` or `/phone/sign`: encode the text and check the required fields. */
  const startPhone =
    (method: string, path: "/phone/auth" | "/phone/sign") =>
    async (
      request: PhoneAuthRequest | PhoneSignRequest,
      callOptions?: CallOptions,
    ): Promise<PhoneOrderResponse> => {
      const body = encodeText(method, request);
      const found = checkPhoneRequired(path, body);
      if (found !== undefined)
        throw new TypeError(`${method}: ${found.field} ${found.reason}`);
      return (await call(path, body, callOptions)) as PhoneOrderResponse;
    };

  // Each endpoint is a thin function over `call`, so further endpoints are
  // added the same way.
  return {
    auth: start("auth", "/auth"),
    sign: start("sign", "/sign"),
    payment: Object.assign(
      pay<PaymentRequest, OrderResponse>("payment", "/payment"),
      {
        bulk: pay<PaymentBulkRequest, OrderResponse>(
          "payment.bulk",
          "/payment/bulk",
        ),
      },
    ),
    phone: {
      auth: startPhone("phone.auth", "/phone/auth"),
      sign: startPhone("phone.sign", "/phone/sign"),
      payment: Object.assign(
        pay<PhonePaymentRequest, PhoneOrderResponse>(
          "phone.payment",
          "/phone/payment",
        ),
        {
          bulk: pay<PhonePaymentBulkRequest, PhoneOrderResponse>(
            "phone.payment.bulk",
            "/phone/payment/bulk",
          ),
        },
      ),
    },
    other: {
      payment: pay<OtherPaymentRequest, OtherOrderResponse>(
        "other.payment",
        "/other/payment",
      ),
    },
    collect,
    cancel: async (orderRef, callOptions) => {
      await call("/cancel", { orderRef }, callOptions);
    },
    watch,
  };
};
