import { createHmac } from "node:crypto";
import type { AuthResponse } from "./bankid";

interface QrCache {
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

export type MapCompatibleCache = Pick<typeof defaultCache, "get" | "delete"> & {
  set: (key: string, value: QrCache) => void;
};

export type QrGeneratorOptions =
  | {
      /** Provide your own `Map`-compatible caching layer */
      customCache: MapCompatibleCache;
    }
  | {
      orderTTL: number;
    };

/**
 * Default in-memory cache for storing qr payloads
 * based on `orderRef`.
 */
const defaultCache = new Map<string, QrCache>();

/** seconds */
const TIMEOUT = 60 as const;

export class QrGenerator {
  cache: MapCompatibleCache = defaultCache;

  static defaultOptions = { orderTTL: TIMEOUT } as const;

  constructor(
    { qrStartSecret, qrStartToken, orderRef }: AuthResponse,
    options: QrGeneratorOptions = QrGenerator.defaultOptions,
  ) {
    if ("customCache" in options && Boolean(options.customCache)) {
      this.cache = options.customCache;
    }
    const now = Date.now();
    const qrCacheEntry: QrCache = {
      startTime: now,
      qrStartSecret,
      qrStartToken,
    };
    this.cache.set(orderRef, qrCacheEntry);

    // local in-memory cache will auto-clean keys after set TTL
    if ("orderTTL" in options) {
      setTimeout(() => {
        this.cache.delete(orderRef);
      }, options.orderTTL * 1000);
    }
    return this;
  }

  /**
   * Generator yielding a new value for the qrcode within
   * the specified limits.
   **/
  *nextQr(
    orderRef: string,
    { maxCycles, timeout }: QRGenerateOptions = { timeout: TIMEOUT },
  ) {
    const qr = this.cache.get(orderRef);
    if (!qr) {
      return;
    }
    for (let i = 0; i >= 0; i++) {
      const secondsSinceStart = Math.floor((Date.now() - qr.startTime) / 1000);
      if (maxCycles && i >= maxCycles) return;
      if (timeout && timeout < secondsSinceStart) return;

      yield this.#generateQr(
        qr.qrStartSecret,
        qr.qrStartToken,
        secondsSinceStart,
      );
    }
  }

  #generateQr = (qrStartSecret: string, qrStartToken: string, time: number) => {
    const qrAuthCode = createHmac("sha256", qrStartSecret)
      .update(`${time}`)
      .digest("hex");
    return `bankid.${qrStartToken}.${time}.${qrAuthCode}`;
  };
}
