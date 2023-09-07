import { createHmac } from "node:crypto";
import type { AuthResponse } from "./bankid";

export interface QrCacheEntry {
  startTime: number;
  qrStartToken: string;
  qrStartSecret: string;
}

interface QRGenerateOptions {
  /** max cycles */
  maxCycles?: number;
  /** in seconds  */
  timeout?: number;
}

export type QrGeneratorOptions =
  | {
      /** Provide your own caching layer */
      customCache: QrGeneratorCache;
    }
  | {
      orderTTL: number;
    };

/**
 * Default in-memory cache for storing qr payloads
 * based on `orderRef`.
 */
const _defaultCacheMap = new Map<string, QrCacheEntry>();
const defaultCache = {
  get: (key: string) => Promise.resolve(_defaultCacheMap.get(key)),
  set: (key: string, value: QrCacheEntry) =>
    Promise.resolve(_defaultCacheMap.set(key, value)).then(() => void 0),
  delete: (key: string) => Promise.resolve(_defaultCacheMap.delete(key)),
};

export type QrGeneratorCache = typeof defaultCache;

/** seconds */
const TIMEOUT = 60 as const;

/**
 * QrGenerator is an optional class responsible for generating QR codes based
 * on bankID responses and caching them with its custom cache store.
 * It has functionalities to generate and retrieve the latest QR code
 * from cache and cycle through a new QR code value.
 */
export class QrGenerator {
  cache: QrGeneratorCache = defaultCache;
  orderRef: string | null;

  static defaultOptions = { orderTTL: TIMEOUT } as const;

  constructor(
    resp: AuthResponse | null,
    options: QrGeneratorOptions = QrGenerator.defaultOptions,
  ) {
    if ("customCache" in options && Boolean(options.customCache)) {
      this.cache = options.customCache;
    }

    this.orderRef = resp?.orderRef || null;
    // If constructed with a response, set the cache
    if (resp) {
      const { qrStartSecret, qrStartToken, orderRef } = resp;
      const now = Date.now();
      const qrCacheEntry: QrCacheEntry = {
        startTime: now,
        qrStartSecret,
        qrStartToken,
      };
      this.cache.set(orderRef, qrCacheEntry);
    }

    // local in-memory cache will auto-clean keys after set TTL
    if ("orderTTL" in options) {
      setTimeout(() => {
        if (this.orderRef) {
          this.cache.delete(this.orderRef);
        }
      }, options.orderTTL * 1000);
    }
    return this;
  }

  /**
   * latestQrFromCache is a static asynchronous method that generates the latest QR code from cache.
   *
   * @param {string} orderRef - The order reference to be used for generating QR code.
   * @param {QrGeneratorCache} [customCache=defaultCache] - Optional parameter, the cache store to be used for generating QR code.
   * If no customCache is provided, the defaultCache is used.
   *
   * @returns {Promise<string>} - It returns a Promise that resolves with the latest QR code for the provided order reference.
   **/
  static async latestQrFromCache(
    orderRef: string,
    customCache: QrGeneratorCache = defaultCache,
  ) {
    const instance = new QrGenerator(null, { customCache });
    return (await instance.nextQr(orderRef, { maxCycles: 1 }).next()).value;
  }

  /**
   * Generator yielding a new value for the qrcode within
   * the specified limits.
   * @example
   * ```
   * for await (const qr of qrInstance?.nextQr(orderRef, { timeout: 60 })) {
   *  // Put value from qr in a cache
   *  await sleep(2000)
   * }
   * ```
   **/
  async *nextQr(
    orderRef: string,
    { maxCycles, timeout }: QRGenerateOptions = { timeout: TIMEOUT },
  ) {
    const qr = await this.cache.get(orderRef);
    if (!qr) return;
    for (let i = 0; i >= 0; i++) {
      const secondsSinceStart = Math.floor((Date.now() - qr.startTime) / 1000);

      // Stop cycle if maxCycles is reached or timeout has occurred
      if (maxCycles && i >= maxCycles) return;
      if (timeout && timeout < secondsSinceStart) return;

      yield this.#generateQr(
        qr.qrStartSecret,
        qr.qrStartToken,
        secondsSinceStart,
      );
    }
  }

  /**
   * Private method `#generateQr` generates a new QR code
   */
  #generateQr = (qrStartSecret: string, qrStartToken: string, time: number) => {
    const qrAuthCode = createHmac("sha256", qrStartSecret)
      .update(`${time}`)
      .digest("hex");
    return `bankid.${qrStartToken}.${time}.${qrAuthCode}`;
  };
}
