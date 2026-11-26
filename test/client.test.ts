import { inspect } from "node:util";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BankIdApiError,
  BankIdTransportError,
  createBankIdClient,
  qrCode,
  type BankIdClientOptions,
  type BankIdTransport,
  type BankIdTransportRequest,
  type BankIdTransportResponse,
  type CallInitiator,
  type CollectResponse,
  type CompletionData,
  type FailedHintCode,
  type KnownRiskLevel,
  type PendingHintCode,
  type PhoneAuthRequest,
  type PhoneOrderResponse,
  type RiskLevel,
} from "../src/index.ts";
import { startUrl } from "../src/client/index.ts";

const orderRef = "131daac9-16c6-4618-beb0-365768f37288";
const order = {
  orderRef,
  autoStartToken: "7c40b5c9-fa74-49cf-b98c-bfe651f9a7c6",
  qrStartToken: "67df3917-fa0d-44e5-b327-edcc928297f8",
  qrStartSecret: "d28db9a7-4cde-429e-a983-359be676944c",
};

/** A transport that records requests and answers with the given response. */
const stub = (
  respond: (
    request: BankIdTransportRequest,
  ) => BankIdTransportResponse | Promise<BankIdTransportResponse>,
) => {
  const requests: BankIdTransportRequest[] = [];
  const transport: BankIdTransport = async request => {
    requests.push(request);
    return respond(request);
  };
  return { requests, transport };
};

const json = (status: number, body: unknown): BankIdTransportResponse => ({
  status,
  body: JSON.stringify(body),
});

const clientWith = (
  respond: Parameters<typeof stub>[0],
  timeoutMs?: number,
) => {
  const { requests, transport } = stub(respond);
  const bankid = createBankIdClient({
    environment: "test",
    transport,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { bankid, requests };
};

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

describe("createBankIdClient", () => {
  const { transport } = stub(() => json(200, order));
  const pem = { cert: "-----BEGIN CERTIFICATE-----", key: "k" };

  it("requires an environment", () => {
    // @ts-expect-error environment is required
    expect(() => createBankIdClient({ transport })).toThrow(
      'environment must be "production" or "test"',
    );
    expect(() =>
      // @ts-expect-error only two environments exist
      createBankIdClient({ environment: "staging", transport }),
    ).toThrow(TypeError);
  });

  it("requires credentials unless a transport is given", () => {
    // @ts-expect-error credentials are required without a transport
    expect(() => createBankIdClient({ environment: "test" })).toThrow(
      "credentials must be",
    );
    expect(() =>
      // @ts-expect-error a pfx needs its passphrase
      createBankIdClient({ environment: "test", credentials: { pfx: "AA==" } }),
    ).toThrow("credentials must be");
    expect(() =>
      // @ts-expect-error a certificate needs its key
      createBankIdClient({ environment: "test", credentials: { cert: "c" } }),
    ).toThrow("credentials must be");
    expect(() =>
      createBankIdClient({
        environment: "test",
        // @ts-expect-error pfx and PEM cannot be mixed
        credentials: { pfx: "AA==", passphrase: "p", cert: "c", key: "k" },
      }),
    ).toThrow("credentials must be");
  });

  it("rejects credentials or ca together with a custom transport", () => {
    expect(() =>
      // @ts-expect-error credentials are not used with a transport
      createBankIdClient({ environment: "test", transport, credentials: pem }),
    ).toThrow("not used with a custom transport");
  });

  it("rejects a timeout that is not a whole number from 1 to 2147483647", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Infinity, 1.5, 2_147_483_648]) {
      expect(() =>
        createBankIdClient({ environment: "test", transport, timeoutMs }),
      ).toThrow(
        "createBankIdClient: timeoutMs must be a whole number from 1 to 2147483647",
      );
    }
    for (const timeoutMs of [1, 2_147_483_647])
      expect(() =>
        createBankIdClient({ environment: "test", transport, timeoutMs }),
      ).not.toThrow();
  });

  it("accepts each documented options shape", () => {
    expectTypeOf<{
      environment: "production";
      credentials: { pfx: Uint8Array; passphrase: string };
    }>().toExtend<BankIdClientOptions>();
    expectTypeOf<{
      environment: "test";
      credentials: { cert: string; key: Uint8Array; passphrase?: string };
      ca: string;
      timeoutMs: number;
    }>().toExtend<BankIdClientOptions>();
    expectTypeOf<{
      environment: "test";
      transport: BankIdTransport;
    }>().toExtend<BankIdClientOptions>();
  });
});

describe("auth and sign", () => {
  it("posts auth to /auth with text fields base64-encoded", async () => {
    const { bankid, requests } = clientWith(() => json(200, order));
    const result = await bankid.auth({
      endUserIp: "192.0.2.10",
      userVisibleData: "Hej Åsa! ✓",
      userNonVisibleData: "id=ö",
      requirement: { personalNumber: "190010101010" },
    });
    expect(result).toEqual(order);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/auth",
      body: {
        endUserIp: "192.0.2.10",
        userVisibleData: "SGVqIMOFc2EhIOKckw==",
        userNonVisibleData: "aWQ9w7Y=",
        requirement: { personalNumber: "190010101010" },
      },
    });
  });

  it.each([
    ["userVisibleData", { userVisibleData: 190010101010 }],
    ["userNonVisibleData", { userNonVisibleData: { id: "190010101010" } }],
  ])(
    "refuses a %s that is not a string, naming only the field",
    async (field, text) => {
      const { bankid, requests } = clientWith(() => json(200, order));
      const calls = [
        () => bankid.auth({ endUserIp: "192.0.2.10", ...(text as object) }),
        () =>
          bankid.sign({
            endUserIp: "192.0.2.10",
            userVisibleData: "x",
            ...(text as object),
          }),
        () =>
          bankid.phone.auth({
            callInitiator: "RP",
            personalNumber: "192110101414",
            ...(text as object),
          }),
      ];
      for (const call of calls) {
        const error = await rejection(call());
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toMatch(
          new RegExp(`^[a-z.]+: ${field} must be a string$`),
        );
        expect(inspect(error, { depth: Infinity })).not.toContain(
          "190010101010",
        );
      }
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    ["auth without endUserIp", "auth", "endUserIp is required", {}],
    [
      "auth with an endUserIp that is not an IP address",
      "auth",
      "endUserIp must be an IPv4 or IPv6 address",
      { endUserIp: "200001012384" },
    ],
    [
      "sign without endUserIp",
      "sign",
      "endUserIp is required",
      { userVisibleData: "Avtal" },
    ],
    [
      "sign without userVisibleData",
      "sign",
      "userVisibleData is required",
      { endUserIp: "192.0.2.10" },
    ],
    [
      "sign with empty userVisibleData",
      "sign",
      "userVisibleData must not be empty",
      { endUserIp: "192.0.2.10", userVisibleData: "" },
    ],
  ] as const)(
    "refuses %s before sending, naming only the field",
    async (_, method, rule, request) => {
      const { bankid, requests } = clientWith(() => json(200, order));
      const error = await rejection(
        (bankid[method] as (request: unknown) => Promise<unknown>)(request),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`${method}: ${rule}`);
      expect(requests).toHaveLength(0);
    },
  );

  it("refuses a request that is not an object", async () => {
    const { bankid, requests } = clientWith(() => json(200, order));
    for (const method of ["auth", "sign"] as const) {
      const error = await rejection(
        (bankid[method] as (request: unknown) => Promise<unknown>)(undefined),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`${method} needs a request object`);
    }
    expect(requests).toHaveLength(0);
  });

  it("accepts an IPv6 endUserIp", async () => {
    const { bankid, requests } = clientWith(() => json(200, order));
    await bankid.auth({ endUserIp: "2001:db8::1" });
    expect(requests).toHaveLength(1);
  });

  it("leaves the caller's request object unchanged", async () => {
    const { bankid } = clientWith(() => json(200, order));
    const request = { endUserIp: "192.0.2.10", userVisibleData: "text" };
    await bankid.sign(request);
    expect(request.userVisibleData).toBe("text");
  });

  it("posts sign to /sign", async () => {
    const { bankid, requests } = clientWith(() => json(200, order));
    await bankid.sign({ endUserIp: "192.0.2.10", userVisibleData: "Avtal" });
    expect(requests[0]).toMatchObject({
      path: "/sign",
      body: { endUserIp: "192.0.2.10", userVisibleData: "QXZ0YWw=" },
    });
  });

  it("keeps response fields it does not know", async () => {
    const { bankid } = clientWith(() =>
      json(200, { ...order, addedLater: { nested: true } }),
    );
    const result = await bankid.auth({ endUserIp: "192.0.2.10" });
    expect(result).toEqual({ ...order, addedLater: { nested: true } });
  });

  it("accepts an already parsed response body", async () => {
    const { bankid } = clientWith(() => ({ status: 200, body: order }));
    await expect(bankid.auth({ endUserIp: "192.0.2.10" })).resolves.toEqual(
      order,
    );
  });
});

describe("phone auth and sign", () => {
  const personalNumber = "190010101010";
  const phoneOrder = { orderRef };

  it.each(["user", "RP"] as const)(
    "posts phone auth to /phone/auth with callInitiator %s",
    async callInitiator => {
      const { bankid, requests } = clientWith(() => json(200, phoneOrder));
      const result = await bankid.phone.auth({
        callInitiator,
        personalNumber,
        userVisibleData: "Hej Åsa! ✓",
        userNonVisibleData: "id=ö",
        userVisibleDataFormat: "simpleMarkdownV1",
        requirement: { stepUp: ["mrtd", "face"], pinCode: true },
      });
      expect(result).toEqual(phoneOrder);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.path).toBe("/phone/auth");
      expect(requests[0]?.body).toStrictEqual({
        callInitiator,
        personalNumber,
        userVisibleData: "SGVqIMOFc2EhIOKckw==",
        userNonVisibleData: "aWQ9w7Y=",
        userVisibleDataFormat: "simpleMarkdownV1",
        requirement: { stepUp: ["mrtd", "face"], pinCode: true },
      });
    },
  );

  it.each(["user", "RP"] as const)(
    "posts phone sign to /phone/sign with callInitiator %s",
    async callInitiator => {
      const { bankid, requests } = clientWith(() => json(200, phoneOrder));
      const result = await bankid.phone.sign({
        callInitiator,
        personalNumber,
        userVisibleData: "Avtal",
        requirement: { mrtd: true },
      });
      expect(result).toEqual(phoneOrder);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.path).toBe("/phone/sign");
      expect(requests[0]?.body).toStrictEqual({
        callInitiator,
        personalNumber,
        userVisibleData: "QXZ0YWw=",
        requirement: { mrtd: true },
      });
    },
  );

  const caller = { callInitiator: "RP", personalNumber };
  it.each([
    ["auth", "callInitiator is required", { personalNumber }],
    [
      "auth",
      'callInitiator must be "user" or "RP"',
      { personalNumber, callInitiator: "bank" },
    ],
    ["auth", "personalNumber is required", { callInitiator: "RP" }],
    [
      "auth",
      "personalNumber must be 12 digits",
      { callInitiator: "RP", personalNumber: "2000010123845" },
    ],
    [
      "auth",
      "personalNumber must be 12 digits",
      { callInitiator: "RP", personalNumber: 200001012384 },
    ],
    [
      "sign",
      "callInitiator is required",
      { personalNumber, userVisibleData: "Avtal" },
    ],
    [
      "sign",
      "personalNumber must be 12 digits",
      {
        callInitiator: "user",
        personalNumber: "20000101238",
        userVisibleData: "Avtal",
      },
    ],
    ["sign", "userVisibleData is required", caller],
    [
      "sign",
      "userVisibleData must not be empty",
      { ...caller, userVisibleData: "" },
    ],
  ] as const)(
    "refuses phone.%s with %s before sending, naming only the field",
    async (method, rule, request) => {
      const { bankid, requests } = clientWith(() => json(200, phoneOrder));
      const error = await rejection(
        (bankid.phone[method] as (request: unknown) => Promise<unknown>)(
          request,
        ),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`phone.${method}: ${rule}`);
      // The message and any other own fields, without the stack's file paths.
      const text = JSON.stringify(
        Object.getOwnPropertyNames(error).map(key =>
          key === "stack" ? "" : (error as Record<string, unknown>)[key],
        ),
      );
      for (const value of [
        "bank",
        "2000010123845",
        "20000101238",
        personalNumber,
      ])
        expect(text).not.toContain(value);
      expect(requests).toHaveLength(0);
    },
  );

  it("sends only the fields given", async () => {
    const { bankid, requests } = clientWith(() => json(200, phoneOrder));
    await bankid.phone.auth({ callInitiator: "RP", personalNumber });
    expect(requests[0]?.body).toStrictEqual({
      callInitiator: "RP",
      personalNumber,
    });
  });

  it("turns an error response into a BankIdApiError with the phone path", async () => {
    const { bankid } = clientWith(() =>
      json(400, { errorCode: "alreadyInProgress", details: "" }),
    );
    const error = await rejection(
      bankid.phone.sign({
        callInitiator: "user",
        personalNumber,
        userVisibleData: "x",
      }),
    );
    expect(error).toBeInstanceOf(BankIdApiError);
    expect(error).toMatchObject({
      errorCode: "alreadyInProgress",
      path: "/phone/sign",
    });
  });

  it("has types that accept only what the phone endpoints take", () => {
    expectTypeOf<PhoneOrderResponse>().toEqualTypeOf<{ orderRef: string }>();
    expectTypeOf<CallInitiator>().toEqualTypeOf<"user" | "RP">();
    expectTypeOf<PhoneAuthRequest["callInitiator"]>().toEqualTypeOf<
      "user" | "RP"
    >();
    const { bankid } = clientWith(() => json(200, phoneOrder));
    const base = { callInitiator: "user", personalNumber } as const;
    // Each call below is a type error; they are never awaited or sent.
    const calls = () => [
      // @ts-expect-error endUserIp is not accepted
      bankid.phone.auth({ ...base, endUserIp: "192.0.2.10" }),
      // @ts-expect-error returnUrl is not accepted
      bankid.phone.auth({ ...base, returnUrl: "https://example.com/" }),
      // @ts-expect-error returnRisk is not accepted
      bankid.phone.auth({ ...base, returnRisk: true }),
      // @ts-expect-error app is not accepted
      bankid.phone.auth({ ...base, app: { appIdentifier: "x" } }),
      // @ts-expect-error web is not accepted
      bankid.phone.sign({ ...base, userVisibleData: "x", web: {} }),
      // @ts-expect-error the personal number is not a requirement
      bankid.phone.auth({ ...base, requirement: { personalNumber } }),
      // @ts-expect-error callInitiator is required
      bankid.phone.auth({ personalNumber }),
      // @ts-expect-error personalNumber is required
      bankid.phone.auth({ callInitiator: "RP" }),
      // @ts-expect-error callInitiator is "user" or "RP"
      bankid.phone.auth({ callInitiator: "bank", personalNumber }),
      // @ts-expect-error userVisibleData is required on sign
      bankid.phone.sign(base),
    ];
    expect(calls).toBeTypeOf("function");
  });

  it("gives a phone order no QR code or autostart token, as a type error", async () => {
    const { bankid } = clientWith(() => json(200, phoneOrder));
    const started = await bankid.phone.auth({
      callInitiator: "user",
      personalNumber,
    });
    // @ts-expect-error a phone order has no QR start token or secret
    expect(() => qrCode(started, { startedAt: 0 })).toThrow();
    // @ts-expect-error a phone order has no autostart token
    expect(() => startUrl({ ...started, device: "phone" })).toThrow(TypeError);
  });
});

describe("collect and cancel", () => {
  it("posts the order reference to /collect", async () => {
    const { bankid, requests } = clientWith(() =>
      json(200, {
        orderRef,
        status: "pending",
        hintCode: "outstandingTransaction",
      }),
    );
    await bankid.collect(orderRef);
    expect(requests[0]).toMatchObject({ path: "/collect", body: { orderRef } });
  });

  it("returns a union discriminated on status", async () => {
    const completionData = {
      user: {
        personalNumber: "200001012384",
        name: "Alex Johnson",
        givenName: "Alex",
        surname: "Johnson",
      },
      device: { ipAddress: "192.168.1.1", uhi: "OZvYM9VvyiAmG7NA5jU5zqGcVpo=" },
      bankIdIssueDate: "2023-04-01Z",
      signature: "PHNpZ25hdHVyZT4=",
      ocspResponse: "b2NzcA==",
      risk: "low",
    };
    const { bankid } = clientWith(() =>
      json(200, { orderRef, status: "complete", completionData }),
    );
    const result = await bankid.collect(orderRef);
    expect(result).toEqual({ orderRef, status: "complete", completionData });
    if (result.status === "complete") {
      expectTypeOf(result.completionData.user?.personalNumber).toEqualTypeOf<
        string | undefined
      >();
    } else {
      // The spec requires only orderRef and status.
      expectTypeOf(result.hintCode).toEqualTypeOf<
        PendingHintCode | FailedHintCode | undefined
      >();
    }
    expectTypeOf<CollectResponse["status"]>().toEqualTypeOf<
      "pending" | "complete" | "failed"
    >();
  });

  it("passes an unknown hint code through", async () => {
    const { bankid } = clientWith(() =>
      json(200, { orderRef, status: "pending", hintCode: "userSomethingNew" }),
    );
    await expect(bankid.collect(orderRef)).resolves.toEqual({
      orderRef,
      status: "pending",
      hintCode: "userSomethingNew",
    });
    expectTypeOf<"userSomethingNew">().toExtend<PendingHintCode>();
  });

  it("returns a failed order with its hint code", async () => {
    const { bankid } = clientWith(() =>
      json(200, { orderRef, status: "failed", hintCode: "userCancel" }),
    );
    await expect(bankid.collect(orderRef)).resolves.toMatchObject({
      status: "failed",
      hintCode: "userCancel",
    });
  });

  it("keeps collect response fields it does not know", async () => {
    const { bankid } = clientWith(() =>
      json(200, {
        orderRef,
        status: "pending",
        hintCode: "userSign",
        newField: 1,
      }),
    );
    await expect(bankid.collect(orderRef)).resolves.toHaveProperty(
      "newField",
      1,
    );
  });

  it("refuses a result for another order than the one asked for", async () => {
    for (const body of [
      { orderRef: "another-order", status: "pending", hintCode: "userSign" },
      {
        orderRef: "another-order",
        status: "complete",
        completionData: { user: { personalNumber: "200001012384" } },
      },
      { orderRef: `${orderRef} `, status: "failed", hintCode: "userCancel" },
    ]) {
      const { bankid } = clientWith(() => json(200, body));
      const error = await rejection(bankid.collect(orderRef));
      expect(error).toBeInstanceOf(BankIdTransportError);
      expect(error).toMatchObject({
        reason: "invalidResponse",
        path: "/collect",
        status: 200,
      });
    }
  });

  it("checks the orderRef asked for, even when the transport changes the request", async () => {
    const bankid = createBankIdClient({
      environment: "test",
      transport: async request => {
        const body = request.body as { orderRef: string };
        body.orderRef = "another-order";
        return json(200, {
          orderRef: "another-order",
          status: "complete",
          completionData: { user: { personalNumber: "200001012384" } },
        });
      },
    });
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "invalidResponse", status: 200 });
  });

  it("types risk as the known levels or any other string", () => {
    expectTypeOf<CompletionData["risk"]>().toEqualTypeOf<
      RiskLevel | undefined
    >();
    expectTypeOf<KnownRiskLevel>().toEqualTypeOf<"low" | "moderate" | "high">();
    expectTypeOf<"somethingNew">().toExtend<RiskLevel>();
  });

  it("posts the order reference to /cancel and resolves to nothing", async () => {
    const { bankid, requests } = clientWith(() => json(200, {}));
    await expect(bankid.cancel(orderRef)).resolves.toBeUndefined();
    expect(requests[0]).toMatchObject({ path: "/cancel", body: { orderRef } });
  });
});

describe("response validation", () => {
  const invalid = async (
    call: (bankid: ReturnType<typeof clientWith>["bankid"]) => Promise<unknown>,
    body: unknown,
  ) => {
    const { bankid } = clientWith(() => json(200, body));
    const error = await rejection(call(bankid));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "invalidResponse", status: 200 });
  };
  const start = { endUserIp: "192.0.2.10" };
  const phone = {
    callInitiator: "RP",
    personalNumber: "190010101010",
  } as const;

  it.each([
    ["no orderRef", { ...order, orderRef: undefined }],
    ["a number as orderRef", { ...order, orderRef: 1 }],
    ["no autoStartToken", { ...order, autoStartToken: undefined }],
    ["no qrStartToken", { ...order, qrStartToken: undefined }],
    ["no qrStartSecret", { ...order, qrStartSecret: undefined }],
    ["an empty object", {}],
  ])("refuses an order response with %s", async (_, body) => {
    await invalid(bankid => bankid.auth(start), body);
    await invalid(
      bankid => bankid.sign({ ...start, userVisibleData: "x" }),
      body,
    );
  });

  it("refuses a phone order response without an orderRef", async () => {
    await invalid(bankid => bankid.phone.auth(phone), {});
    await invalid(bankid => bankid.phone.auth(phone), { orderRef: 7 });
  });

  it("accepts a phone order response with only an orderRef", async () => {
    const { bankid } = clientWith(() => json(200, { orderRef }));
    await expect(bankid.phone.auth(phone)).resolves.toEqual({ orderRef });
  });

  it.each([
    ["no orderRef", { status: "pending", hintCode: "userSign" }],
    ["no status", { orderRef, hintCode: "userSign" }],
    ["a number as status", { orderRef, status: 1 }],
    ["an unknown status", { orderRef, status: "paused", hintCode: "x" }],
    [
      "a hint code that is not a string",
      { orderRef, status: "pending", hintCode: 7 },
    ],
    ["an empty hint code", { orderRef, status: "failed", hintCode: "" }],
    [
      "a complete status without completionData",
      { orderRef, status: "complete" },
    ],
    [
      "completionData that is not an object",
      { orderRef, status: "complete", completionData: "x" },
    ],
  ])("refuses a collect response with %s", async (_, body) => {
    await invalid(bankid => bankid.collect(orderRef), body);
  });

  it.each([
    ["signature", { signature: 7 }],
    ["ocspResponse", { ocspResponse: { a: 1 } }],
    ["bankIdIssueDate", { bankIdIssueDate: 20230401 }],
    ["risk", { risk: ["low"] }],
    ["user", { user: "Alex" }],
    ["user.personalNumber", { user: { personalNumber: 200001012384 } }],
    [
      "user.personalNumber as 10 digits",
      { user: { personalNumber: "0001012384" } },
    ],
    [
      "user.personalNumber as 13 digits",
      { user: { personalNumber: "2000010123840" } },
    ],
    [
      "user.personalNumber with a hyphen",
      { user: { personalNumber: "20000101-2384" } },
    ],
    ["user.personalNumber as empty text", { user: { personalNumber: "" } }],
    ["user.name", { user: { name: null } }],
    ["user.givenName", { user: { givenName: 1 } }],
    ["user.surname", { user: { surname: [] } }],
    ["device", { device: [] }],
    ["device.ipAddress", { device: { ipAddress: 1 } }],
    ["device.uhi", { device: { uhi: false } }],
    ["stepUp", { stepUp: true }],
    ["stepUp.mrtd", { stepUp: { mrtd: "true" } }],
    ["stepUp.face", { stepUp: { face: 1 } }],
  ])(
    "refuses completionData whose %s has the wrong type",
    async (_, completionData) => {
      await invalid(bankid => bankid.collect(orderRef), {
        orderRef,
        status: "complete",
        completionData,
      });
    },
  );

  it("accepts completionData with only some known fields and unknown ones", async () => {
    for (const completionData of [
      {},
      { user: {} },
      { signature: "PHNpZ25hdHVyZT4=", brandNew: { x: 1 } },
      {
        user: { personalNumber: "200001012384", extra: 1 },
        device: { uhi: "abc", extra: true },
        stepUp: { mrtd: true, extra: "x" },
        risk: "somethingNew",
      },
    ]) {
      const body = { orderRef, status: "complete", completionData };
      const { bankid } = clientWith(() => json(200, body));
      await expect(bankid.collect(orderRef)).resolves.toEqual(body);
    }
  });

  it("accepts pending and failed results without a hint code, as the spec does", async () => {
    for (const body of [
      { orderRef, status: "pending" },
      { orderRef, status: "failed" },
    ]) {
      const { bankid } = clientWith(() => json(200, body));
      await expect(bankid.collect(orderRef)).resolves.toEqual(body);
    }
  });

  it("keeps unknown hint codes and extra fields of pending and failed results", async () => {
    for (const body of [
      { orderRef, status: "pending", hintCode: "brandNew", extra: [1] },
      { orderRef, status: "failed", hintCode: "alsoNew", extra: { a: 1 } },
    ]) {
      const { bankid } = clientWith(() => json(200, body));
      await expect(bankid.collect(orderRef)).resolves.toEqual(body);
    }
  });

  it("does not let watch end silently on a malformed response", async () => {
    const { bankid } = clientWith(() => json(200, { orderRef, status: "odd" }));
    const results: unknown[] = [];
    const error = await (async () => {
      for await (const result of bankid.watch(orderRef)) results.push(result);
    })().catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "invalidResponse" });
    expect(results).toEqual([]);
  });
});

describe("errors from BankID", () => {
  it.each([
    [400, "alreadyInProgress", false],
    [400, "invalidParameters", false],
    [401, "unauthorized", false],
    [403, "unauthorized", false],
    [404, "notFound", false],
    [405, "methodNotAllowed", false],
    [408, "requestTimeout", false],
    [415, "unsupportedMediaType", false],
    [500, "internalError", false],
    [503, "maintenance", true],
  ] as const)(
    "HTTP %i %s becomes a BankIdApiError, retryable: %s",
    async (status, errorCode, retryable) => {
      const { bankid } = clientWith(() =>
        json(status, { errorCode, details: "Some details" }),
      );
      const error = await rejection(bankid.collect(orderRef));
      expect(error).toBeInstanceOf(BankIdApiError);
      expect(error).toMatchObject({
        name: "BankIdApiError",
        errorCode,
        details: "Some details",
        status,
        path: "/collect",
        retryable,
      });
      expect((error as Error).message).toBe(
        `BankID returned ${errorCode} (HTTP ${status}) for /collect`,
      );
    },
  );

  it("keeps an unknown error code and does not retry it", async () => {
    const { bankid } = clientWith(() =>
      json(400, { errorCode: "somethingNew", details: "" }),
    );
    const error = await rejection(bankid.auth({ endUserIp: "192.0.2.10" }));
    expect(error).toBeInstanceOf(BankIdApiError);
    expect(error).toMatchObject({
      errorCode: "somethingNew",
      retryable: false,
    });
  });

  it.each([
    ["200001012384", "a personal number"],
    ["E200001012384", "an identifier with a personal number in it"],
    ["not a code", "text"],
    ["1abc", "an identifier that starts with a digit"],
    [`E${"x".repeat(64)}`, "an identifier longer than 64 characters"],
    ["ab-c", "a hyphen"],
  ])("replaces the error code %j (%s) with unknown", async errorCode => {
    const { bankid } = clientWith(() => json(400, { errorCode, details: "" }));
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toBeInstanceOf(BankIdApiError);
    expect(error).toMatchObject({ errorCode: "unknown", status: 400 });
    expect((error as Error).message).toBe(
      "BankID returned unknown (HTTP 400) for /collect",
    );
    expect(JSON.stringify(error)).not.toContain(errorCode);
  });

  it("keeps an error code of identifier form, with digits", async () => {
    const errorCode = `E2000${"x".repeat(59)}`;
    const { bankid } = clientWith(() => json(400, { errorCode, details: "" }));
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toMatchObject({ errorCode });
  });

  it.each([
    [401, "", "unauthorized"],
    [405, "", "methodNotAllowed"],
    [503, "Service Unavailable", "maintenance"],
    [500, "<html>Internal error</html>", "internalError"],
    [502, "<html>Bad gateway</html>", "unknown"],
  ])(
    "uses the documented code for HTTP %i when the body has none",
    async (status, body, errorCode) => {
      const { bankid } = clientWith(() => ({ status, body }));
      const error = await rejection(bankid.collect(orderRef));
      expect(error).toBeInstanceOf(BankIdApiError);
      expect(error).toMatchObject({ errorCode, details: "", status });
    },
  );

  it("treats a success response that is not JSON as an invalid response", async () => {
    const { bankid } = clientWith(() => ({
      status: 200,
      body: "<html>proxy login</html>",
    }));
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({
      reason: "invalidResponse",
      status: 200,
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("proxy login");
  });

  it("treats a success response that is not a JSON object as invalid", async () => {
    for (const body of ["[]", "null", '"text"', "42"]) {
      const { bankid } = clientWith(() => ({ status: 200, body }));
      await expect(rejection(bankid.collect(orderRef))).resolves.toMatchObject({
        reason: "invalidResponse",
      });
    }
  });
});

describe("transport failures", () => {
  it("times out a request that takes longer than timeoutMs", async () => {
    let seen: AbortSignal | undefined;
    const { bankid } = clientWith(
      ({ signal }) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      50,
    );
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({
      name: "BankIdTransportError",
      reason: "timeout",
      path: "/collect",
      retryable: false,
    });
    expect(seen?.aborted).toBe(true);
  });

  it("times out even when the transport ignores the signal", async () => {
    const { bankid } = clientWith(() => new Promise(() => {}), 50);
    await expect(rejection(bankid.collect(orderRef))).resolves.toMatchObject({
      reason: "timeout",
    });
  });

  it("aborts when the caller's signal fires", async () => {
    const { bankid } = clientWith(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = rejection(
      bankid.collect(orderRef, { signal: controller.signal }),
    );
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "aborted" });
    // DOMException's numeric code is not an identifier, so it is dropped.
    expect((error as Error).cause).toEqual({ name: "AbortError" });
  });

  it("keeps only a sanitised summary of the caller's abort reason", async () => {
    const { bankid } = clientWith(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = rejection(
      bankid.collect(orderRef, { signal: controller.signal }),
    );
    const reason = Object.assign(new Error("user 190010101010 went away"), {
      code: "E_USER_LEFT",
      session: { personalNumber: "190010101010" },
    });
    controller.abort(reason);
    const error = await pending;
    expect((error as Error).cause).toEqual({
      name: "Error",
      code: "E_USER_LEFT",
    });
    expect(inspect(error, { depth: Infinity })).not.toContain("190010101010");
  });

  it("does not call the transport when the signal has already fired", async () => {
    const { bankid, requests } = clientWith(() => json(200, order));
    const error = await rejection(
      bankid.auth({ endUserIp: "192.0.2.10" }, { signal: AbortSignal.abort() }),
    );
    expect(error).toMatchObject({ reason: "aborted" });
    expect(requests).toHaveLength(0);
  });

  it("wraps a transport that throws, keeping only allowlisted fields", async () => {
    const thrown = Object.assign(new Error("request for 190010101010 failed"), {
      code: "ECONNRESET",
      errno: -54,
      syscall: "read",
      hostname: "proxy.example.com",
      address: "192.0.2.1",
      port: 443,
      config: { data: { personalNumber: "190010101010" } },
    });
    const { bankid } = clientWith(() => {
      throw thrown;
    });
    const error = await rejection(bankid.cancel(orderRef));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "network", path: "/cancel" });
    expect((error as Error).cause).toEqual({
      name: "Error",
      code: "ECONNRESET",
      errno: -54,
      syscall: "read",
      hostname: "proxy.example.com",
      address: "192.0.2.1",
      port: 443,
    });
  });

  it("keeps no cause for a thrown value that is not an object", async () => {
    const { bankid } = clientWith(() => {
      throw "personal number 190010101010";
    });
    const error = await rejection(bankid.cancel(orderRef));
    expect(error).toMatchObject({ reason: "network" });
    expect((error as Error).cause).toBeUndefined();
  });

  it("drops fields that are too long or not primitives", async () => {
    const { bankid } = clientWith(() => {
      throw {
        name: "x".repeat(10_000),
        code: { nested: true },
        port: NaN,
        syscall: "read",
      };
    });
    const error = await rejection(bankid.cancel(orderRef));
    expect((error as Error).cause).toEqual({ syscall: "read" });
  });

  it("keeps only the name of a BankIdTransportError a transport throws", async () => {
    const { bankid } = clientWith(() => {
      throw new BankIdTransportError({
        reason: "timeout",
        path: "/collect",
        cause: new Error("personal number 190010101010"),
      });
    });
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toMatchObject({ reason: "network" });
    expect((error as Error).cause).toEqual({ name: "BankIdTransportError" });
  });
});

describe("error boundary", () => {
  const secret = "200001012384";
  const texts = (error: unknown): string[] => {
    const out = [
      JSON.stringify(error),
      String(error),
      inspect(error, { depth: Infinity, showHidden: true }),
    ];
    for (let e: unknown = error; e instanceof Error; e = e.cause)
      out.push(e.message, e.stack ?? "", JSON.stringify(e));
    return out;
  };
  const expectClean = (error: unknown) => {
    for (const text of texts(error)) expect(text).not.toContain(secret);
  };
  const leakyApiError = () =>
    Object.assign(
      new BankIdApiError({
        errorCode: "maintenance",
        details: `for ${secret}`,
        status: 503,
        path: "/collect",
      }),
      {
        extra: secret,
        toJSON: () => ({ secret }),
      },
    );
  const leakyTransportError = () => {
    const error = new BankIdTransportError({
      reason: "network",
      path: "/collect",
    });
    Object.defineProperty(error, "cause", { value: { message: secret } });
    Object.defineProperty(error, "stack", { value: secret });
    return Object.assign(error, { toJSON: () => ({ secret }) });
  };

  it.each([
    ["a BankIdApiError", leakyApiError],
    ["a BankIdTransportError", leakyTransportError],
  ])("never rethrows %s that a custom transport throws", async (_, make) => {
    const thrown = make();
    const { bankid } = clientWith(() => {
      throw thrown;
    });
    const error = await rejection(bankid.collect(orderRef));
    expect(error).not.toBe(thrown);
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "network", path: "/collect" });
    expect(Object.keys(error as object).sort()).toEqual(
      ["name", "path", "reason", "status"].sort(),
    );
    expectClean(error);
  });

  it.each([
    ["a BankIdApiError", leakyApiError],
    ["a BankIdTransportError", leakyTransportError],
  ])("never rethrows %s given as the abort reason", async (_, make) => {
    const { bankid } = clientWith(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = make();
    const pending = rejection(
      bankid.collect(orderRef, { signal: controller.signal }),
    );
    controller.abort(reason);
    const error = await pending;
    expect(error).not.toBe(reason);
    expect(error).toMatchObject({ reason: "aborted", path: "/collect" });
    expectClean(error);
    const early = await rejection(
      bankid.collect(orderRef, { signal: AbortSignal.abort(make()) }),
    );
    expect(early).toMatchObject({ reason: "aborted" });
    expectClean(early);
  });

  it("does not retry in watch on a maintenance error a transport throws", async () => {
    let calls = 0;
    const { bankid } = clientWith(() => {
      calls += 1;
      throw leakyApiError();
    });
    const error = await (async () => {
      for await (const _ of bankid.watch(orderRef, { intervalMs: 1 }));
    })().catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "network" });
    expect(calls).toBe(1);
  });

  it("survives a thrown proxy whose every trap throws", async () => {
    const trap = () => {
      throw new Error(secret);
    };
    const thrown = new Proxy(
      new BankIdTransportError({ reason: "network", path: "/collect" }),
      {
        get: trap,
        has: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      },
    );
    const { bankid } = clientWith(() => {
      throw thrown;
    });
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "network" });
    expect((error as Error).cause).toBeUndefined();
    expectClean(error);
  });

  it("reads each cause field once and keeps a frozen copy", async () => {
    let reads = 0;
    const thrown = {
      get code() {
        reads += 1;
        return reads === 1 ? "ECONNRESET" : secret;
      },
      name: "Error",
      syscall: { toString: () => secret },
      hostname: 42,
      port: "443",
    };
    const { bankid } = clientWith(() => {
      throw thrown;
    });
    const error = await rejection(bankid.collect(orderRef));
    const cause = (error as Error).cause;
    expect(cause).toEqual({ name: "Error", code: "ECONNRESET" });
    expect(Object.isFrozen(cause)).toBe(true);
    thrown.name = secret;
    expect(cause).toEqual({ name: "Error", code: "ECONNRESET" });
    expect(reads).toBe(1);
    expectClean(error);
  });

  it.each([
    ["700", 700],
    ["99", 99],
    ["a fraction", 200.5],
    ["a string", "200"],
    ["NaN", Number.NaN],
    ["missing", undefined],
  ])("refuses a response whose status is %s", async (_, status) => {
    const { bankid } = clientWith(
      () =>
        ({
          status,
          body: JSON.stringify(order),
        }) as unknown as BankIdTransportResponse,
    );
    const error = await rejection(bankid.auth({ endUserIp: "192.0.2.10" }));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect(error).toMatchObject({ reason: "invalidResponse" });
    expect((error as BankIdTransportError).status).toBeUndefined();
  });

  it("refuses a response that is not an object or whose fields throw", async () => {
    for (const response of [
      null,
      "200",
      {
        get status(): number {
          throw new Error(secret);
        },
        body: "{}",
      },
    ]) {
      const { bankid } = clientWith(
        () => response as unknown as BankIdTransportResponse,
      );
      const error = await rejection(bankid.collect(orderRef));
      expect(error).toMatchObject({ reason: "invalidResponse" });
      expectClean(error);
    }
  });

  it("returns a plain copy of a parsed body, read once", async () => {
    let reads = 0;
    const body = {
      ...order,
      get orderRef() {
        reads += 1;
        return reads === 1 ? orderRef : 7;
      },
    };
    const { bankid } = clientWith(() => ({ status: 200, body }));
    const result = await bankid.auth({ endUserIp: "192.0.2.10" });
    expect(result).toEqual(order);
    expect(result).not.toBe(body);
    expect(Object.getOwnPropertyDescriptor(result, "orderRef")).toHaveProperty(
      "value",
      orderRef,
    );
  });

  it("refuses a parsed body whose toJSON throws", async () => {
    const body = {
      toJSON: () => {
        throw new Error(secret);
      },
    };
    const { bankid } = clientWith(() => ({ status: 200, body }));
    const error = await rejection(bankid.collect(orderRef));
    expect(error).toMatchObject({ reason: "invalidResponse" });
    expectClean(error);
  });
});

describe("BankIdTransportError cause", () => {
  it("keeps each field only with its declared type", () => {
    const error = new BankIdTransportError({
      reason: "network",
      path: "/auth",
      cause: {
        name: 5,
        code: "ECONNRESET",
        errno: Number.POSITIVE_INFINITY,
        syscall: 7,
        hostname: ["localhost"],
        address: "192.0.2.1",
        port: 443,
        message: "kept only for the default transport",
      },
    });
    expect(error.cause).toEqual({
      code: "ECONNRESET",
      address: "192.0.2.1",
      port: 443,
    });
  });

  it.each([
    [
      "name",
      ["with space", "200001012384", `E${"x".repeat(64)}`, "E200001012384"],
    ],
    [
      "code",
      [
        "200001012384",
        20,
        "E-DASH",
        { toString: () => "E" },
        "E200001012384",
        "ERR_1900101010_X",
      ],
    ],
    ["errno", ["-54", 10_000, 1.5, -10_000]],
    ["syscall", ["Connect", "200001012384", "x".repeat(33), Symbol("read")]],
    [
      "hostname",
      [
        "200001012384",
        "200001012384.example.com",
        "not a host!",
        "bad-.example.com",
        "x".repeat(254),
        "https://example.com",
      ],
    ],
    [
      "address",
      [
        "200001012384",
        "proxy.example.com",
        "192.0.2.300",
        "192.0.2.1:443",
        "fe80::1%200001012384",
        "fe80::1%eth0",
      ],
    ],
    ["port", ["443", 65_536, -1, 443.5]],
  ] as const)("drops %s values of the wrong form", (field, values) => {
    for (const value of values) {
      const error = new BankIdTransportError({
        reason: "network",
        path: "/auth",
        cause: { [field]: value },
      });
      expect(error.cause).toBeUndefined();
    }
  });

  it("keeps values of the allowed forms", () => {
    const cause = {
      name: "TimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
      errno: -3008,
      syscall: "getaddrinfo",
      hostname: "appapi2.test.bankid.com.",
      address: "2001:db8::1",
      port: 0,
    };
    expect(
      new BankIdTransportError({ reason: "network", path: "/auth", cause })
        .cause,
    ).toEqual(cause);
    for (const hostname of ["localhost", "a-b.example", "xn--bcher-kva.se"])
      expect(
        new BankIdTransportError({
          reason: "network",
          path: "/auth",
          cause: { hostname },
        }).cause,
      ).toEqual({ hostname });
  });

  it("drops a personal number from a custom transport's error and abort reason", async () => {
    const secret = "200001012384";
    const fields = {
      name: secret,
      code: secret,
      errno: secret,
      syscall: secret,
      hostname: secret,
      address: secret,
      port: secret,
    };
    const { bankid } = clientWith(() => {
      throw Object.assign(new Error("x"), fields);
    });
    const thrown = await rejection(bankid.cancel(orderRef));
    expect((thrown as Error).cause).toBeUndefined();
    const aborted = await rejection(
      bankid.cancel(orderRef, { signal: AbortSignal.abort(fields) }),
    );
    expect(aborted).toMatchObject({ reason: "aborted" });
    expect((aborted as Error).cause).toBeUndefined();
  });

  it("copies a cause it made before into a fresh frozen object", () => {
    const first = new BankIdTransportError({
      reason: "network",
      path: "/auth",
      cause: { code: "ECONNRESET" },
    });
    const second = new BankIdTransportError({
      reason: "network",
      path: "/auth",
      cause: first.cause,
    });
    expect(second.cause).toEqual(first.cause);
    expect(second.cause).not.toBe(first.cause);
    expect(Object.isFrozen(first.cause)).toBe(true);
    expect(Object.isFrozen(second.cause)).toBe(true);
  });
});

describe("BankIdApiError", () => {
  it("coerces errorCode and details to strings and caps their length", () => {
    const error = new BankIdApiError({
      errorCode: "e".repeat(1000),
      details: 42 as unknown as string,
      status: 400,
      path: "/auth",
    });
    expect(error.details).toBe("42");
    expect(error.errorCode.length).toBeLessThanOrEqual(100);
    const long = new BankIdApiError({
      errorCode: "invalidParameters",
      details: "d".repeat(100_000),
      status: 400,
      path: "/auth",
    });
    expect(long.details.length).toBeLessThanOrEqual(1000);
  });

  it("leaves details out of toJSON", () => {
    const error = new BankIdApiError({
      errorCode: "invalidParameters",
      details: "Incorrect userVisibleData",
      status: 400,
      path: "/sign",
    });
    expect(error.details).toBe("Incorrect userVisibleData");
    expect(error.toJSON()).not.toHaveProperty("details");
    expect(JSON.stringify(error)).not.toContain("userVisibleData");
  });

  it.each([
    ["a personal number", "for 200001012384 again", "for [redacted] again"],
    ["ten digits", "ref 0011223344", "ref [redacted]"],
    ["two runs", "200001012384/190010101010", "[redacted]/[redacted]"],
    ["a long run", "1".repeat(50), "[redacted]"],
    ["nine digits", "code 123456789", "code 123456789"],
    ["a hyphenated number", "20000101-2384", "20000101-2384"],
  ])("redacts runs of 10 or more digits in details: %s", (_, details, kept) => {
    const error = new BankIdApiError({
      errorCode: "invalidParameters",
      details,
      status: 400,
      path: "/auth",
    });
    expect(error.details).toBe(kept);
  });

  it("redacts before capping, so a cut leaves no part of a digit run", () => {
    const error = new BankIdApiError({
      errorCode: "invalidParameters",
      details: `${"x".repeat(995)}200001012384`,
      status: 400,
      path: "/auth",
    });
    expect(error.details).toBe(`${"x".repeat(995)}[reda`);
  });

  it("redacts details from a response", async () => {
    const { bankid } = clientWith(() =>
      json(400, {
        errorCode: "invalidParameters",
        details: "Incorrect personalNumber 200001012384",
      }),
    );
    const error = (await rejection(bankid.collect(orderRef))) as BankIdApiError;
    expect(error.details).toBe("Incorrect personalNumber [redacted]");
  });

  it("caps BankID's details from a response", async () => {
    const { bankid } = clientWith(() =>
      json(400, { errorCode: "invalidParameters", details: "x".repeat(5000) }),
    );
    const error = (await rejection(bankid.collect(orderRef))) as BankIdApiError;
    expect(error.details.length).toBeLessThanOrEqual(1000);
  });
});

describe("error serialisation", () => {
  const personalNumber = "190010101010";
  const visibleData = "Överföring till Åsa Ödmark";
  const nonVisibleData = "internal-reference-7781";
  const secrets = [
    personalNumber,
    visibleData,
    Buffer.from(visibleData).toString("base64"),
    nonVisibleData,
    Buffer.from(nonVisibleData).toString("base64"),
  ];

  const scenarios: [string, Parameters<typeof stub>[0], number?][] = [
    [
      "an API error",
      () =>
        json(400, {
          errorCode: "alreadyInProgress",
          details: "Order already in progress",
        }),
    ],
    ["an API error without a body", () => ({ status: 503, body: "" })],
    [
      "an unknown error code",
      () => json(400, { errorCode: "newCode", details: "" }),
    ],
    ["an invalid response", () => ({ status: 200, body: "not json" })],
    [
      "a throwing transport",
      () => {
        throw new Error("socket hang up");
      },
    ],
    ["a timeout", () => new Promise(() => {}), 20],
  ];

  const serialisations = (error: unknown): string[] => {
    const out = [
      JSON.stringify(error),
      String(error),
      inspect(error, { depth: Infinity, showHidden: true }),
    ];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      out.push(e.message, e.stack ?? "", JSON.stringify(e));
    }
    return out;
  };

  it.each(scenarios)(
    "never includes request data for %s",
    async (_, respond, timeoutMs) => {
      const { bankid } = clientWith(respond, timeoutMs);
      const errors = [
        await rejection(
          bankid.auth({
            endUserIp: "192.0.2.10",
            userVisibleData: visibleData,
            userNonVisibleData: nonVisibleData,
            requirement: { personalNumber },
          }),
        ),
        await rejection(
          bankid.sign({
            endUserIp: "192.0.2.10",
            userVisibleData: visibleData,
            userNonVisibleData: nonVisibleData,
            requirement: { personalNumber },
          }),
        ),
      ];
      for (const error of errors) {
        expect(error).toBeInstanceOf(Error);
        for (const text of serialisations(error)) {
          for (const secret of secrets) expect(text).not.toContain(secret);
        }
      }
    },
  );

  it("never includes the passphrase when credentials are rejected", () => {
    const passphrase = "correct-horse-battery-staple";
    let error: unknown;
    try {
      createBankIdClient({
        environment: "test",
        credentials: { pfx: new Uint8Array([48, 1, 2, 3]), passphrase },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    for (const text of serialisations(error)) {
      expect(text).not.toContain(passphrase);
    }
  });
});
