import { qrCode } from "../order.ts";
import type {
  BankIdPath,
  BankIdTransport,
  BankIdTransportResponse,
} from "../transport.ts";
import type {
  CompletionData,
  FailedHintCode,
  PendingHintCode,
} from "../types.ts";
import {
  cancelOrder,
  collectOrder,
  finish,
  hasNoQrCode,
  invalidParameters,
  isPhoneOrder,
  loadOrder,
  saveOrder,
  serialFor,
  setHintCodes,
  startOrder,
  type Context,
  type FakeUser,
  type Reply,
  type StoredOrder,
} from "./orders.ts";
import {
  createMemoryStore,
  orderKey,
  type FakeBankIdStore,
  type JsonValue,
} from "./store.ts";
import {
  checkAuth,
  checkOrderRef,
  checkOtherPayment,
  checkPayment,
  checkPaymentBulk,
  checkPhoneAuth,
  checkPhonePayment,
  checkPhonePaymentBulk,
  checkPhoneSign,
  checkSign,
  isObject,
  type Body,
} from "./validate.ts";

/** Options for {@link createFakeBankId}. */
export interface FakeBankIdOptions {
  /** Where orders are kept. Defaults to a new in-memory store. */
  store?: FakeBankIdStore;
  /**
   * The current time in milliseconds since the epoch. Defaults to `Date.now`.
   * Pass your own to test expiry and QR codes without waiting.
   */
  now?: () => number;
  /**
   * Completes every order by itself, `afterMs` after it starts, as `user`.
   * Meant for local development. Until then the order is pending with
   * `userSign`. When the order is for a personal number, as a requirement or
   * on a phone order, that personal number is used instead of `user`'s.
   */
  autoComplete?: { afterMs: number; user: FakeUser };
}

/** A fake BankID; see {@link createFakeBankId}. */
export interface FakeBankId {
  /** Pass as `transport` to `createBankIdClient`. */
  transport: BankIdTransport;
  /**
   * Completes a pending order as `user`. The completion data has the spec's
   * shape, with `device.ipAddress` from the order's `endUserIp`, `risk` when
   * the order asked for it, `stepUp` when it asked for one, and the fake
   * marker in `signature` and `ocspResponse`. `overrides` replaces the
   * simulated fields `device`, `bankIdIssueDate`, `stepUp` and `risk`, and
   * throws for any other field or a field of the wrong type: `user`,
   * `signature` and `ocspResponse` are always the fake's own. `user` and
   * `overrides` are copied at the call, so later changes have no effect.
   */
  complete(
    orderRef: string,
    user: FakeUser,
    overrides?: Partial<
      Pick<CompletionData, "device" | "bankIdIssueDate" | "stepUp" | "risk">
    >,
  ): Promise<void>;
  /**
   * Fails a pending order with a hint code, such as `"userCancel"`, or
   * `"userDeclinedCall"` for a phone order. Throws for `userDeclinedCall` on an
   * order that is not a phone order.
   */
  fail(orderRef: string, hintCode: FailedHintCode): Promise<void>;
  /**
   * Sets the hint code a pending order reports. Given several, each collect
   * reports the next one and the last one stays until the order changes.
   * `userCallConfirm`, the user being asked to confirm the call, is accepted
   * only for a phone order.
   */
  setPending(
    orderRef: string,
    hintCodes: PendingHintCode | readonly PendingHintCode[],
  ): Promise<void>;
  /** Fails a pending order with `expiredTransaction`. */
  expire(orderRef: string): Promise<void>;
  /**
   * Scans a QR code as the BankID app would: checks that it belongs to the
   * order and is current, then sets the order to `userSign`. Throws when the
   * code is wrong. A code counts as current from its time until 3 seconds
   * after, by the fake's clock. A phone order has no QR code, so it throws
   * for one.
   */
  scan(orderRef: string, qrCode: string): Promise<void>;
}

// How far a scanned QR code's time may lag behind the fake's clock. BankID
// documents no figure; this allows for a code shown a second before the scan
// and a slow request.
const qrToleranceSeconds = 3;

type Handler = (ctx: Context, body: Body) => Promise<Reply>;

const startWith =
  (
    path: BankIdPath,
    check: (body: Body) => string | undefined,
    personalNumberOf: (body: Body) => unknown,
  ): Handler =>
  async (ctx, body) => {
    const details = check(body);
    if (details !== undefined) return invalidParameters(details);
    const personalNumber = personalNumberOf(body);
    return startOrder(
      ctx,
      path,
      body as { [key: string]: JsonValue },
      typeof personalNumber === "string" ? personalNumber : null,
    );
  };

const fromRequirement = (body: Body): unknown =>
  isObject(body.requirement) ? body.requirement.personalNumber : undefined;
const fromBody = (body: Body): unknown => body.personalNumber;

const withOrderRef =
  (handle: (ctx: Context, orderRef: string) => Promise<Reply>): Handler =>
  async (ctx, body) => {
    const details = checkOrderRef(body);
    if (details !== undefined) return invalidParameters(details);
    return handle(ctx, body.orderRef as string);
  };

// One handler per endpoint in BankID's spec, over the shared order model in
// orders.ts. The type makes a path added to the spec a compile error here.
const handlers: Record<BankIdPath, Handler> = {
  "/auth": startWith("/auth", checkAuth, fromRequirement),
  "/sign": startWith("/sign", checkSign, fromRequirement),
  "/phone/auth": startWith("/phone/auth", checkPhoneAuth, fromBody),
  "/phone/sign": startWith("/phone/sign", checkPhoneSign, fromBody),
  "/payment": startWith("/payment", checkPayment, fromRequirement),
  "/payment/bulk": startWith(
    "/payment/bulk",
    checkPaymentBulk,
    fromRequirement,
  ),
  "/phone/payment": startWith("/phone/payment", checkPhonePayment, fromBody),
  "/phone/payment/bulk": startWith(
    "/phone/payment/bulk",
    checkPhonePaymentBulk,
    fromBody,
  ),
  "/other/payment": startWith("/other/payment", checkOtherPayment, fromBody),
  "/collect": withOrderRef(collectOrder),
  "/cancel": withOrderRef(cancelOrder),
};

const respond = ({ status, body }: Reply): BankIdTransportResponse => ({
  status,
  body: JSON.stringify(body),
});

const userFields = ["personalNumber", "name", "givenName", "surname"] as const;

/**
 * A plain copy of a user, each field read once, or undefined when the user is
 * not an object, a field throws when read, a name field is neither a string
 * nor absent, or the personal number is not 12 digits. Only the copy is
 * checked and used, so a getter or a change made after the call cannot alter
 * the identity that was checked.
 */
const snapshotUser = (user: unknown): FakeUser | undefined => {
  if (!isObject(user)) return undefined;
  const copy: Record<string, string> = {};
  for (const field of userFields) {
    let value: unknown;
    try {
      value = user[field];
    } catch {
      return undefined;
    }
    if (value === undefined && field !== "personalNumber") continue;
    if (typeof value !== "string") return undefined;
    copy[field] = value;
  }
  if (!/^[0-9]{12}$/.test(copy.personalNumber as string)) return undefined;
  return copy as unknown as FakeUser;
};

/** A copy of the autoComplete option, undefined without one, null if invalid. */
const snapshotAutoComplete = (
  value: unknown,
): { afterMs: number; user: FakeUser } | undefined | null => {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  try {
    const { afterMs } = value;
    const user = snapshotUser(value.user);
    if (
      typeof afterMs !== "number" ||
      !Number.isFinite(afterMs) ||
      afterMs < 0 ||
      user === undefined
    )
      return null;
    return { afterMs, user };
  } catch {
    return null;
  }
};

// The JSON types of the fields `complete` lets a test choose, from the
// spec's completion data.
const overrideTypes: Record<string, (value: JsonValue) => boolean> = {
  device: isObject,
  stepUp: isObject,
  bankIdIssueDate: value => typeof value === "string",
  risk: value => typeof value === "string",
};

/**
 * The overrides as plain JSON, converted once, then checked: only the
 * simulated fields, each with its type. The checked copy is what is merged,
 * so a `toJSON` or a getter cannot add a field after the check.
 */
const plainOverrides = (overrides: unknown): { [key: string]: JsonValue } => {
  if (!isObject(overrides))
    throw new TypeError("fake.complete: overrides must be an object");
  let plain: unknown;
  try {
    plain = JSON.parse(JSON.stringify(overrides) ?? "null");
  } catch {
    throw new TypeError("fake.complete: overrides must be plain JSON");
  }
  if (!isObject(plain))
    throw new TypeError("fake.complete: overrides must be an object");
  for (const [key, value] of Object.entries(plain)) {
    const check = Object.hasOwn(overrideTypes, key)
      ? overrideTypes[key]
      : undefined;
    if (check === undefined)
      throw new TypeError(
        "fake.complete: overrides may only set device, bankIdIssueDate, stepUp and risk",
      );
    if (!check(value as JsonValue))
      throw new TypeError(
        `fake.complete: overrides.${key} must be ${key === "device" || key === "stepUp" ? "an object" : "a string"}`,
      );
  }
  return plain as { [key: string]: JsonValue };
};

const isHintCode = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

// Hint codes BankID sends only for orders started on a phone endpoint.
const phoneOnlyHintCodes = new Set(["userCallConfirm", "userDeclinedCall"]);

/**
 * Creates a fake BankID that follows the rules in BankID's spec and guides,
 * for tests and local development without certificates or a phone. Pass its
 * `transport` to `createBankIdClient`; script orders with its other methods.
 *
 * What it does, with BankID's documented behaviour first:
 * - `/auth` and `/sign` check the request against the spec and return an
 *   `orderRef`, `autoStartToken`, `qrStartToken` and `qrStartSecret`. A bad
 *   request gets HTTP 400 `invalidParameters` with `details` such as
 *   `"Incorrect endUserIp"`.
 * - `/phone/auth` and `/phone/sign` check the request the same way and return
 *   only an `orderRef`. Script the call confirmation with
 *   `setPending(orderRef, "userCallConfirm")` and a declined call with
 *   `fail(orderRef, "userDeclinedCall")`. Completion data for a phone order
 *   has no `device.ipAddress`.
 * - The five payment endpoints check the request with the same payment rules
 *   the client applies before sending (transaction types per endpoint, the
 *   fields each type requires or forbids, lengths, enums and bulk limits),
 *   plus the fields they share with the other endpoints. `/payment` and
 *   `/payment/bulk` answer as `/auth` does; `/phone/payment`,
 *   `/phone/payment/bulk` and `/other/payment` answer with only an
 *   `orderRef`. A refused payment gets `details` naming the field as sent,
 *   such as `"Incorrect userVisibleTransaction.money"`. The spec has one
 *   collect response for every order type, so payment orders complete with
 *   the same completion data.
 * - A new order with a personal number (`requirement.personalNumber`, or
 *   `personalNumber` on a phone or `/other/payment` order), while an order
 *   with the same personal number is pending, gets HTTP 400
 *   `alreadyInProgress` and the pending order fails with `cancelled`.
 * - A new order is pending with `outstandingTransaction`. If no app picks it
 *   up within 30 seconds, it fails with `startFailed`. A scan, a pending hint
 *   code other than `outstandingTransaction` or `noClient`, or a final state
 *   counts as picked up. An order once picked up does not expire by itself.
 * - Operations on one order, including the controls below, run one at a
 *   time, so of two collects of a final state at the same moment only one
 *   gets it. That holds across fakes in one process that share a store
 *   object, including fakes from the ESM and CommonJS builds of this
 *   package. Fakes in different processes sharing a store cannot promise it
 *   with get, set and delete alone.
 * - A final state can be collected once, then the order is gone. It can be
 *   collected for 3 minutes when complete, for 5 minutes when failed, and
 *   until 3 minutes 10 seconds after it started when nobody picked it up.
 * - `/cancel` deletes the order. Collecting or cancelling an unknown,
 *   cancelled, collected or expired order gets HTTP 400 `invalidParameters`
 *   with `details` `"No such order"`.
 * - A path that is not in BankID's spec gets HTTP 404 `notFound`, and any
 *   method but POST gets HTTP 405 `methodNotAllowed`.
 * - A store that throws makes the transport reject, so the client throws a
 *   `BankIdTransportError`.
 *
 * Choices where BankID's docs are silent: the `startFailed` hint code for the
 * 30-second limit, and that limit applying to phone and `/other/payment`
 * orders too; cancelling a final state succeeding; the 3-second QR
 * tolerance; the `details` texts
 * other than `"No such order"`; orders that have been picked up never
 * expiring by themselves; and a new phone order starting at
 * `outstandingTransaction` and only reaching `userCallConfirm` when scripted,
 * since the docs do not say when BankID sends it; and the signature of a
 * payment order holding only the text fields, since the docs do not say how
 * BankID puts the transaction into it.
 *
 * Completion data is marked: `signature` and `ocspResponse` decode to text
 * containing {@link fakeMarker}, so a production system can refuse it.
 */
export const createFakeBankId = (
  options: FakeBankIdOptions = {},
): FakeBankId => {
  if (!isObject(options as unknown))
    throw new TypeError("createFakeBankId: options must be an object");
  const { store = createMemoryStore(), now = Date.now, autoComplete } = options;
  const anyStore: unknown = store;
  if (
    !isObject(anyStore) ||
    typeof anyStore.get !== "function" ||
    typeof anyStore.set !== "function" ||
    typeof anyStore.delete !== "function"
  )
    throw new TypeError(
      "createFakeBankId: store must have get, set and delete functions",
    );
  if (typeof (now as unknown) !== "function")
    throw new TypeError("createFakeBankId: now must be a function");
  // Copied once, so later changes to the options do not reach the fake.
  const autoCompleteCopy = snapshotAutoComplete(autoComplete);
  if (autoCompleteCopy === null)
    throw new TypeError(
      "createFakeBankId: autoComplete must be { afterMs, user } with a non-negative afterMs and a 12-digit personalNumber",
    );
  const ctx: Context = {
    store,
    now,
    autoComplete: autoCompleteCopy,
    serial: serialFor(store),
  };
  /** Runs a control after every earlier operation on the same order. */
  const onOrder = <T>(
    name: string,
    orderRef: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    if (typeof orderRef !== "string")
      throw new TypeError(`fake.${name}: orderRef must be a string`);
    return ctx.serial(orderKey(orderRef), task);
  };

  const transport: BankIdTransport = async ({ method, path, body, signal }) => {
    signal?.throwIfAborted();
    if (method !== "POST")
      return respond({
        status: 405,
        body: { errorCode: "methodNotAllowed", details: "" },
      });
    const handler = Object.hasOwn(handlers, path) ? handlers[path] : undefined;
    if (handler === undefined) {
      return respond({
        status: 404,
        body: { errorCode: "notFound", details: "" },
      });
    }
    if (!isObject(body)) return respond(invalidParameters("Invalid JSON"));
    return respond(await handler(ctx, body));
  };

  /** Loads a pending order for a control, or throws. */
  const pending = async (
    name: string,
    orderRef: string,
  ): Promise<StoredOrder> => {
    if (typeof orderRef !== "string")
      throw new TypeError(`fake.${name}: orderRef must be a string`);
    const order = await loadOrder(ctx, orderRef);
    if (order === undefined)
      throw new Error(`fake.${name}: no order ${orderRef}`);
    if (order.state.status !== "pending")
      throw new Error(
        `fake.${name}: order ${orderRef} is ${order.state.status}, not pending`,
      );
    return order;
  };

  /** Throws for a phone-only hint code on an order not started by phone. */
  const checkPhoneOnly = (
    name: string,
    order: StoredOrder,
    hintCodes: readonly string[],
  ): void => {
    if (isPhoneOrder(order)) return;
    const phoneOnly = hintCodes.find(code => phoneOnlyHintCodes.has(code));
    if (phoneOnly !== undefined)
      throw new Error(
        `fake.${name}: ${phoneOnly} is only for phone orders, and order ${order.orderRef} is not one`,
      );
  };

  return {
    transport,
    complete: async (orderRef, user, overrides = {}) => {
      // Both are copied now, once; only the copies are checked and used.
      const snapshot = snapshotUser(user);
      if (snapshot === undefined)
        throw new TypeError(
          "fake.complete: user must have a 12-digit personalNumber, and string names if any",
        );
      const plain = plainOverrides(overrides);
      return onOrder("complete", orderRef, async () => {
        const order = await pending("complete", orderRef);
        if (
          order.personalNumber !== null &&
          order.personalNumber !== snapshot.personalNumber
        )
          throw new Error(
            `fake.complete: order ${orderRef} requires another personal number`,
          );
        await finish(ctx, order, {
          status: "complete",
          user: snapshot,
          overrides: plain,
        });
      });
    },
    fail: async (orderRef, hintCode) => {
      if (!isHintCode(hintCode))
        throw new TypeError("fake.fail: hintCode must be a non-empty string");
      return onOrder("fail", orderRef, async () => {
        const order = await pending("fail", orderRef);
        checkPhoneOnly("fail", order, [hintCode]);
        await finish(ctx, order, { status: "failed", hintCode });
      });
    },
    expire: async orderRef =>
      onOrder("expire", orderRef, async () => {
        await finish(ctx, await pending("expire", orderRef), {
          status: "failed",
          hintCode: "expiredTransaction",
        });
      }),
    setPending: async (orderRef, hintCodes) => {
      const list: readonly unknown[] = Array.isArray(hintCodes)
        ? hintCodes
        : [hintCodes];
      if (list.length === 0 || !list.every(isHintCode))
        throw new TypeError(
          "fake.setPending: give one or more non-empty hint codes",
        );
      return onOrder("setPending", orderRef, async () => {
        const order = await pending("setPending", orderRef);
        checkPhoneOnly("setPending", order, list);
        setHintCodes(order, [...(list as string[])]);
        await saveOrder(ctx, order);
      });
    },
    scan: async (orderRef, code) =>
      onOrder("scan", orderRef, () => scanNow(orderRef, code)),
  };

  async function scanNow(orderRef: string, code: string): Promise<void> {
    const order = await pending("scan", orderRef);
    if (hasNoQrCode(order))
      throw new Error(
        isPhoneOrder(order)
          ? `fake.scan: order ${orderRef} is a phone order, which has no QR code`
          : `fake.scan: order ${orderRef} is an ${order.path} order, which has no QR code`,
      );
    if (order.pickedUp)
      throw new Error(`fake.scan: order ${orderRef} is already picked up`);
    const parts = typeof code === "string" ? code.split(".") : [];
    const time = Number(parts[2]);
    const elapsed = Math.floor((ctx.now() - order.createdAt) / 1000);
    if (
      parts.length !== 4 ||
      parts[0] !== "bankid" ||
      parts[1] !== order.qrStartToken ||
      !/^(0|[1-9][0-9]*)$/.test(parts[2] as string) ||
      code !== qrCode(order, { startedAt: 0, now: time * 1000 })
    )
      throw new Error(`fake.scan: not a QR code for order ${orderRef}`);
    if (time > elapsed || elapsed - time > qrToleranceSeconds)
      throw new Error(
        `fake.scan: the QR code is for time ${time}, but the order is ${elapsed} seconds old`,
      );
    setHintCodes(order, ["userSign"]);
    await saveOrder(ctx, order);
  }
};
