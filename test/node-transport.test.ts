import { createPrivateKey } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { inspect } from "node:util";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  BankIdTransportError,
  createBankIdClient,
  createNodeTransport,
  type BankIdCredentials,
  type BankIdTransport,
  type NodeTransportOptions,
} from "../src/index.ts";
import { testCredentials } from "../src/testing/index.ts";
import {
  createTransportForUrl,
  type CertificateInput,
} from "../src/node-transport.ts";
import { causeMessage } from "../src/errors.ts";
import { testRootCa } from "../src/root-ca.ts";
import { createTlsFixtures, type TlsFixtures } from "./tls-fixtures.ts";

interface Received {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  clientSubject: string;
}

let tls: TlsFixtures;
let server: Server;
let baseUrl: string;
let received: Received[] = [];
let connections = 0;

const orderResponse = {
  orderRef: "131daac9-16c6-4618-beb0-365768f37288",
  autoStartToken: "7c40b5c9-fa74-49cf-b98c-bfe651f9a7c6",
  qrStartToken: "67df3917-fa0d-44e5-b327-edcc928297f8",
  qrStartSecret: "d28db9a7-4cde-429e-a983-359be676944c",
};

beforeAll(async () => {
  tls = createTlsFixtures();
  server = createServer(
    {
      key: tls.serverKey,
      cert: tls.serverCert,
      ca: tls.caCert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const socket = req.socket as TLSSocket;
        const body = Buffer.concat(chunks).toString("utf8");
        received.push({
          method: req.method ?? "",
          url: req.url ?? "",
          httpVersion: req.httpVersion,
          headers: req.headers,
          body,
          clientSubject: String(socket.getPeerCertificate().subject?.CN),
        });
        const requested = body.startsWith("{")
          ? (JSON.parse(body) as { orderRef?: unknown }).orderRef
          : undefined;
        if (requested === "hang") return; // never answers
        if (requested === "huge") {
          // A body larger than any BankID response, sent without end.
          res.writeHead(200, { "Content-Type": "application/json" });
          const chunk = "x".repeat(64 * 1024);
          const send = () => {
            while (!res.destroyed && res.write(chunk));
            if (!res.destroyed) res.once("drain", send);
          };
          res.on("error", () => {});
          send();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            req.url?.endsWith("/collect")
              ? {
                  orderRef: requested,
                  status: "pending",
                  hintCode: "outstandingTransaction",
                }
              : req.url?.endsWith("/cancel")
                ? {}
                : orderResponse,
          ),
        );
      });
    },
  );
  server.on("secureConnection", () => connections++);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `https://localhost:${port}/rp/v6.0/`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  received = [];
  connections = 0;
});

const clientFor = (
  credentials: BankIdCredentials,
  {
    ca = tls.caCert,
    timeoutMs,
  }: { ca?: CertificateInput; timeoutMs?: number } = {},
) =>
  createBankIdClient({
    environment: "test",
    transport: createTransportForUrl({ baseUrl, credentials, ca }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const pemCredentials = (): BankIdCredentials => ({
  cert: tls.clientCert,
  key: tls.clientKey,
});

describe("default transport", () => {
  it("sends auth with exactly these headers and body over mutual TLS", async () => {
    const bankid = clientFor(pemCredentials());
    const order = await bankid.auth({
      endUserIp: "192.0.2.10",
      returnUrl: "https://example.com/return#nonce=abc",
      returnRisk: true,
      userVisibleData: "Logga in på Åkes tjänst ✓",
      userVisibleDataFormat: "simpleMarkdownV1",
      web: {
        referringDomain: "example.com",
        userAgent: "Mozilla/5.0",
        deviceIdentifier: "device-1",
      },
      requirement: { personalNumber: "190010101010", stepUp: ["mrtd"] },
    });

    expect(order).toEqual(orderResponse);
    expect(received).toHaveLength(1);
    const [request] = received;
    const body = JSON.stringify({
      endUserIp: "192.0.2.10",
      returnUrl: "https://example.com/return#nonce=abc",
      returnRisk: true,
      userVisibleData: "TG9nZ2EgaW4gcMOlIMOFa2VzIHRqw6Ruc3Qg4pyT",
      userVisibleDataFormat: "simpleMarkdownV1",
      web: {
        referringDomain: "example.com",
        userAgent: "Mozilla/5.0",
        deviceIdentifier: "device-1",
      },
      requirement: { personalNumber: "190010101010", stepUp: ["mrtd"] },
    });
    expect(request).toEqual({
      method: "POST",
      url: "/rp/v6.0/auth",
      httpVersion: "1.1",
      headers: {
        host: new URL(baseUrl).host,
        connection: "keep-alive",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
      clientSubject: "Throwaway Relying Party",
    });
  });

  it("sends sign with exactly these headers and body", async () => {
    const bankid = clientFor(pemCredentials());
    await bankid.sign({
      endUserIp: "2001:db8::1",
      userVisibleData: "Jag godkänner avtalet för 1 000 kr — 東京",
      userNonVisibleData: "kontrakt-ärende 42",
      app: { appIdentifier: "com.example.app", deviceOS: "iOS 18" },
    });

    const body = JSON.stringify({
      endUserIp: "2001:db8::1",
      userVisibleData: Buffer.from(
        "Jag godkänner avtalet för 1 000 kr — 東京",
      ).toString("base64"),
      userNonVisibleData: "a29udHJha3Qtw6RyZW5kZSA0Mg==",
      app: { appIdentifier: "com.example.app", deviceOS: "iOS 18" },
    });
    expect(received[0]).toMatchObject({
      method: "POST",
      url: "/rp/v6.0/sign",
      headers: {
        host: new URL(baseUrl).host,
        connection: "keep-alive",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    expect(Object.keys(received[0]!.headers).sort()).toEqual([
      "connection",
      "content-length",
      "content-type",
      "host",
    ]);
  });

  it("accepts a PKCS#12 file as bytes or as base64 text", async () => {
    for (const pfx of [tls.clientPfx, tls.clientPfx.toString("base64")]) {
      const bankid = clientFor({ pfx, passphrase: tls.pfxPassphrase });
      await expect(bankid.collect("ref")).resolves.toBeDefined();
    }
    expect(received.map(r => r.clientSubject)).toEqual([
      "Throwaway Relying Party",
      "Throwaway Relying Party",
    ]);
  });

  it("accepts base64 text with line breaks, the URL-safe alphabet or no padding", async () => {
    const base64 = tls.clientPfx.toString("base64");
    const variants = [
      `\n  ${base64.replace(/.{64}/g, "$&\r\n")}  \n`,
      tls.clientPfx.toString("base64url"),
      base64.replace(/=+$/, ""),
    ];
    for (const pfx of variants) {
      const bankid = clientFor({ pfx, passphrase: tls.pfxPassphrase });
      await expect(bankid.collect("ref")).resolves.toBeDefined();
    }
    expect(received).toHaveLength(variants.length);
  });

  it("accepts a PEM certificate with an encrypted key as text or bytes", async () => {
    const passphrase = "key-passphrase";
    const key = createPrivateKey(tls.clientKey).export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    }) as string;
    await clientFor({ cert: tls.clientCert, key, passphrase }).collect("ref");
    await clientFor({
      cert: new TextEncoder().encode(tls.clientCert),
      key: Buffer.from(key),
      passphrase,
    }).collect("ref");
    expect(received).toHaveLength(2);
  });

  it("reuses the connection between requests", async () => {
    const bankid = clientFor(pemCredentials());
    await bankid.collect("one");
    await bankid.collect("two");
    await bankid.cancel("three");
    expect(received).toHaveLength(3);
    expect(connections).toBe(1);
  });

  it("fails when the server does not accept the client certificate", async () => {
    const bankid = clientFor({ cert: tls.strangerCert, key: tls.strangerKey });
    const error = await bankid.collect("ref").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "network", retryable: false });
    expect(received).toHaveLength(0);
  });

  it("rejects a server whose certificate BankID's root CA did not issue", async () => {
    const bankid = clientFor(pemCredentials(), { ca: testRootCa });
    const error = await bankid.collect("ref").catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "network" });
    expect(received).toHaveLength(0);
  });

  it("rejects an untrusted server even when NODE_TLS_REJECT_UNAUTHORIZED is 0", async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const bankid = clientFor(pemCredentials(), { ca: testRootCa });
      const error = await bankid.collect("ref").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BankIdTransportError);
      expect(error).toMatchObject({ reason: "network" });
      expect(received).toHaveLength(0);
    } finally {
      if (previous === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });

  it("times out when the server does not answer", async () => {
    const transport = createTransportForUrl({
      baseUrl,
      credentials: pemCredentials(),
      ca: tls.caCert,
    });
    // The server never answers a collect of the order "hang".
    const bankid = createBankIdClient({
      environment: "test",
      timeoutMs: 200,
      transport,
    });
    const started = Date.now();
    const error = await bankid.collect("hang").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(received).toHaveLength(1);
  });

  it("stops reading a response body over 1 MiB and reports invalidResponse", async () => {
    const transport = createTransportForUrl({
      baseUrl,
      credentials: pemCredentials(),
      ca: tls.caCert,
    });
    const bankid = createBankIdClient({ environment: "test", transport });
    const error = await bankid.collect("huge").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "invalidResponse" });
  });

  it("aborts an in-flight request when the signal fires", async () => {
    const transport = createTransportForUrl({
      baseUrl,
      credentials: pemCredentials(),
      ca: tls.caCert,
    });
    const bankid = createBankIdClient({ environment: "test", transport });
    const controller = new AbortController();
    const pending = bankid.collect("hang", { signal: controller.signal });
    while (received.length === 0) await new Promise(r => setTimeout(r, 10));
    controller.abort(new Error("user went away"));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "aborted" });
    // The caller's reason is not kept, nor its message.
    expect((error as Error).cause).toEqual({ name: "Error" });
  });

  it("keeps Node's own message and code for a network failure", async () => {
    const bankid = clientFor(pemCredentials(), { ca: testRootCa });
    const error = await bankid.collect("ref").catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "network" });
    const cause = (error as Error).cause as Record<string, unknown>;
    expect(Object.getPrototypeOf(cause)).toBe(Object.prototype);
    expect(cause).toMatchObject({
      name: "Error",
      code: expect.any(String),
      message: expect.any(String),
    });
  });

  it("keeps the passphrase and request data out of TLS errors", async () => {
    const personalNumber = "190010101010";
    const visibleData = "Logga in hos Exempel AB";
    const bankid = clientFor(
      { pfx: tls.clientPfx, passphrase: tls.pfxPassphrase },
      { ca: testRootCa },
    );
    const error = await bankid
      .auth({
        endUserIp: "192.0.2.10",
        userVisibleData: visibleData,
        requirement: { personalNumber },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    const texts = [
      JSON.stringify(error),
      inspect(error, { depth: Infinity, showHidden: true }),
    ];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      texts.push(e.message, e.stack ?? "");
    }
    for (const text of texts) {
      for (const secret of [
        tls.pfxPassphrase,
        personalNumber,
        visibleData,
        Buffer.from(visibleData).toString("base64"),
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("refuses a path that is not in BankID's spec before building a URL", async () => {
    const transport = createTransportForUrl({
      baseUrl,
      credentials: pemCredentials(),
      ca: tls.caCert,
    });
    for (const path of [
      "//evil.example/rp/v6.0/auth",
      "/https://evil.example/",
      "/@evil.example/auth",
      "/../../auth",
      "/auth?personalNumber=200001012384",
      "/auth#x",
      "/hang",
      "auth",
      "",
      42,
    ]) {
      const error = await transport({
        method: "POST",
        path: path as "/auth",
        body: {},
        signal: new AbortController().signal,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "request path must be one of the paths in BankID's spec",
      );
    }
    expect(received).toHaveLength(0);
  });

  it("keeps no message when the request body cannot be written as JSON", async () => {
    const secret = "200001012384";
    const bankid = clientFor(pemCredentials());
    const error = await bankid
      .auth({
        endUserIp: "192.0.2.10",
        extra: {
          toJSON: () => {
            throw new Error(`no JSON for ${secret}`);
          },
        },
      } as unknown as Parameters<typeof bankid.auth>[0])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "network" });
    expect((error as Error).cause).toEqual({ name: "TypeError" });
    expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(
      secret,
    );
    expect(received).toHaveLength(0);
  });

  const pfxStringHelp =
    "A pfx string must be the PKCS#12 file's bytes base64-encoded. To use a file, pass its bytes, for example from readFileSync.";
  const loadError = (pfx: string, passphrase = tls.pfxPassphrase): Error => {
    try {
      createTransportForUrl({
        baseUrl,
        credentials: { pfx, passphrase },
        ca: tls.caCert,
      });
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the credentials to be refused");
  };
  const texts = (error: Error): string[] => [
    JSON.stringify(error),
    inspect(error, { depth: Infinity, showHidden: true }),
    error.message,
    String(error.cause),
  ];

  it("refuses a pfx string that is a file path, without echoing it", () => {
    for (const path of [
      "certs/bankid.p12",
      "/run/secrets/bankid.p12",
      "./bankid.pfx",
      "C:\\certs\\bankid.pfx",
      "~/bankid",
      "certs/prod=x",
      "abcde",
    ]) {
      const error = loadError(path);
      expect(error, path).toBeInstanceOf(TypeError);
      expect(error.message).toBe(pfxStringHelp);
      for (const text of texts(error)) expect(text).not.toContain(path);
    }
  });

  it("says the same when a pfx string decodes to something that is not a PKCS#12 file", () => {
    // Paths like these are valid base64, so only loading them fails.
    for (const path of ["certs/prod", "secrets/rp", "keys"]) {
      const error = loadError(path);
      expect(error, path).not.toBeInstanceOf(TypeError);
      expect(error.message).toBe(
        `Could not load the BankID client certificate. ${pfxStringHelp}`,
      );
      expect(error.cause).toBeInstanceOf(Error);
      for (const text of texts(error)) expect(text).not.toContain(path);
    }
  });

  it("keeps the general message for a PKCS#12 string with the wrong passphrase", () => {
    const passphrase = "not-the-right-passphrase";
    const error = loadError(tls.clientPfx.toString("base64"), passphrase);
    expect(error.message).toBe(
      "Could not load the BankID client certificate or CA",
    );
    for (const text of texts(error)) expect(text).not.toContain(passphrase);
  });

  it("refuses a pfx path when creating a client", () => {
    expect(() =>
      createBankIdClient({
        environment: "test",
        credentials: { pfx: "certs/bankid.p12", passphrase: "" },
      }),
    ).toThrow(new TypeError(pfxStringHelp));
  });

  it("refuses credentials it cannot load, without echoing them", () => {
    const passphrase = "not-the-right-passphrase";
    let error: unknown;
    try {
      createTransportForUrl({
        baseUrl,
        credentials: { pfx: tls.clientPfx, passphrase },
        ca: tls.caCert,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Could not load the BankID client certificate or CA",
    );
    expect(JSON.stringify(error)).not.toContain(passphrase);
    expect(String((error as Error).cause)).not.toContain(passphrase);
  });
});

describe("createNodeTransport", () => {
  it("creates the built-in transport for an environment without a request", () => {
    for (const environment of ["test", "production"] as const) {
      const transport = createNodeTransport({
        environment,
        credentials: testCredentials,
      });
      expect(transport).toBeTypeOf("function");
    }
    expect(received).toHaveLength(0);
  });

  it("takes an environment, credentials and an optional ca, and no timeout", () => {
    expectTypeOf<NodeTransportOptions>().toEqualTypeOf<{
      environment: "production" | "test";
      credentials: BankIdCredentials;
      ca?: CertificateInput | readonly CertificateInput[];
    }>();
    expectTypeOf(createNodeTransport).returns.toEqualTypeOf<BankIdTransport>();
    createNodeTransport({
      environment: "test",
      credentials: testCredentials,
      // @ts-expect-error the client owns the timeout, through the signal
      timeoutMs: 1000,
    });
  });

  it("checks its options like createBankIdClient", () => {
    const create = (options: unknown) => () =>
      createNodeTransport(options as NodeTransportOptions);
    expect(create(undefined)).toThrow(
      new TypeError("createNodeTransport needs an options object"),
    );
    expect(create({ credentials: testCredentials })).toThrow(
      new TypeError(
        'createNodeTransport: environment must be "production" or "test"',
      ),
    );
    for (const credentials of [
      undefined,
      { pfx: "", passphrase: "" },
      { pfx: testCredentials.pfx },
      { cert: "cert" },
    ])
      expect(create({ environment: "test", credentials })).toThrow(
        /^createNodeTransport: credentials must be/,
      );
  });

  it("loads the certificate at once", () => {
    expect(() =>
      createNodeTransport({
        environment: "test",
        credentials: { ...testCredentials, passphrase: "wrong" },
      }),
    ).toThrow("Could not load the BankID client certificate or CA");
    expect(() =>
      createNodeTransport({
        environment: "test",
        credentials: { pfx: "certs/rp.p12", passphrase: "" },
      }),
    ).toThrow(TypeError);
  });

  it("can be wrapped, here to time each request", async () => {
    const inner = createTransportForUrl({
      baseUrl,
      credentials: pemCredentials(),
      ca: tls.caCert,
    });
    const timings: { path: string; status: number | "error" }[] = [];
    const timed: BankIdTransport = async request => {
      try {
        const response = await inner(request);
        timings.push({ path: request.path, status: response.status });
        return response;
      } catch (error) {
        timings.push({ path: request.path, status: "error" });
        throw error;
      }
    };
    const bankid = createBankIdClient({
      environment: "test",
      transport: timed,
    });
    await expect(bankid.collect("ref")).resolves.toMatchObject({
      status: "pending",
    });
    expect(timings).toEqual([{ path: "/collect", status: 200 }]);
  });

  it("keeps Node's socket error message through a wrapper that rethrows", async () => {
    const inner = createTransportForUrl({
      baseUrl: "https://127.0.0.1:1/rp/v6.0/",
      credentials: pemCredentials(),
      ca: tls.caCert,
    });
    const bankid = createBankIdClient({
      environment: "test",
      transport: async request => inner(request),
    });
    const error = await bankid.collect("ref").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({
      reason: "network",
      cause: { code: "ECONNREFUSED", message: expect.any(String) },
    });
  });

  it("keeps the socket error message as Node wrote it, not as a wrapper changed it", async () => {
    const secret = "200001012384";
    const inner = createTransportForUrl({
      baseUrl: "https://127.0.0.1:1/rp/v6.0/",
      credentials: pemCredentials(),
      ca: tls.caCert,
    });
    let original = "";
    const bankid = createBankIdClient({
      environment: "test",
      transport: async request => {
        try {
          return await inner(request);
        } catch (error) {
          original = (error as Error).message;
          (error as Error).message = `refused for ${secret}`;
          throw error;
        }
      },
    });
    const error = await bankid.collect("ref").catch((e: unknown) => e);
    expect(original).not.toBe("");
    expect(error).toMatchObject({
      reason: "network",
      cause: { code: "ECONNREFUSED", message: original },
    });
    expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(
      secret,
    );
  });

  it("records a socket error message only without a run of 10 or more digits", () => {
    expect(causeMessage("connect ECONNREFUSED 127.0.0.1:1")).toBe(
      "connect ECONNREFUSED 127.0.0.1:1",
    );
    expect(causeMessage("failed for 200001012384")).toBeUndefined();
    expect(causeMessage("")).toBeUndefined();
    expect(causeMessage(5)).toBeUndefined();
    expect(causeMessage("x".repeat(600))).toHaveLength(500);
  });

  it("rebuilds what a wrapper throws as a BankIdTransportError", async () => {
    const secret = "200001012384";
    const bankid = createBankIdClient({
      environment: "test",
      transport: () => {
        throw new Error(`proxy refused ${secret}`);
      },
    });
    const error = await bankid.collect("ref").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "network" });
    expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(
      secret,
    );
  });
});
