import { createHmac } from "node:crypto";

type QrCache = {
  startTime: number;
  qrStartToken: string;
  qrStartSecret: string;
};

interface QRGenerateOptions {
  /** max cycles */
  maxCycles?: number;
  /** in seconds  */
  timeout?: number;
}

export class QrGenerator {
  cache = new Map<string, QrCache>();

  constructor(qrStartSecret: string, qrStartToken: string, orderRef: string) {
    const now = Date.now();
    const qrStore = { startTime: now, qrStartSecret, qrStartToken };
    this.cache.set(orderRef, qrStore);
    return this;
  }

  /**
   * Generator yielding a new value for the qrcode within
   * the specified limits.
   **/
  *nextQr(
    orderRef: string,
    { maxCycles, timeout }: QRGenerateOptions = { timeout: 60 },
  ) {
    const qr = this.cache.get(orderRef);
    if (!qr) {
      return;
    }
    for (let i = 0; i >= 0; i++) {
      const secondsSinceStart = parseInt(
        `${(Date.now() - qr.startTime) / 1000}`,
        10,
      );
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
