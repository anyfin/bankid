import type { paths } from "./generated/auth-sign.ts";

/** A relying-party API path from BankID's spec, such as `"/auth"`. */
export type BankIdPath = keyof paths;

// A record, so the compiler checks the list against the spec both ways.
const knownPaths: Record<BankIdPath, true> = {
  "/auth": true,
  "/sign": true,
  "/payment": true,
  "/payment/bulk": true,
  "/phone/auth": true,
  "/phone/sign": true,
  "/phone/payment": true,
  "/phone/payment/bulk": true,
  "/other/payment": true,
  "/collect": true,
  "/cancel": true,
};

/** Whether the value is one of the paths in BankID's spec. */
export const isBankIdPath = (value: unknown): value is BankIdPath =>
  typeof value === "string" && Object.hasOwn(knownPaths, value);

/** One request to the BankID relying-party API, as handed to a transport. */
export interface BankIdTransportRequest {
  /** Always `"POST"`; BankID accepts no other method. */
  method: "POST";
  /** Path relative to the API base URL, as named in BankID's spec. */
  path: BankIdPath;
  /** The JSON request body, with text fields already base64-encoded. */
  body: Record<string, unknown>;
  /**
   * Aborts the request. It fires when the caller aborts or the client's
   * timeout passes. A transport should stop work and reject when it fires.
   */
  signal: AbortSignal;
}

/** The HTTP response a transport hands back to the client. */
export interface BankIdTransportResponse {
  /**
   * HTTP status code, a whole number from 100 to 599. Anything else makes the
   * client throw a `BankIdTransportError` with reason `invalidResponse`.
   */
  status: number;
  /**
   * The response body: either the raw text, which the client parses as JSON,
   * or an already parsed JSON object, which the client copies through
   * `JSON.stringify`.
   */
  body: string | object;
}

/**
 * Sends one request to BankID and returns its HTTP response, whatever the
 * status. The client turns error statuses into errors. Reject only when there
 * is no response at all: whatever a transport throws, even a
 * `BankIdApiError`, becomes a new `BankIdTransportError` with reason
 * `network`, keeping only a summary of allowlisted fields as its `cause`.
 *
 * The default transport speaks mutual TLS to BankID with `node:https`. Provide
 * your own for fakes, proxies or instrumentation.
 */
export type BankIdTransport = (
  request: BankIdTransportRequest,
) => Promise<BankIdTransportResponse>;
