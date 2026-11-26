// Shared by the server and client entry points, so it must not use Node APIs.
import type { FailedHintCode, PendingHintCode } from "./hint-codes.ts";

/**
 * The state of an order as a backend relays it to its front end. These are
 * plain JSON values: build one from a collect response, send it, and read it
 * on the front end. They carry nothing from the completed order.
 */
export type RelayedStatus = RelayedPending | RelayedComplete | RelayedFailed;

/** The order is still in progress. */
export interface RelayedPending {
  status: "pending";
  /** The collect result's hint code, when it had one. */
  hintCode?: PendingHintCode | undefined;
  /** The current QR code content, when the user starts with a QR code. */
  qrCode?: string;
}

/** The order is complete. */
export interface RelayedComplete {
  status: "complete";
}

/** The order failed. */
export interface RelayedFailed {
  status: "failed";
  /** The collect result's hint code, when it had one. */
  hintCode?: FailedHintCode | undefined;
}
