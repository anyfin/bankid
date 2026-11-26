/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Where the fake keeps its orders. Provide your own to share orders between
 * processes, for example several instances of a backend in an end-to-end test.
 * Values are plain JSON, so any key-value store will do.
 *
 * The fake uses two kinds of key:
 * - `order:<orderRef>` holds an order.
 * - `personalNumber:<personalNumber>` holds the `orderRef` of the last order
 *   started with that personal number as a requirement. It is a lookup only:
 *   the order itself decides whether it is still open.
 *
 * The store needs no expiry of its own. The fake works out expiry from the
 * order's timestamps and deletes what it finds expired.
 */
export interface FakeBankIdStore {
  /** Returns the value for the key, or `undefined` when there is none. */
  get(key: string): Promise<JsonValue | undefined>;
  /** Stores the value for the key, replacing any value already there. */
  set(key: string, value: JsonValue): Promise<void>;
  /** Removes the key. Removing a missing key is not an error. */
  delete(key: string): Promise<void>;
}

// The values of each store made by createMemoryStore, so a fake can clean up
// after orders nobody collects; see sweepMemoryStore in orders.ts.
const memoryValues = new WeakMap<FakeBankIdStore, Map<string, JsonValue>>();

/** The values of a store made by {@link createMemoryStore}, or undefined. */
export const valuesOfMemoryStore = (
  store: FakeBankIdStore,
): Map<string, JsonValue> | undefined => memoryValues.get(store);

/**
 * The default store: a `Map` in this process. Values are copied in and out, so
 * changing a value after storing it changes nothing. Pass the same store to
 * two fakes to have them share orders.
 *
 * It does not grow without bound: on each write, a fake using it looks at a
 * few stored entries and removes orders that can no longer be collected, with
 * their personal number lookups. It sets no timers.
 */
export const createMemoryStore = (): FakeBankIdStore => {
  const values = new Map<string, JsonValue>();
  const store: FakeBankIdStore = {
    get: async key => {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async key => {
      values.delete(key);
    },
  };
  memoryValues.set(store, values);
  return store;
};

export const orderKey = (orderRef: string): string => `order:${orderRef}`;

export const personalNumberKey = (personalNumber: string): string =>
  `personalNumber:${personalNumber}`;
