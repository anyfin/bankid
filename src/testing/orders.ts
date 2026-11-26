// The fake's order model, shared by every endpoint handler. An order is one
// JSON value in the store. Time-based changes (the start window running out,
// an automatic completion, a final state ageing out) are worked out from the
// order's timestamps whenever the order is read, so the fake needs no timers.
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { CompletionData } from "../types.ts";
import {
  orderKey,
  personalNumberKey,
  valuesOfMemoryStore,
  type FakeBankIdStore,
  type JsonValue,
} from "./store.ts";

/**
 * Marks completion data as made by the fake. Both `signature` and
 * `ocspResponse` decode from base64 to UTF-8 text that contains it, and no
 * real BankID response does. Refuse completion data that contains it.
 */
export const fakeMarker = "urn:bankid:testing:fake";

/** Who completes an order. */
export interface FakeUser {
  /** 12 digits, such as `"190010101010"`. */
  personalNumber: string;
  /** Full name. Defaults to `givenName` and `surname` joined by a space. */
  name?: string;
  /** Defaults to the first word of `name`, or `"Test"`. */
  givenName?: string;
  /** Defaults to the rest of `name`, or `"Testsson"`. */
  surname?: string;
}

// How long the user has to pick up an order: BankID's QR guide says the order
// is valid for 30 seconds, so the user must scan within that time.
export const startWindowMs = 30_000;
// How long a final state can be collected, from BankID's errors guide:
// completed orders for 3 minutes, failed orders for 5 minutes, and orders that
// timed out because nobody picked them up for 3 minutes and 10 seconds.
export const completeCollectableMs = 3 * 60_000;
export const failedCollectableMs = 5 * 60_000;
export const notPickedUpCollectableMs = 3 * 60_000 + 10_000;

// Pending hint codes that mean the BankID app has not received the order.
const notPickedUp = new Set(["outstandingTransaction", "noClient"]);

type PendingState = {
  status: "pending";
  // The first is the current hint code. Each collect moves to the next one
  // and the last one stays.
  hintCodes: string[];
};
type CompleteState = {
  status: "complete";
  completionData: { [key: string]: JsonValue };
  collectableUntil: number;
};
type FailedState = {
  status: "failed";
  hintCode: string;
  collectableUntil: number;
};

/** One order, as kept in the store. */
export type StoredOrder = {
  version: 1;
  orderRef: string;
  /** The endpoint that started the order, such as `"/auth"`. */
  path: string;
  createdAt: number;
  /** The request body as sent, text fields still base64-encoded. */
  request: { [key: string]: JsonValue };
  /**
   * The personal number the order is for: `personalNumber` for a phone or
   * `/other/payment` order, else `requirement.personalNumber`, or null.
   */
  personalNumber: string | null;
  qrStartToken: string;
  qrStartSecret: string;
  /** Whether a BankID app has received the order. */
  pickedUp: boolean;
  autoComplete: { at: number; user: FakeUserJson } | null;
  state: PendingState | CompleteState | FailedState;
};

type FakeUserJson = { [K in keyof FakeUser]-?: string };

/** A reply in the shape of BankID's HTTP response. */
export interface Reply {
  status: number;
  body: JsonValue;
}

export const ok = (body: JsonValue): Reply => ({ status: 200, body });

export const invalidParameters = (details: string): Reply => ({
  status: 400,
  body: { errorCode: "invalidParameters", details },
});

export const noSuchOrder = (): Reply => invalidParameters("No such order");

/** Whether the order was started on one of the `/phone/...` endpoints. */
export const isPhoneOrder = (order: Pick<StoredOrder, "path">): boolean =>
  order.path.startsWith("/phone/");

/**
 * Whether the order has no QR code or autostart token: a phone order or an
 * `/other/payment` order, which the spec answers with `limited_response`.
 */
export const hasNoQrCode = (order: Pick<StoredOrder, "path">): boolean =>
  isPhoneOrder(order) || order.path === "/other/payment";

/** What every handler and control gets. */
export interface Context {
  store: FakeBankIdStore;
  now: () => number;
  autoComplete: { afterMs: number; user: FakeUser } | undefined;
  /**
   * Runs `task` after every earlier task with the same key has settled, in
   * every fake in this process that uses the same store object. Keys are
   * store keys, such as `order:<orderRef>`.
   */
  serial: <T>(key: string, task: () => Promise<T>) => Promise<T>;
}

/**
 * A per-key queue of promises: each task with a key starts when the previous
 * one with that key has settled. It holds nothing once a key's queue is empty.
 */
const createSerial = (): Context["serial"] => {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
};

// One queue per store object, so fakes sharing a store take turns. The
// registry is global under a `Symbol.for` key, so the ESM and CommonJS builds
// of this package, which each have their own module state, share it.
const serialsKey = Symbol.for("bankid/testing.serialQueues.v1");

const serials = (): WeakMap<FakeBankIdStore, Context["serial"]> => {
  const registry = globalThis as {
    [serialsKey]?: WeakMap<FakeBankIdStore, Context["serial"]>;
  };
  return (registry[serialsKey] ??= new WeakMap());
};

/** The per-key queue shared by every fake in this process using `store`. */
export const serialFor = (store: FakeBankIdStore): Context["serial"] => {
  const registry = serials();
  let serial = registry.get(store);
  if (serial === undefined) {
    serial = createSerial();
    registry.set(store, serial);
  }
  return serial;
};

const isStoredOrder = (value: unknown): value is StoredOrder =>
  typeof value === "object" &&
  value !== null &&
  (value as { version?: unknown }).version === 1 &&
  typeof (value as { orderRef?: unknown }).orderRef === "string";

const fail = (
  order: StoredOrder,
  hintCode: string,
  collectableUntil: number,
): void => {
  order.state = { status: "failed", hintCode, collectableUntil };
};

/**
 * Applies the changes that time has made to an order. Returns whether the
 * order changed, or `"gone"` when it can no longer be collected.
 */
const settle = (order: StoredOrder, now: number): boolean | "gone" => {
  let changed = false;
  if (order.state.status === "pending") {
    if (order.autoComplete !== null && now >= order.autoComplete.at) {
      order.state = {
        status: "complete",
        completionData: completionData(order, order.autoComplete.user),
        collectableUntil: order.autoComplete.at + completeCollectableMs,
      };
      changed = true;
    } else if (!order.pickedUp && now >= order.createdAt + startWindowMs) {
      // The docs name no hint code for this; startFailed is the one whose
      // reason is the app not starting "within a certain time limit".
      fail(order, "startFailed", order.createdAt + notPickedUpCollectableMs);
      changed = true;
    }
  }
  if (order.state.status !== "pending" && now > order.state.collectableUntil)
    return "gone";
  return changed;
};

/**
 * Reads an order and applies the changes time has made, saving them. Returns
 * undefined for an unknown order or one too old to collect, which it deletes.
 */
export const loadOrder = async (
  ctx: Context,
  orderRef: string,
): Promise<StoredOrder | undefined> => {
  const value = await ctx.store.get(orderKey(orderRef));
  if (value === undefined) return undefined;
  if (!isStoredOrder(value))
    throw new Error(
      `bankid/testing: the store returned something that is not an order for ${orderKey(orderRef)}`,
    );
  const result = settle(value, ctx.now());
  if (result === "gone") {
    await removeOrder(ctx, value);
    return undefined;
  }
  if (result) await saveOrder(ctx, value);
  return value;
};

export const saveOrder = async (
  ctx: Context,
  order: StoredOrder,
): Promise<void> => {
  await ctx.store.set(orderKey(order.orderRef), order);
  sweepMemoryStore(ctx);
};

// How many entries of an in-memory store one write looks at.
const sweepBatch = 8;
const sweepCursors = new WeakMap<
  Map<string, JsonValue>,
  IterableIterator<string>
>();

/**
 * Looks at the next few entries of an in-memory store, by the fake's clock,
 * and removes orders that can no longer be collected and personal number
 * lookups whose order is gone. The work per call is bounded and there is no
 * timer. A store of your own is left alone: it decides its own retention.
 */
const sweepMemoryStore = (ctx: Context): void => {
  const values = valuesOfMemoryStore(ctx.store);
  if (values === undefined) return;
  let cursor = sweepCursors.get(values) ?? values.keys();
  const now = ctx.now();
  for (let i = 0; i < Math.min(sweepBatch, values.size); i++) {
    let next = cursor.next();
    if (next.done === true) {
      cursor = values.keys();
      next = cursor.next();
      if (next.done === true) break;
    }
    const key = next.value;
    const value = values.get(key);
    if (key.startsWith("order:")) {
      if (!isStoredOrder(value)) continue;
      if (settle(structuredClone(value), now) !== "gone") continue;
      values.delete(key);
      if (value.personalNumber !== null) {
        const lookup = personalNumberKey(value.personalNumber);
        if (values.get(lookup) === value.orderRef) values.delete(lookup);
      }
    } else if (
      key.startsWith("personalNumber:") &&
      !(typeof value === "string" && values.has(orderKey(value)))
    ) {
      values.delete(key);
    }
  }
  sweepCursors.set(values, cursor);
};

/**
 * Releases the personal number lookup if it still points to this order. A
 * lookup that points elsewhere belongs to a newer order and is left alone.
 */
const releasePersonalNumber = async (
  ctx: Context,
  order: StoredOrder,
): Promise<void> => {
  if (order.personalNumber === null) return;
  const key = personalNumberKey(order.personalNumber);
  if ((await ctx.store.get(key)) === order.orderRef)
    await ctx.store.delete(key);
};

/** Deletes an order and its personal number lookup. */
export const removeOrder = async (
  ctx: Context,
  order: StoredOrder,
): Promise<void> => {
  await ctx.store.delete(orderKey(order.orderRef));
  await releasePersonalNumber(ctx, order);
};

/** Moves a pending order to a final state and saves it. */
export const finish = async (
  ctx: Context,
  order: StoredOrder,
  state:
    | {
        status: "complete";
        user: FakeUser;
        overrides: { [key: string]: JsonValue };
      }
    | { status: "failed"; hintCode: string },
): Promise<void> => {
  const now = ctx.now();
  order.pickedUp = true;
  if (state.status === "complete") {
    const generated = completionData(order, normaliseUser(state.user));
    order.state = {
      status: "complete",
      // The user and the marked fields go last, so no override replaces them.
      completionData: {
        ...generated,
        ...state.overrides,
        user: generated.user as JsonValue,
        signature: generated.signature as JsonValue,
        ocspResponse: generated.ocspResponse as JsonValue,
      },
      collectableUntil: now + completeCollectableMs,
    };
  } else fail(order, state.hintCode, now + failedCollectableMs);
  await saveOrder(ctx, order);
  await releasePersonalNumber(ctx, order);
};

/** Sets the pending hint codes an order steps through. */
export const setHintCodes = (order: StoredOrder, hintCodes: string[]): void => {
  order.state = { status: "pending", hintCodes };
  if (!notPickedUp.has(hintCodes[0] as string)) order.pickedUp = true;
};

export const normaliseUser = (user: FakeUser): FakeUserJson => {
  const words = user.name?.trim().split(/\s+/) ?? [];
  const givenName = user.givenName ?? words[0] ?? "Test";
  const surname =
    user.surname ?? (words.length > 1 ? words.slice(1).join(" ") : "Testsson");
  return {
    personalNumber: user.personalNumber,
    name: user.name ?? `${givenName} ${surname}`,
    givenName,
    surname,
  };
};

const base64 = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64");

const stepUpFor = (
  request: StoredOrder["request"],
): { mrtd: true } | undefined => {
  const requirement = request.requirement as
    { mrtd?: boolean; stepUp?: string[] } | undefined;
  return requirement?.mrtd === true || requirement?.stepUp?.includes("mrtd")
    ? { mrtd: true }
    : undefined;
};

/** Completion data in the spec's shape, marked as fake. */
const completionData = (
  order: StoredOrder,
  user: FakeUserJson,
): { [key: string]: JsonValue } => {
  const { request } = order;
  const field = (name: string) =>
    typeof request[name] === "string"
      ? `<${name}>${request[name]}</${name}>`
      : "";
  // The user's fields are 12 digits and the request fields are base64, so none
  // needs escaping in XML.
  const signature = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<FakeSignature xmlns="${fakeMarker}">`,
    "<Notice>Made by bankid/testing. This is not a BankID signature.</Notice>",
    `<orderRef>${order.orderRef}</orderRef>`,
    `<personalNumber>${user.personalNumber}</personalNumber>`,
    field("userVisibleData"),
    field("userNonVisibleData"),
    "</FakeSignature>",
  ].join("");
  const stepUp = stepUpFor(request);
  const uhi = createHash("sha1").update(fakeMarker).digest("base64");
  return {
    user,
    // A phone order has no endUserIp, and the spec makes ipAddress optional.
    device:
      typeof request.endUserIp === "string"
        ? { ipAddress: request.endUserIp, uhi }
        : { uhi },
    bankIdIssueDate: "2020-01-01Z",
    ...(stepUp ? { stepUp } : {}),
    signature: base64(signature),
    ocspResponse: base64(
      `${fakeMarker}: made by bankid/testing. This is not an OCSP response.`,
    ),
    ...(request.returnRisk === true ? { risk: "low" } : {}),
  } satisfies CompletionData;
};

/**
 * Starts an order for a start endpoint. An order with a personal number, while
 * another order with the same personal number is pending, fails with
 * `alreadyInProgress` and cancels the pending order, as BankID's errors guide
 * describes. A phone or `/other/payment` order answers with its `orderRef`
 * only, as the spec says.
 *
 * Two processes sharing a store can both start an order for the same personal
 * number at the same moment: each reads the lookup before the other writes it,
 * and both orders are created. The store's get, set and delete cannot rule
 * that out.
 */
export const startOrder = (
  ctx: Context,
  path: string,
  request: { [key: string]: JsonValue },
  personalNumber: string | null,
): Promise<Reply> =>
  personalNumber === null
    ? createOrder(ctx, path, request, null)
    : ctx.serial(personalNumberKey(personalNumber), async () => {
        const key = personalNumberKey(personalNumber);
        const existingRef = await ctx.store.get(key);
        if (typeof existingRef === "string") {
          const cancelled = await ctx.serial(
            orderKey(existingRef),
            async () => {
              const existing = await loadOrder(ctx, existingRef);
              if (existing?.state.status !== "pending") return false;
              fail(existing, "cancelled", ctx.now() + failedCollectableMs);
              await saveOrder(ctx, existing);
              return true;
            },
          );
          if (cancelled) {
            await ctx.store.delete(key);
            return {
              status: 400,
              body: {
                errorCode: "alreadyInProgress",
                details: "Order already in progress for personalNumber",
              },
            };
          }
        }
        return createOrder(ctx, path, request, personalNumber);
      });

const createOrder = async (
  ctx: Context,
  path: string,
  request: { [key: string]: JsonValue },
  personalNumber: string | null,
): Promise<Reply> => {
  const createdAt = ctx.now();
  const order: StoredOrder = {
    version: 1,
    orderRef: randomUUID(),
    path,
    createdAt,
    request,
    personalNumber,
    qrStartToken: randomUUID(),
    qrStartSecret: randomUUID(),
    pickedUp: false,
    autoComplete: null,
    state: { status: "pending", hintCodes: ["outstandingTransaction"] },
  };
  if (ctx.autoComplete !== undefined) {
    // For local development the order behaves as if the app picked it up at
    // once. The order's personal number wins over the configured user's.
    const user = normaliseUser(ctx.autoComplete.user);
    if (personalNumber !== null) user.personalNumber = personalNumber;
    order.autoComplete = { at: createdAt + ctx.autoComplete.afterMs, user };
    setHintCodes(order, ["userSign"]);
  }
  await saveOrder(ctx, order);
  if (personalNumber !== null)
    await ctx.store.set(personalNumberKey(personalNumber), order.orderRef);
  if (hasNoQrCode(order)) return ok({ orderRef: order.orderRef });
  return ok({
    orderRef: order.orderRef,
    autoStartToken: randomUUID(),
    qrStartToken: order.qrStartToken,
    qrStartSecret: order.qrStartSecret,
  });
};

/**
 * Collects an order. A pending order answers with its current hint code and
 * moves to the next scripted one. A final state is answered once, then the
 * order is deleted, so the next collect gets `invalidParameters`. Operations
 * on one order run one at a time in all fakes in this process that share the
 * store.
 */
export const collectOrder = (ctx: Context, orderRef: string): Promise<Reply> =>
  ctx.serial(orderKey(orderRef), () => collectNow(ctx, orderRef));

const collectNow = async (ctx: Context, orderRef: string): Promise<Reply> => {
  const order = await loadOrder(ctx, orderRef);
  if (order === undefined) return noSuchOrder();
  const { state } = order;
  switch (state.status) {
    case "pending": {
      const [hintCode, ...rest] = state.hintCodes as [string, ...string[]];
      if (rest.length > 0) {
        setHintCodes(order, rest);
        await saveOrder(ctx, order);
      }
      return ok({ orderRef, status: "pending", hintCode });
    }
    case "complete":
      await removeOrder(ctx, order);
      return ok({
        orderRef,
        status: "complete",
        completionData: state.completionData,
      });
    case "failed":
      await removeOrder(ctx, order);
      return ok({ orderRef, status: "failed", hintCode: state.hintCode });
  }
};

/**
 * Cancels an order: it is deleted, so a later collect gets
 * `invalidParameters`. The docs do not say what cancelling an order that has
 * reached a final state does; the fake deletes it too and answers as for a
 * pending order.
 */
export const cancelOrder = (ctx: Context, orderRef: string): Promise<Reply> =>
  ctx.serial(orderKey(orderRef), async () => {
    const order = await loadOrder(ctx, orderRef);
    if (order === undefined) return noSuchOrder();
    await removeOrder(ctx, order);
    return ok({});
  });
