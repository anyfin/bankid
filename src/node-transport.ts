import { Buffer } from "node:buffer";
import { request as httpsRequest, Agent } from "node:https";
import { createSecureContext, type SecureContext } from "node:tls";
import { causeMessage } from "./errors.ts";
import { productionRootCa, testRootCa } from "./root-ca.ts";
import { isBankIdPath, type BankIdTransport } from "./transport.ts";

/** Which BankID service to talk to. */
export type BankIdEnvironment = "production" | "test";

const environments: Record<BankIdEnvironment, { baseUrl: string; ca: string }> =
  {
    production: {
      baseUrl: "https://appapi2.bankid.com/rp/v6.0/",
      ca: productionRootCa,
    },
    test: {
      baseUrl: "https://appapi2.test.bankid.com/rp/v6.0/",
      ca: testRootCa,
    },
  };

/** Whether the value is `"production"` or `"test"`. */
export const isEnvironment = (value: unknown): value is BankIdEnvironment =>
  typeof value === "string" && Object.hasOwn(environments, value);

/** Certificate material as PEM text or raw bytes. */
export type CertificateInput = string | Uint8Array;

/** The relying party's certificate as a PKCS#12 (`.p12`, `.pfx`) file. */
export interface PfxCredentials {
  /**
   * The PKCS#12 file's bytes, or the same bytes base64-encoded as a string.
   * A string that is not base64, or that does not decode to a PKCS#12 file,
   * such as a file path, is refused when the transport is created.
   */
  pfx: string | Uint8Array;
  passphrase: string;
  cert?: never;
  key?: never;
}

/** The relying party's certificate and private key in PEM form. */
export interface PemCredentials {
  cert: CertificateInput;
  key: CertificateInput;
  /** Passphrase for an encrypted private key. */
  passphrase?: string;
  pfx?: never;
}

/**
 * The relying party's client certificate, given as contents, never as a file
 * path.
 */
export type BankIdCredentials = PfxCredentials | PemCredentials;

const toBuffer = (input: Uint8Array): Buffer =>
  Buffer.from(input.buffer, input.byteOffset, input.byteLength);

const pem = (input: CertificateInput): string | Buffer =>
  typeof input === "string" ? input : toBuffer(input);

// A string pfx is often a file path carried over from 3.x. Messages about it
// never include the string, which could be the certificate itself.
const pfxStringHelp =
  "A pfx string must be the PKCS#12 file's bytes base64-encoded. To use a file, pass its bytes, for example from readFileSync";

/**
 * Whether the text could be base64, in the standard or URL-safe alphabet,
 * with or without padding, ignoring whitespace and line breaks.
 */
const isPlausibleBase64 = (text: string): boolean => {
  const compact = text.replace(/\s+/g, "");
  const match = /^[A-Za-z0-9+/_-]+(={0,2})$/.exec(compact);
  if (match === null) return false;
  const padding = match[1]!.length;
  const data = compact.length - padding;
  // A last group of one character carries no whole byte.
  if (data % 4 === 1) return false;
  return padding === 0 || compact.length % 4 === 0;
};

/**
 * Whether the bytes start as a PKCS#12 file does: a DER or BER sequence whose
 * first element is the version, the integer 3.
 */
const looksLikePkcs12 = (bytes: Uint8Array): boolean => {
  if (bytes[0] !== 0x30 || bytes.length < 2) return false;
  const length = bytes[1]!;
  // Short form, indefinite (0x80), or long form with 1 to 4 length bytes.
  const header = length <= 0x80 ? 2 : length <= 0x84 ? 2 + (length & 0x7f) : 0;
  return (
    header > 0 &&
    bytes[header] === 0x02 &&
    bytes[header + 1] === 0x01 &&
    bytes[header + 2] === 0x03
  );
};

const decodePfx = (pfx: string): Buffer => {
  if (!isPlausibleBase64(pfx)) throw new TypeError(`${pfxStringHelp}.`);
  return Buffer.from(pfx, "base64");
};

const secureContextFor = (
  credentials: BankIdCredentials,
  ca: CertificateInput | readonly CertificateInput[],
): SecureContext => {
  const cas = (Array.isArray(ca) ? ca : [ca]) as readonly CertificateInput[];
  const keyMaterial =
    credentials.pfx !== undefined
      ? {
          pfx:
            typeof credentials.pfx === "string"
              ? decodePfx(credentials.pfx)
              : toBuffer(credentials.pfx),
          passphrase: credentials.passphrase,
        }
      : {
          cert: pem(credentials.cert),
          key: pem(credentials.key),
          ...(credentials.passphrase === undefined
            ? {}
            : { passphrase: credentials.passphrase }),
        };
  try {
    return createSecureContext({
      ...keyMaterial,
      ca: cas.map(pem),
      minVersion: "TLSv1.2",
    });
  } catch (error) {
    // OpenSSL's message, such as "mac verify failure", names the problem
    // without echoing the input.
    const message =
      typeof credentials.pfx === "string" &&
      "pfx" in keyMaterial &&
      !looksLikePkcs12(keyMaterial.pfx)
        ? `Could not load the BankID client certificate. ${pfxStringHelp}.`
        : "Could not load the BankID client certificate or CA";
    throw new Error(message, { cause: error });
  }
};

// The largest response body the transport reads. BankID's largest response, a
// completed collect, is tens of kilobytes; a proxy could send without end.
const maxResponseBytes = 1024 * 1024;

// The messages of errors that a request or response of the transport below
// emitted, as they were then. Node writes them about the connection, so the
// client may keep them. Recorded at once, so a wrapper that changes the
// error's message later cannot change what the client keeps.
const socketErrorMessages = new WeakMap<object, string>();

/**
 * The message the default transport recorded when its socket emitted this
 * error, or undefined for any other value.
 */
export const nodeSocketErrorMessage = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null
    ? socketErrorMessages.get(value)
    : undefined;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCertificate = (value: unknown): boolean =>
  (typeof value === "string" && value.length > 0) ||
  value instanceof Uint8Array;

/**
 * Whether the value has the shape of {@link BankIdCredentials}: `{ pfx,
 * passphrase }` or `{ cert, key, passphrase? }`, as non-empty strings or
 * bytes. Whether the certificate loads is checked later.
 */
export const isCredentials = (value: unknown): value is BankIdCredentials =>
  isObject(value) &&
  (value.pfx !== undefined
    ? isCertificate(value.pfx) &&
      typeof value.passphrase === "string" &&
      value.cert === undefined &&
      value.key === undefined
    : isCertificate(value.cert) &&
      isCertificate(value.key) &&
      (value.passphrase === undefined || typeof value.passphrase === "string"));

/** Options for {@link createNodeTransport}. */
export interface NodeTransportOptions {
  /** `"production"` or `"test"`. There is no default. */
  environment: BankIdEnvironment;
  /** The relying party's client certificate. */
  credentials: BankIdCredentials;
  /**
   * Root CAs to trust for BankID's server certificate. Defaults to BankID's
   * root CA for the environment, which the package bundles.
   */
  ca?: CertificateInput | readonly CertificateInput[];
}

/**
 * Creates the transport that {@link createBankIdClient} uses when given
 * `credentials`: HTTP/1.1 to BankID over mutual TLS (1.2 or newer), with
 * keep-alive. Use it to wrap the built-in transport, for example to time or
 * log requests, and pass the wrapper as the client's `transport`.
 *
 * It takes no timeout: the client aborts each request's `signal` when the
 * client's `timeoutMs` passes, and this transport stops when the signal
 * aborts. The certificate is loaded at once, so bad credentials throw here.
 * A transport created once can serve several clients and shares its pool of
 * keep-alive connections between them. A request whose `path` is not one of
 * the paths in BankID's spec is rejected with a `TypeError` before any URL is
 * built.
 */
export const createNodeTransport = (
  options: NodeTransportOptions,
): BankIdTransport => {
  if (!isObject(options))
    throw new TypeError("createNodeTransport needs an options object");
  if (!isEnvironment(options.environment))
    throw new TypeError(
      'createNodeTransport: environment must be "production" or "test"',
    );
  if (!isCredentials(options.credentials))
    throw new TypeError(
      "createNodeTransport: credentials must be { pfx, passphrase } or { cert, key, passphrase? }, as strings or bytes",
    );
  const environment = environments[options.environment];
  return createTransportForUrl({
    baseUrl: environment.baseUrl,
    credentials: options.credentials,
    ca: options.ca ?? environment.ca,
  });
};

/**
 * The built-in transport for any base URL, which tests point at a local
 * server. Each request is a POST with a JSON body. It honours the request's
 * abort signal; the client sets that signal's timeout.
 */
export const createTransportForUrl = (options: {
  baseUrl: string;
  credentials: BankIdCredentials;
  ca: CertificateInput | readonly CertificateInput[];
}): BankIdTransport => {
  const agent = new Agent({
    keepAlive: true,
    secureContext: secureContextFor(options.credentials, options.ca),
    // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn verification off.
    rejectUnauthorized: true,
  });

  return ({ method, path, body, signal }) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      // A path from outside the spec could change the URL's origin.
      if (!isBankIdPath(path)) {
        reject(
          new TypeError(
            "request path must be one of the paths in BankID's spec",
          ),
        );
        return;
      }
      let payload: string;
      try {
        payload = JSON.stringify(body);
      } catch {
        // The error could quote the body, so a fixed text instead.
        reject(new TypeError("The request body could not be written as JSON"));
        return;
      }
      const req = httpsRequest(
        new URL(path.slice(1), options.baseUrl),
        {
          method,
          agent,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              // No BankID response comes near this size. Status 0 makes the
              // client report `invalidResponse`.
              req.destroy();
              signal.removeEventListener("abort", onAbort);
              resolve({ status: 0, body: "" });
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", socketFail);
          res.on("end", () => {
            signal.removeEventListener("abort", onAbort);
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      function fail(error: unknown) {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
      function socketFail(error: unknown) {
        if (typeof error === "object" && error !== null) {
          let message: string | undefined;
          try {
            message = causeMessage((error as { message?: unknown }).message);
          } catch {
            // No message to keep.
          }
          if (message !== undefined) socketErrorMessages.set(error, message);
        }
        fail(error);
      }
      function onAbort() {
        req.destroy();
        fail(signal.reason);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("error", socketFail);
      req.end(payload);
    });
};
