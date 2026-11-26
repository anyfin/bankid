import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BankIdApiError,
  BankIdTransportError,
  createBankIdClient,
  qrCode,
  type BankIdTransportRequest,
  type CollectResponse,
} from "../src/index.ts";
import {
  createFakeBankId,
  createMemoryStore,
  fakeMarker,
  type FakeBankIdOptions,
  type FakeBankIdStore,
} from "../src/testing/index.ts";

const personalNumber = "190010101010";
const endUserIp = "192.0.2.10";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A store that exists only in tests: it keeps every value as JSON text, checks
 * that the value survives the round trip, and answers asynchronously.
 */
const createJsonStore = (): FakeBankIdStore & { raw: Map<string, string> } => {
  const raw = new Map<string, string>();
  return {
    raw,
    get: async key => {
      await Promise.resolve();
      const text = raw.get(key);
      return text === undefined ? undefined : JSON.parse(text);
    },
    set: async (key, value) => {
      await Promise.resolve();
      const text = JSON.stringify(value);
      expect(JSON.parse(text)).toStrictEqual(value);
      raw.set(key, text);
    },
    delete: async key => {
      await Promise.resolve();
      raw.delete(key);
    },
  };
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

const apiError = async (promise: Promise<unknown>) => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(BankIdApiError);
  const { errorCode, details, status } = error as BankIdApiError;
  return { errorCode, details, status };
};

const noSuchOrder = {
  errorCode: "invalidParameters",
  details: "No such order",
  status: 400,
};

const decode = (text: string | undefined) =>
  Buffer.from(text ?? "", "base64").toString("utf8");

describe.each([
  ["the in-memory store", createMemoryStore],
  ["a JSON store", createJsonStore],
])("fake BankID with %s", (_, createStore) => {
  const setup = (options: Omit<FakeBankIdOptions, "store" | "now"> = {}) => {
    const clock = { time: 1_750_000_000_000 };
    const store = createStore();
    const fake = createFakeBankId({
      ...options,
      store,
      now: () => clock.time,
    });
    const client = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const raw = (path: string, body: unknown) =>
      fake.transport({
        method: "POST",
        path,
        body,
        signal: new AbortController().signal,
      } as BankIdTransportRequest);
    return { clock, store, fake, client, raw };
  };

  describe("auth and sign", () => {
    it("return an order reference, autostart token and QR start token and secret", async () => {
      const { client } = setup();
      for (const order of [
        await client.auth({ endUserIp }),
        await client.sign({ endUserIp, userVisibleData: "Sign this" }),
      ]) {
        expect(Object.keys(order).sort()).toEqual([
          "autoStartToken",
          "orderRef",
          "qrStartSecret",
          "qrStartToken",
        ]);
        for (const value of Object.values(order)) expect(value).toMatch(uuid);
        expect(await client.collect(order.orderRef)).toEqual({
          orderRef: order.orderRef,
          status: "pending",
          hintCode: "outstandingTransaction",
        });
      }
    });

    it.each([
      ["/auth", {}, "Incorrect endUserIp"],
      ["/auth", { endUserIp: "" }, "Incorrect endUserIp"],
      ["/auth", { endUserIp: "not an ip" }, "Incorrect endUserIp"],
      ["/auth", { endUserIp: 1 }, "Incorrect endUserIp"],
      [
        "/auth",
        { endUserIp, userVisibleData: "not base64!" },
        "Incorrect userVisibleData",
      ],
      [
        "/auth",
        { endUserIp, userVisibleData: "" },
        "Incorrect userVisibleData",
      ],
      [
        "/auth",
        { endUserIp, userVisibleData: "QQ==".repeat(376) },
        "Incorrect userVisibleData",
      ],
      [
        "/auth",
        { endUserIp, userNonVisibleData: 1 },
        "Incorrect userNonVisibleData",
      ],
      [
        "/auth",
        { endUserIp, userVisibleDataFormat: "html" },
        "Incorrect userVisibleDataFormat",
      ],
      ["/auth", { endUserIp, returnUrl: "" }, "Incorrect returnUrl"],
      [
        "/auth",
        { endUserIp, returnUrl: "x".repeat(513) },
        "Incorrect returnUrl",
      ],
      ["/auth", { endUserIp, returnRisk: "yes" }, "Incorrect returnRisk"],
      ["/auth", { endUserIp, app: {} }, "Incorrect app"],
      ["/auth", { endUserIp, web: "web" }, "Incorrect web"],
      ["/auth", { endUserIp, web: { other: "x" } }, "Incorrect web"],
      ["/auth", { endUserIp, web: { userAgent: "" } }, "Incorrect userAgent"],
      [
        "/auth",
        { endUserIp, web: { userAgent: "u".repeat(513) } },
        "Incorrect userAgent",
      ],
      [
        "/auth",
        { endUserIp, web: { referringDomain: "ab" } },
        "Incorrect referringDomain",
      ],
      [
        "/auth",
        { endUserIp, web: { referringDomain: "Example.com" } },
        "Incorrect referringDomain",
      ],
      [
        "/auth",
        { endUserIp, web: { deviceIdentifier: "d".repeat(65) } },
        "Incorrect deviceIdentifier",
      ],
      [
        "/auth",
        { endUserIp, app: { appIdentifier: "a" } },
        "Incorrect appIdentifier",
      ],
      ["/auth", { endUserIp, app: { deviceOS: 14 } }, "Incorrect deviceOS"],
      [
        "/auth",
        { endUserIp, app: { deviceModelName: "m".repeat(129) } },
        "Incorrect deviceModelName",
      ],
      [
        "/auth",
        { endUserIp, app: { deviceIdentifier: "" } },
        "Incorrect deviceIdentifier",
      ],
      [
        "/auth",
        { endUserIp, requirement: { cardReader: "class3" } },
        "Incorrect cardReader",
      ],
      [
        "/phone/auth",
        { callInitiator: "RP", personalNumber, requirement: { cardReader: 1 } },
        "Incorrect cardReader",
      ],
      [
        "/auth",
        {
          endUserIp,
          app: { appIdentifier: "a.b" },
          web: { referringDomain: "a.b" },
        },
        "Incorrect app and web",
      ],
      ["/auth", { endUserIp, requirement: [] }, "Incorrect requirement"],
      [
        "/auth",
        { endUserIp, requirement: { personalNumber: "19001010101" } },
        "Incorrect personalNumber",
      ],
      [
        "/auth",
        { endUserIp, requirement: { personalNumber: "19001010101X" } },
        "Incorrect personalNumber",
      ],
      ["/auth", { endUserIp, requirement: { mrtd: "yes" } }, "Incorrect mrtd"],
      [
        "/auth",
        { endUserIp, requirement: { pinCode: 1 } },
        "Incorrect pinCode",
      ],
      [
        "/auth",
        { endUserIp, requirement: { certificatePolicies: [1] } },
        "Incorrect certificatePolicies",
      ],
      [
        "/auth",
        { endUserIp, requirement: { stepUp: ["face"] } },
        "Incorrect stepUp",
      ],
      [
        "/auth",
        { endUserIp, requirement: { stepUp: ["pin"] } },
        "Incorrect stepUp",
      ],
      [
        "/auth",
        { endUserIp, requirement: { stepUp: ["mrtd"], mrtd: true } },
        "Incorrect stepUp",
      ],
      ["/sign", { endUserIp }, "Incorrect userVisibleData"],
      ["/sign", { userVisibleData: "QQ==" }, "Incorrect endUserIp"],
      [
        "/sign",
        { endUserIp, userVisibleData: "QQ==".repeat(10_001) },
        "Incorrect userVisibleData",
      ],
      ["/collect", {}, "Incorrect orderRef"],
      ["/collect", { orderRef: 1 }, "Incorrect orderRef"],
      ["/cancel", { orderRef: "" }, "Incorrect orderRef"],
    ])("%s with %j gets invalidParameters: %s", async (path, body, details) => {
      const { raw } = setup();
      const response = await raw(path, body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body as string)).toEqual({
        errorCode: "invalidParameters",
        details,
      });
    });

    it("counts text lengths in Unicode code points, as the spec does", async () => {
      const { raw } = setup();
      const astral = "\u{1F600}"; // one code point, two UTF-16 code units
      const status = async (body: object) =>
        (await raw("/auth", { endUserIp, ...body })).status;
      expect(await status({ web: { userAgent: astral.repeat(512) } })).toBe(
        200,
      );
      expect(await status({ web: { userAgent: astral.repeat(513) } })).toBe(
        400,
      );
      expect(
        await status({ web: { deviceIdentifier: astral.repeat(64) } }),
      ).toBe(200);
      expect(
        await status({ app: { deviceModelName: astral.repeat(128) } }),
      ).toBe(200);
      expect(await status({ app: { appIdentifier: astral } })).toBe(400);
      expect(await status({ app: { appIdentifier: astral.repeat(2) } })).toBe(
        200,
      );
      expect(
        await status({
          returnUrl: `https://example.com/${astral.repeat(490)}`,
        }),
      ).toBe(200);
    });

    it("accepts every field the spec allows", async () => {
      const { client } = setup();
      await client.auth({
        endUserIp: "2001:db8::1",
        userVisibleData: "Log in to Example",
        userNonVisibleData: "data",
        userVisibleDataFormat: "simpleMarkdownV1",
        returnUrl: "https://example.com/#nonce=1",
        returnRisk: true,
        web: { referringDomain: "example.com" },
        requirement: {
          personalNumber,
          stepUp: ["mrtd", "face"],
          pinCode: true,
          certificatePolicies: ["1.2.3.4.25"],
        },
      });
    });
  });

  describe("phone auth and sign", () => {
    const callInitiator = "user";

    it("return only an order reference", async () => {
      const { client } = setup();
      const auth = await client.phone.auth({ callInitiator, personalNumber });
      const sign = await client.phone.sign({
        callInitiator: "RP",
        personalNumber: "200001012384",
        userVisibleData: "Sign this",
      });
      for (const order of [auth, sign]) {
        expect(Object.keys(order)).toEqual(["orderRef"]);
        expect(order.orderRef).toMatch(uuid);
        expect(await client.collect(order.orderRef)).toEqual({
          orderRef: order.orderRef,
          status: "pending",
          hintCode: "outstandingTransaction",
        });
      }
    });

    const valid = { callInitiator, personalNumber };
    it.each([
      ["/phone/auth", { personalNumber }, "Incorrect callInitiator"],
      [
        "/phone/auth",
        { personalNumber, callInitiator: "bank" },
        "Incorrect callInitiator",
      ],
      ["/phone/auth", { callInitiator }, "Incorrect personalNumber"],
      [
        "/phone/auth",
        { callInitiator, personalNumber: "19001010101" },
        "Incorrect personalNumber",
      ],
      [
        "/phone/auth",
        { callInitiator, personalNumber: 190010101010 },
        "Incorrect personalNumber",
      ],
      [
        "/phone/auth",
        { ...valid, userVisibleData: "not base64!" },
        "Incorrect userVisibleData",
      ],
      [
        "/phone/auth",
        { ...valid, userNonVisibleData: "QQ==".repeat(376) },
        "Incorrect userNonVisibleData",
      ],
      [
        "/phone/auth",
        { ...valid, userVisibleDataFormat: "html" },
        "Incorrect userVisibleDataFormat",
      ],
      [
        "/phone/auth",
        { ...valid, requirement: { personalNumber } },
        "Incorrect personalNumber",
      ],
      [
        "/phone/auth",
        { ...valid, requirement: { stepUp: ["face"] } },
        "Incorrect stepUp",
      ],
      ["/phone/sign", valid, "Incorrect userVisibleData"],
      [
        "/phone/sign",
        { ...valid, userVisibleData: "" },
        "Incorrect userVisibleData",
      ],
      [
        "/phone/sign",
        { ...valid, userVisibleData: "QQ==", requirement: [] },
        "Incorrect requirement",
      ],
    ])("%s %j: %s", async (path, body, details) => {
      const { raw } = setup();
      const response = await raw(path, body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body as string)).toEqual({
        errorCode: "invalidParameters",
        details,
      });
    });

    it("accept every field the spec allows", async () => {
      const { client } = setup();
      await client.phone.auth({
        callInitiator,
        personalNumber,
        userVisibleData: "Log in to Example",
        userNonVisibleData: "data",
        userVisibleDataFormat: "simpleMarkdownV1",
        requirement: {
          stepUp: ["mrtd", "face"],
          pinCode: true,
          certificatePolicies: ["1.2.3.4.25"],
        },
      });
      await client.phone.sign({
        callInitiator: "RP",
        personalNumber: "200001012384",
        userVisibleData: "x".repeat(30_000),
        userNonVisibleData: "data",
        requirement: { mrtd: true },
      });
    });

    it("complete without device.ipAddress, with stepUp when asked for", async () => {
      const { client, fake } = setup();
      const order = await client.phone.sign({
        callInitiator,
        personalNumber,
        userVisibleData: "Avtal",
        requirement: { mrtd: true },
      });
      await fake.complete(order.orderRef, { personalNumber });
      const result = await client.collect(order.orderRef);
      if (result.status !== "complete") throw new Error(result.status);
      expect(result.completionData.device).toEqual({
        uhi: expect.any(String),
      });
      expect(result.completionData.stepUp).toEqual({ mrtd: true });
      expect(result.completionData.user?.personalNumber).toBe(personalNumber);
      expect(decode(result.completionData.signature)).toContain(
        "<userVisibleData>QXZ0YWw=</userVisibleData>",
      );
    });

    it("answer alreadyInProgress for the same personal number and cancel the open order", async () => {
      const { client } = setup();
      const first = await client.phone.auth({ callInitiator, personalNumber });
      expect(
        await apiError(
          client.phone.sign({
            callInitiator: "RP",
            personalNumber,
            userVisibleData: "x",
          }),
        ),
      ).toEqual({
        errorCode: "alreadyInProgress",
        details: expect.any(String),
        status: 400,
      });
      expect(await client.collect(first.orderRef)).toEqual({
        orderRef: first.orderRef,
        status: "failed",
        hintCode: "cancelled",
      });
    });

    it("share the one-order rule with orders that require the personal number", async () => {
      const { client } = setup();
      const web = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      expect(
        (await apiError(client.phone.auth({ callInitiator, personalNumber })))
          .errorCode,
      ).toBe("alreadyInProgress");
      expect((await client.collect(web.orderRef)).status).toBe("failed");
      const phone = await client.phone.auth({ callInitiator, personalNumber });
      expect(
        (
          await apiError(
            client.auth({ endUserIp, requirement: { personalNumber } }),
          )
        ).errorCode,
      ).toBe("alreadyInProgress");
      expect((await client.collect(phone.orderRef)).status).toBe("failed");
    });

    it("step through the call confirmation and end with a declined call", async () => {
      const { client, fake } = setup();
      const order = await client.phone.auth({ callInitiator, personalNumber });
      await fake.setPending(order.orderRef, "userCallConfirm");
      expect(await client.collect(order.orderRef)).toMatchObject({
        status: "pending",
        hintCode: "userCallConfirm",
      });
      await fake.fail(order.orderRef, "userDeclinedCall");
      expect(await client.collect(order.orderRef)).toEqual({
        orderRef: order.orderRef,
        status: "failed",
        hintCode: "userDeclinedCall",
      });
      expect(await apiError(client.collect(order.orderRef))).toEqual(
        noSuchOrder,
      );
    });

    it("refuse the call hint codes for an order not started by phone", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      await expect(
        fake.setPending(order.orderRef, ["userSign", "userCallConfirm"]),
      ).rejects.toThrow("only for phone orders");
      await expect(
        fake.fail(order.orderRef, "userDeclinedCall"),
      ).rejects.toThrow("only for phone orders");
      expect((await client.collect(order.orderRef)).status).toBe("pending");
    });

    it("refuse a QR scan", async () => {
      const { client, fake } = setup();
      const order = await client.phone.auth({ callInitiator, personalNumber });
      await expect(fake.scan(order.orderRef, "bankid.x.0.y")).rejects.toThrow(
        "phone order",
      );
    });

    it("complete by themselves with autoComplete, as the order's personal number", async () => {
      const { client, clock } = setup({
        autoComplete: {
          afterMs: 1000,
          user: { personalNumber: "200001012384" },
        },
      });
      const order = await client.phone.auth({ callInitiator, personalNumber });
      expect((await client.collect(order.orderRef)).status).toBe("pending");
      clock.time += 1000;
      const result = await client.collect(order.orderRef);
      if (result.status !== "complete") throw new Error(result.status);
      expect(result.completionData.user?.personalNumber).toBe(personalNumber);
    });

    it("fail with startFailed when nobody picks them up within 30 seconds", async () => {
      const { client, clock } = setup();
      const order = await client.phone.auth({ callInitiator, personalNumber });
      clock.time += 30_000;
      expect(await client.collect(order.orderRef)).toMatchObject({
        status: "failed",
        hintCode: "startFailed",
      });
    });
  });

  describe("one open order per personal number", () => {
    it("answers alreadyInProgress and cancels the open order", async () => {
      const { client } = setup();
      const first = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      expect(
        await apiError(
          client.sign({
            endUserIp,
            userVisibleData: "x",
            requirement: { personalNumber },
          }),
        ),
      ).toEqual({
        errorCode: "alreadyInProgress",
        details: expect.any(String),
        status: 400,
      });
      expect(await client.collect(first.orderRef)).toEqual({
        orderRef: first.orderRef,
        status: "failed",
        hintCode: "cancelled",
      });
      // No order is open any more, so the next one starts.
      const third = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      expect((await client.collect(third.orderRef)).status).toBe("pending");
    });

    it("leaves orders without that personal number alone", async () => {
      const { client } = setup();
      const first = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      await client.auth({ endUserIp });
      await client.auth({
        endUserIp,
        requirement: { personalNumber: "200001012384" },
      });
      expect((await client.collect(first.orderRef)).status).toBe("pending");
    });

    it("starts a new order once the previous one is final, collected or cancelled", async () => {
      const { client, fake } = setup();
      const requirement = { personalNumber };
      const completed = await client.auth({ endUserIp, requirement });
      await fake.complete(completed.orderRef, { personalNumber });
      const afterComplete = await client.auth({ endUserIp, requirement });
      await client.cancel(afterComplete.orderRef);
      const afterCancel = await client.auth({ endUserIp, requirement });
      await fake.fail(afterCancel.orderRef, "userCancel");
      await client.collect(afterCancel.orderRef);
      const last = await client.auth({ endUserIp, requirement });
      expect((await client.collect(last.orderRef)).status).toBe("pending");
      // The completed order is still there to collect.
      expect((await client.collect(completed.orderRef)).status).toBe(
        "complete",
      );
    });

    it("keeps the store free of lookups for orders that have ended", async () => {
      const { client, store } = setup();
      const order = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      expect(await store.get(`personalNumber:${personalNumber}`)).toBe(
        order.orderRef,
      );
      await client.cancel(order.orderRef);
      expect(
        await store.get(`personalNumber:${personalNumber}`),
      ).toBeUndefined();
      expect(await store.get(`order:${order.orderRef}`)).toBeUndefined();
    });
  });

  describe("collect", () => {
    it("returns completion data in the spec's shape, marked as fake", async () => {
      const { client, fake } = setup();
      const order = await client.sign({
        endUserIp,
        userVisibleData: "Sign this",
        userNonVisibleData: "hidden",
      });
      await fake.complete(order.orderRef, {
        personalNumber,
        name: "Alex Johnson",
      });
      const result = await client.collect(order.orderRef);
      expect(result).toEqual({
        orderRef: order.orderRef,
        status: "complete",
        completionData: {
          user: {
            personalNumber,
            name: "Alex Johnson",
            givenName: "Alex",
            surname: "Johnson",
          },
          device: { ipAddress: endUserIp, uhi: expect.any(String) },
          bankIdIssueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}Z$/),
          signature: expect.any(String),
          ocspResponse: expect.any(String),
        },
      });
      const { completionData } = result as Extract<
        CollectResponse,
        { status: "complete" }
      >;
      const signature = decode(completionData.signature);
      expect(signature).toMatch(/^<\?xml /);
      expect(signature).toContain(fakeMarker);
      expect(signature).toContain(`<orderRef>${order.orderRef}</orderRef>`);
      expect(signature).toContain(
        `<userVisibleData>${Buffer.from("Sign this").toString("base64")}</userVisibleData>`,
      );
      expect(signature).toContain(
        `<userNonVisibleData>${Buffer.from("hidden").toString("base64")}</userNonVisibleData>`,
      );
      expect(decode(completionData.ocspResponse)).toContain(fakeMarker);
    });

    it("adds risk and stepUp only when the order asked for them, and applies overrides", async () => {
      const { client, fake } = setup();
      const order = await client.auth({
        endUserIp,
        returnRisk: true,
        requirement: { stepUp: ["mrtd", "face"] },
      });
      await fake.complete(
        order.orderRef,
        { personalNumber, givenName: "Kim", surname: "Lee" },
        { risk: "moderate", bankIdIssueDate: "2024-05-01Z" },
      );
      const result = await client.collect(order.orderRef);
      expect(
        result.status === "complete" && result.completionData,
      ).toMatchObject({
        user: { name: "Kim Lee", givenName: "Kim", surname: "Lee" },
        stepUp: { mrtd: true },
        risk: "moderate",
        bankIdIssueDate: "2024-05-01Z",
      });

      const plain = await client.auth({
        endUserIp,
        requirement: { mrtd: true },
      });
      await fake.complete(plain.orderRef, { personalNumber });
      const plainResult = await client.collect(plain.orderRef);
      expect(
        plainResult.status === "complete" && plainResult.completionData,
      ).toMatchObject({
        user: { name: "Test Testsson" },
        stepUp: { mrtd: true },
      });
      expect(
        plainResult.status === "complete" &&
          "risk" in plainResult.completionData,
      ).toBe(false);
    });

    it("overrides only device, bankIdIssueDate, stepUp and risk", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      await fake.complete(
        order.orderRef,
        { personalNumber },
        {
          device: { ipAddress: "198.51.100.7", uhi: "abc" },
          stepUp: { mrtd: true },
        },
      );
      const result = await client.collect(order.orderRef);
      expect(
        result.status === "complete" && result.completionData,
      ).toMatchObject({
        device: { ipAddress: "198.51.100.7", uhi: "abc" },
        stepUp: { mrtd: true },
        user: { personalNumber },
      });
    });

    it.each([
      ["user", { user: { personalNumber: "200001012384" } }],
      ["signature", { signature: "PHJlYWwvPg==" }],
      ["ocspResponse", { ocspResponse: "cmVhbA==" }],
      ["an unknown field", { somethingElse: 1 }],
    ])(
      "refuses an override of %s and keeps the order pending",
      async (_, overrides) => {
        const { client, fake } = setup();
        const order = await client.auth({ endUserIp });
        await expect(
          fake.complete(
            order.orderRef,
            { personalNumber },
            overrides as Parameters<typeof fake.complete>[2],
          ),
        ).rejects.toThrow(
          "fake.complete: overrides may only set device, bankIdIssueDate, stepUp and risk",
        );
        expect((await client.collect(order.orderRef)).status).toBe("pending");
      },
    );

    it("uses the user as it was at the call, read once", async () => {
      const { client, fake } = setup();
      const other = "192110101414";
      const order = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      const reads: Record<string, number> = {};
      const user = {
        get personalNumber() {
          reads.personalNumber = (reads.personalNumber ?? 0) + 1;
          return reads.personalNumber === 1 ? personalNumber : other;
        },
        get name() {
          reads.name = (reads.name ?? 0) + 1;
          return reads.name === 1
            ? "Anna Andersson"
            : (42 as unknown as string);
        },
      };
      await fake.complete(order.orderRef, user);
      const result = await client.collect(order.orderRef);
      expect(
        result.status === "complete" && result.completionData.user,
      ).toEqual({
        personalNumber,
        name: "Anna Andersson",
        givenName: "Anna",
        surname: "Andersson",
      });
      expect(reads).toEqual({ personalNumber: 1, name: 1 });
    });

    it("ignores changes to the user made after the call", async () => {
      const { client, fake } = setup();
      const order = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      const user = { personalNumber, givenName: "Anna" };
      const done = fake.complete(order.orderRef, user);
      user.personalNumber = "192110101414";
      user.givenName = "Mallory";
      await done;
      const result = await client.collect(order.orderRef);
      expect(
        result.status === "complete" && result.completionData.user,
      ).toMatchObject({ personalNumber, givenName: "Anna" });
    });

    it("refuses a user whose fields throw or are not strings", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      for (const user of [
        {
          get personalNumber(): string {
            throw new Error("boom");
          },
        },
        { personalNumber: 200001012384 },
        { personalNumber, surname: { toString: () => "Andersson" } },
        new Proxy(
          { personalNumber },
          {
            get: () => {
              throw new Error("boom");
            },
          },
        ),
      ])
        await expect(
          fake.complete(
            order.orderRef,
            user as unknown as { personalNumber: string },
          ),
        ).rejects.toThrow(TypeError);
      expect((await client.collect(order.orderRef)).status).toBe("pending");
    });

    it.each([
      [
        "a toJSON that adds user",
        { toJSON: () => ({ user: { personalNumber: "192110101414" } }) },
      ],
      [
        "a toJSON that adds signature",
        { device: { uhi: "x" }, toJSON: () => ({ signature: "eA==" }) },
      ],
      [
        "a device whose toJSON is not an object",
        { device: { toJSON: () => "x" } },
      ],
      ["a bankIdIssueDate that is not a string", { bankIdIssueDate: 2020 }],
      ["a risk that is not a string", { risk: ["low"] }],
      ["a stepUp that is not an object", { stepUp: true }],
    ])(
      "checks the overrides as they will be merged: refuses %s",
      async (_, overrides) => {
        const { client, fake } = setup();
        const order = await client.auth({ endUserIp });
        await expect(
          fake.complete(
            order.orderRef,
            { personalNumber },
            overrides as Parameters<typeof fake.complete>[2],
          ),
        ).rejects.toThrow(TypeError);
        expect((await client.collect(order.orderRef)).status).toBe("pending");
      },
    );

    it("refuses overrides that are not JSON", async () => {
      const { fake, client } = setup();
      const order = await client.auth({ endUserIp });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      for (const overrides of [{ device: { uhi: 1n } }, { device: circular }])
        await expect(
          fake.complete(
            order.orderRef,
            { personalNumber },
            overrides as Parameters<typeof fake.complete>[2],
          ),
        ).rejects.toThrow("fake.complete: overrides must be plain JSON");
    });

    it("uses the overrides as they were at the call", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      const device = { ipAddress: "198.51.100.7", uhi: "abc" };
      const done = fake.complete(
        order.orderRef,
        { personalNumber },
        { device },
      );
      device.uhi = "changed";
      await done;
      const result = await client.collect(order.orderRef);
      expect(
        result.status === "complete" && result.completionData.device,
      ).toEqual({ ipAddress: "198.51.100.7", uhi: "abc" });
    });

    it("refuses an override of the marker fields or user as a type error", () => {
      const { fake } = setup();
      const calls = () => [
        // @ts-expect-error signature is made by the fake
        fake.complete("ref", { personalNumber }, { signature: "x" }),
        // @ts-expect-error ocspResponse is made by the fake
        fake.complete("ref", { personalNumber }, { ocspResponse: "x" }),
        // @ts-expect-error the user is the second argument
        fake.complete("ref", { personalNumber }, { user: { personalNumber } }),
      ];
      expect(calls).toBeTypeOf("function");
    });

    it("returns a final state to only one of two concurrent collects", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      await fake.complete(order.orderRef, { personalNumber });
      const results = await Promise.allSettled([
        client.collect(order.orderRef),
        client.collect(order.orderRef),
      ]);
      expect(results.map(r => r.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = results.find(r => r.status === "rejected");
      expect(rejected?.reason).toMatchObject(noSuchOrder);
    });

    it("applies a control and a collect on the same order one after the other", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      const [, collected] = await Promise.all([
        fake.complete(order.orderRef, { personalNumber }),
        client.collect(order.orderRef),
        fake.setPending(order.orderRef, "userSign").catch(() => undefined),
      ]);
      expect(collected.status).toBe("complete");
    });

    it("returns a final state once, then invalidParameters", async () => {
      const { client, fake } = setup();
      const completed = await client.auth({ endUserIp });
      await fake.complete(completed.orderRef, { personalNumber });
      expect((await client.collect(completed.orderRef)).status).toBe(
        "complete",
      );
      expect(await apiError(client.collect(completed.orderRef))).toEqual(
        noSuchOrder,
      );

      const failed = await client.auth({ endUserIp });
      await fake.fail(failed.orderRef, "userCancel");
      expect(await client.collect(failed.orderRef)).toEqual({
        orderRef: failed.orderRef,
        status: "failed",
        hintCode: "userCancel",
      });
      expect(await apiError(client.collect(failed.orderRef))).toEqual(
        noSuchOrder,
      );
    });

    it("answers invalidParameters for an unknown order reference", async () => {
      const { client } = setup();
      const unknown = "131daac9-16c6-4618-beb0-365768f37288";
      expect(await apiError(client.collect(unknown))).toEqual(noSuchOrder);
      expect(await apiError(client.cancel(unknown))).toEqual(noSuchOrder);
    });

    it("steps through scripted pending hint codes, keeping the last", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      await fake.setPending(order.orderRef, [
        "noClient",
        "started",
        "userSign",
      ]);
      const hints = [];
      for (let i = 0; i < 4; i++) {
        const result = await client.collect(order.orderRef);
        hints.push(result.status === "pending" && result.hintCode);
      }
      expect(hints).toEqual(["noClient", "started", "userSign", "userSign"]);
      await fake.setPending(order.orderRef, "userMrtd");
      expect(await client.collect(order.orderRef)).toMatchObject({
        hintCode: "userMrtd",
      });
    });

    it("passes unknown hint codes through", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      await fake.setPending(order.orderRef, "somethingNew");
      expect(await client.collect(order.orderRef)).toMatchObject({
        hintCode: "somethingNew",
      });
      await fake.fail(order.orderRef, "somethingElse");
      expect(await client.collect(order.orderRef)).toMatchObject({
        hintCode: "somethingElse",
      });
    });

    it("reports expiredTransaction after expire", async () => {
      const { client, fake } = setup();
      const order = await client.auth({ endUserIp });
      await fake.expire(order.orderRef);
      expect(await client.collect(order.orderRef)).toEqual({
        orderRef: order.orderRef,
        status: "failed",
        hintCode: "expiredTransaction",
      });
    });
  });

  describe("cancel", () => {
    it("ends the order, so collect and cancel then get invalidParameters", async () => {
      const { client } = setup();
      const order = await client.auth({ endUserIp });
      await client.cancel(order.orderRef);
      expect(await apiError(client.collect(order.orderRef))).toEqual(
        noSuchOrder,
      );
      expect(await apiError(client.cancel(order.orderRef))).toEqual(
        noSuchOrder,
      );
    });

    it("answers with an empty object", async () => {
      const { client, raw } = setup();
      const order = await client.auth({ endUserIp });
      const response = await raw("/cancel", { orderRef: order.orderRef });
      expect(response).toEqual({ status: 200, body: "{}" });
    });
  });

  describe("time", () => {
    it("fails an order nobody picks up within 30 seconds with startFailed", async () => {
      const { client, clock } = setup();
      const order = await client.auth({ endUserIp });
      clock.time += 29_999;
      expect((await client.collect(order.orderRef)).status).toBe("pending");
      clock.time += 1;
      expect(await client.collect(order.orderRef)).toEqual({
        orderRef: order.orderRef,
        status: "failed",
        hintCode: "startFailed",
      });
    });

    it("keeps an order that timed out collectable until 3 minutes 10 seconds after it started", async () => {
      const { client, clock } = setup();
      const kept = await client.auth({ endUserIp });
      const gone = await client.auth({ endUserIp });
      clock.time += 190_000;
      expect((await client.collect(kept.orderRef)).status).toBe("failed");
      clock.time += 1;
      expect(await apiError(client.collect(gone.orderRef))).toEqual(
        noSuchOrder,
      );
    });

    it("does not expire an order that has been picked up", async () => {
      const { client, fake, clock } = setup();
      const order = await client.auth({ endUserIp });
      await fake.setPending(order.orderRef, "userSign");
      clock.time += 10 * 60_000;
      expect(await client.collect(order.orderRef)).toMatchObject({
        status: "pending",
      });
    });

    it("keeps a completed order collectable for 3 minutes and a failed one for 5", async () => {
      const { client, fake, clock } = setup();
      const complete = [
        await client.auth({ endUserIp }),
        await client.auth({ endUserIp }),
      ];
      const failed = [
        await client.auth({ endUserIp }),
        await client.auth({ endUserIp }),
      ];
      for (const order of complete)
        await fake.complete(order.orderRef, { personalNumber });
      for (const order of failed) await fake.fail(order.orderRef, "userCancel");
      clock.time += 180_000;
      expect((await client.collect(complete[0]!.orderRef)).status).toBe(
        "complete",
      );
      clock.time += 1;
      expect(await apiError(client.collect(complete[1]!.orderRef))).toEqual(
        noSuchOrder,
      );
      clock.time += 120_000 - 1;
      expect((await client.collect(failed[0]!.orderRef)).status).toBe("failed");
      clock.time += 1;
      expect(await apiError(client.collect(failed[1]!.orderRef))).toEqual(
        noSuchOrder,
      );
    });

    it("uses autoComplete as it was when the fake was created", async () => {
      const user = { personalNumber, name: "Dev User" };
      const autoComplete = { afterMs: 0, user };
      const { client } = setup({ autoComplete });
      user.personalNumber = "192110101414";
      user.name = "Someone Else";
      autoComplete.afterMs = 60_000;
      const order = await client.auth({ endUserIp });
      const result = await client.collect(order.orderRef);
      expect(
        result.status === "complete" && result.completionData.user,
      ).toMatchObject({ personalNumber, name: "Dev User" });
    });

    it("completes orders by itself with autoComplete", async () => {
      const { client, clock } = setup({
        autoComplete: {
          afterMs: 45_000,
          user: { personalNumber, name: "Dev User" },
        },
      });
      const order = await client.auth({ endUserIp });
      const required = await client.auth({
        endUserIp,
        requirement: { personalNumber: "200001012384" },
      });
      clock.time += 44_999;
      expect(await client.collect(order.orderRef)).toMatchObject({
        status: "pending",
        hintCode: "userSign",
      });
      clock.time += 1;
      const result = await client.collect(order.orderRef);
      expect(
        result.status === "complete" && result.completionData.user,
      ).toEqual({
        personalNumber,
        name: "Dev User",
        givenName: "Dev",
        surname: "User",
      });
      const requiredResult = await client.collect(required.orderRef);
      expect(
        requiredResult.status === "complete" &&
          requiredResult.completionData.user?.personalNumber,
      ).toBe("200001012384");
    });
  });

  describe("scan", () => {
    it("accepts the order's current QR code and moves the order to userSign", async () => {
      const { client, fake, clock } = setup();
      const startedAt = clock.time;
      const order = await client.auth({ endUserIp });
      clock.time += 7_400;
      await fake.scan(
        order.orderRef,
        qrCode(order, { startedAt, now: clock.time }),
      );
      expect(await client.collect(order.orderRef)).toMatchObject({
        hintCode: "userSign",
      });
      // Picked up, so the 30-second limit no longer applies.
      clock.time += 60_000;
      expect((await client.collect(order.orderRef)).status).toBe("pending");
      await expect(
        fake.scan(
          order.orderRef,
          qrCode(order, { startedAt, now: clock.time }),
        ),
      ).rejects.toThrow("already picked up");
    });

    it("accepts a code up to 3 seconds old and refuses older or future codes", async () => {
      const { client, fake, clock } = setup();
      const startedAt = clock.time;
      const order = await client.auth({ endUserIp });
      clock.time += 10_000;
      const at = (seconds: number) =>
        qrCode(order, { startedAt, now: startedAt + seconds * 1000 });
      await expect(fake.scan(order.orderRef, at(6))).rejects.toThrow(
        "10 seconds old",
      );
      await expect(fake.scan(order.orderRef, at(11))).rejects.toThrow(
        "10 seconds old",
      );
      await fake.scan(order.orderRef, at(7));
    });

    it("refuses a code for another order or with a wrong code", async () => {
      const { client, fake, clock } = setup();
      const order = await client.auth({ endUserIp });
      const other = await client.auth({ endUserIp });
      const now = clock.time;
      const valid = qrCode(order, { startedAt: now, now });
      for (const code of [
        qrCode(other, { startedAt: now, now }),
        qrCode(
          { ...order, qrStartSecret: other.qrStartSecret },
          { startedAt: now, now },
        ),
        valid.replace(".0.", ".00."),
        `${valid}.extra`,
        "",
      ])
        await expect(fake.scan(order.orderRef, code)).rejects.toThrow(
          "not a QR code",
        );
    });
  });

  describe("controls", () => {
    it("refuse orders that are unknown or no longer pending", async () => {
      const { client, fake } = setup();
      await expect(fake.complete("nope", { personalNumber })).rejects.toThrow(
        "no order nope",
      );
      const order = await client.auth({ endUserIp });
      await fake.fail(order.orderRef, "userCancel");
      await expect(
        fake.complete(order.orderRef, { personalNumber }),
      ).rejects.toThrow("is failed, not pending");
      await expect(fake.setPending(order.orderRef, "userSign")).rejects.toThrow(
        "not pending",
      );
      await expect(fake.expire(order.orderRef)).rejects.toThrow("not pending");
      await expect(fake.scan(order.orderRef, "")).rejects.toThrow(
        "not pending",
      );
    });

    it("refuse a user other than the one the order requires", async () => {
      const { client, fake } = setup();
      const order = await client.auth({
        endUserIp,
        requirement: { personalNumber },
      });
      const error = await rejection(
        fake.complete(order.orderRef, { personalNumber: "200001012384" }),
      );
      expect((error as Error).message).toBe(
        `fake.complete: order ${order.orderRef} requires another personal number`,
      );
      expect((error as Error).message).not.toContain(personalNumber);
    });

    it("check their arguments", async () => {
      const { client, fake } = setup();
      const { orderRef } = await client.auth({ endUserIp });
      const loose = fake as unknown as Record<
        string,
        (...args: unknown[]) => Promise<void>
      >;
      await expect(
        loose.complete!(orderRef, { personalNumber: "123" }),
      ).rejects.toThrow(TypeError);
      await expect(
        loose.complete!(orderRef, { personalNumber, name: 1 }),
      ).rejects.toThrow(TypeError);
      await expect(
        loose.complete!(orderRef, { personalNumber }, 1),
      ).rejects.toThrow(TypeError);
      await expect(loose.fail!(orderRef, "")).rejects.toThrow(TypeError);
      await expect(loose.setPending!(orderRef, [])).rejects.toThrow(TypeError);
      await expect(
        loose.setPending!(orderRef, ["userSign", 1]),
      ).rejects.toThrow(TypeError);
      await expect(loose.expire!(1)).rejects.toThrow(TypeError);
    });
  });

  it("gives a final state to only one of two fakes that share a store", async () => {
    const store = createStore();
    const fakes = [createFakeBankId({ store }), createFakeBankId({ store })];
    const [first, second] = fakes.map(fake =>
      createBankIdClient({ environment: "test", transport: fake.transport }),
    ) as [
      ReturnType<typeof createBankIdClient>,
      ReturnType<typeof createBankIdClient>,
    ];
    const order = await first.auth({ endUserIp });
    await fakes[0]!.complete(order.orderRef, { personalNumber });
    const results = await Promise.allSettled([
      first.collect(order.orderRef),
      second.collect(order.orderRef),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find(r => r.status === "rejected");
    expect(rejected?.reason).toMatchObject(noSuchOrder);
  });

  it("shares orders between fakes that share a store", async () => {
    const store = createStore();
    const first = createFakeBankId({ store });
    const second = createFakeBankId({ store });
    const client = createBankIdClient({
      environment: "test",
      transport: first.transport,
    });
    const other = createBankIdClient({
      environment: "test",
      transport: second.transport,
    });
    const order = await client.auth({
      endUserIp,
      requirement: { personalNumber },
    });
    expect(
      (
        await apiError(
          other.auth({ endUserIp, requirement: { personalNumber } }),
        )
      ).errorCode,
    ).toBe("alreadyInProgress");
    const next = await other.auth({
      endUserIp,
      requirement: { personalNumber },
    });
    await first.complete(next.orderRef, { personalNumber });
    expect((await other.collect(order.orderRef)).status).toBe("failed");
    expect((await client.collect(next.orderRef)).status).toBe("complete");
    expect(await apiError(other.collect(next.orderRef))).toEqual(noSuchOrder);
  });
});

describe("fake BankID transport", () => {
  const send = (
    request: Partial<Omit<BankIdTransportRequest, "path">> & { path: string },
  ) =>
    createFakeBankId().transport({
      method: "POST",
      body: {},
      signal: new AbortController().signal,
      ...request,
    } as BankIdTransportRequest);

  it("answers notFound for a path BankID does not have", async () => {
    const response = await send({ path: "/nope" });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body as string)).toMatchObject({
      errorCode: "notFound",
    });
    expect((await send({ path: "toString" })).status).toBe(404);
  });

  it("answers methodNotAllowed for any method but POST", async () => {
    const response = await send({
      path: "/auth",
      method: "GET" as "POST",
    });
    expect(response.status).toBe(405);
    expect(JSON.parse(response.body as string)).toMatchObject({
      errorCode: "methodNotAllowed",
    });
  });

  it("answers invalidParameters for a body that is not an object", async () => {
    const response = await send({
      path: "/auth",
      body: [] as unknown as Record<string, unknown>,
    });
    expect(response.status).toBe(400);
  });

  it("handles every path in BankID's spec", async () => {
    const spec = readFileSync(
      new URL("../spec/openapi-auth-sign.yaml", import.meta.url),
      "utf8",
    );
    const paths = [...spec.matchAll(/^ {2}(\/[a-z/]+):$/gm)].map(
      ([, path]) => path!,
    );
    expect(paths).toHaveLength(11);
    for (const path of paths) {
      const response = await send({ path });
      expect([path, response.status]).toEqual([path, 400]);
    }
  });

  it("rejects when the signal has aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      send({ path: "/auth", signal: controller.signal }),
    ).rejects.toThrow("stop");
  });

  it("surfaces a failing store as a transport error", async () => {
    const broken = new Error("store down");
    const fake = createFakeBankId({
      store: {
        get: async () => {
          throw broken;
        },
        set: async () => {
          throw broken;
        },
        delete: async () => {},
      },
    });
    const client = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const error = await rejection(client.auth({ endUserIp }));
    expect(error).toBeInstanceOf(BankIdTransportError);
    expect((error as BankIdTransportError).cause).toEqual({ name: "Error" });
  });

  it("refuses an order the store holds in an unknown shape", async () => {
    const store = createMemoryStore();
    await store.set("order:x", { something: "else" });
    const fake = createFakeBankId({ store });
    await expect(fake.expire("x")).rejects.toThrow("not an order");
  });

  it.each([
    [null],
    [{ store: {} }],
    [{ now: 1 }],
    [{ autoComplete: { afterMs: -1, user: { personalNumber } } }],
    [{ autoComplete: { afterMs: 1, user: { personalNumber: "1" } } }],
    [{ autoComplete: { afterMs: Number.NaN, user: { personalNumber } } }],
  ])("refuses options %j", options => {
    expect(() => createFakeBankId(options as FakeBankIdOptions)).toThrow(
      TypeError,
    );
  });
});

describe("the client through the fake", () => {
  it("runs a full auth flow with the QR code and watch", async () => {
    const fake = createFakeBankId();
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const startedAt = Date.now();
    const order = await bankid.auth({ endUserIp, returnRisk: true });
    const seen: string[] = [];
    for await (const result of bankid.watch(order.orderRef, {
      intervalMs: 1,
    })) {
      seen.push(
        result.status === "pending"
          ? (result.hintCode ?? "none")
          : result.status,
      );
      if (
        result.status === "pending" &&
        result.hintCode === "outstandingTransaction"
      )
        await fake.scan(order.orderRef, qrCode(order, { startedAt }));
      else if (result.status === "pending")
        await fake.complete(order.orderRef, {
          personalNumber,
          name: "Alex Johnson",
        });
      else if (result.status === "complete") {
        expect(result.completionData.user?.personalNumber).toBe(personalNumber);
        expect(result.completionData.device?.ipAddress).toBe(endUserIp);
        expect(result.completionData.risk).toBe("low");
      }
    }
    expect(seen).toEqual(["outstandingTransaction", "userSign", "complete"]);
  });

  it("runs a full sign flow with scripted hint codes and watch", async () => {
    const fake = createFakeBankId();
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const order = await bankid.sign({
      endUserIp,
      userVisibleData: "Pay 100 SEK",
      requirement: { personalNumber },
    });
    await fake.setPending(order.orderRef, [
      "started",
      "userSign",
      "processing",
    ]);
    const seen: string[] = [];
    for await (const result of bankid.watch(order.orderRef, {
      intervalMs: 1,
    })) {
      seen.push(
        result.status === "pending"
          ? (result.hintCode ?? "none")
          : result.status,
      );
      if (result.status === "pending" && result.hintCode === "processing")
        await fake.complete(order.orderRef, { personalNumber });
      if (result.status === "complete")
        expect(decode(result.completionData.signature)).toContain(
          Buffer.from("Pay 100 SEK").toString("base64"),
        );
    }
    expect(seen).toEqual(["started", "userSign", "processing", "complete"]);
  });

  it("runs a full phone auth flow: the user confirms the call, then identifies", async () => {
    const fake = createFakeBankId();
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const order = await bankid.phone.auth({
      callInitiator: "RP",
      personalNumber,
      userVisibleData: "We are calling you about your application",
    });
    const seen: string[] = [];
    for await (const result of bankid.watch(order.orderRef, {
      intervalMs: 1,
    })) {
      seen.push(
        result.status === "pending"
          ? (result.hintCode ?? "none")
          : result.status,
      );
      if (
        result.status === "pending" &&
        result.hintCode === "outstandingTransaction"
      )
        await fake.setPending(order.orderRef, ["userCallConfirm", "userSign"]);
      else if (result.status === "pending" && result.hintCode === "userSign")
        await fake.complete(order.orderRef, { personalNumber });
      else if (result.status === "complete")
        expect(result.completionData.user?.personalNumber).toBe(personalNumber);
    }
    expect(seen).toEqual([
      "outstandingTransaction",
      "userCallConfirm",
      "userSign",
      "complete",
    ]);
  });

  it("ends a phone flow with userDeclinedCall when the user declines the call", async () => {
    const fake = createFakeBankId();
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const order = await bankid.phone.sign({
      callInitiator: "user",
      personalNumber,
      userVisibleData: "Pay 100 SEK",
    });
    await fake.setPending(order.orderRef, "userCallConfirm");
    const seen: string[] = [];
    for await (const result of bankid.watch(order.orderRef, {
      intervalMs: 1,
    })) {
      seen.push(
        result.status === "pending"
          ? (result.hintCode ?? "none")
          : result.status,
      );
      if (result.status === "pending")
        await fake.fail(order.orderRef, "userDeclinedCall");
      if (result.status === "failed")
        expect(result.hintCode).toBe("userDeclinedCall");
    }
    expect(seen).toEqual(["userCallConfirm", "failed"]);
  });

  it("ends a watch with the failure when the user cancels", async () => {
    const fake = createFakeBankId();
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const order = await bankid.auth({ endUserIp });
    await fake.fail(order.orderRef, "userCancel");
    const results = [];
    for await (const result of bankid.watch(order.orderRef, { intervalMs: 1 }))
      results.push(result);
    expect(results).toEqual([
      { orderRef: order.orderRef, status: "failed", hintCode: "userCancel" },
    ]);
  });
});

describe("the in-memory store's cleanup", () => {
  it("removes orders that can no longer be collected, and their lookups, on later writes", async () => {
    const clock = { time: 1_750_000_000_000 };
    const store = createMemoryStore();
    const fake = createFakeBankId({ store, now: () => clock.time });
    const client = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const personalNumbers = Array.from({ length: 20 }, (_, i) =>
      String(i + 1).padStart(12, "0"),
    );
    const abandoned = [];
    for (const number of personalNumbers)
      abandoned.push(
        await client.auth({
          endUserIp,
          requirement: { personalNumber: number },
        }),
      );
    // One order is picked up and left pending, one is completed just now.
    const kept = await client.auth({ endUserIp });
    await fake.setPending(kept.orderRef, "userSign");
    clock.time += 4 * 60_000; // past every collectable window
    const fresh = await client.auth({ endUserIp });
    await fake.complete(fresh.orderRef, { personalNumber });
    for (let i = 0; i < 10; i++) await client.auth({ endUserIp });

    for (const { orderRef } of abandoned)
      expect(await store.get(`order:${orderRef}`)).toBeUndefined();
    for (const number of personalNumbers)
      expect(await store.get(`personalNumber:${number}`)).toBeUndefined();
    expect(await store.get(`order:${kept.orderRef}`)).toBeDefined();
    expect(await store.get(`order:${fresh.orderRef}`)).toBeDefined();
    expect((await client.collect(fresh.orderRef)).status).toBe("complete");
  });

  it("keeps a picked-up pending order until expire or cancel removes it", async () => {
    const clock = { time: 1_750_000_000_000 };
    const store = createMemoryStore();
    const fake = createFakeBankId({ store, now: () => clock.time });
    const client = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const expired = await client.auth({ endUserIp });
    const cancelled = await client.auth({ endUserIp });
    await fake.setPending(expired.orderRef, "userSign");
    await fake.setPending(cancelled.orderRef, "userSign");
    clock.time += 24 * 60 * 60_000;
    for (let i = 0; i < 20; i++) await client.auth({ endUserIp });
    expect(await store.get(`order:${expired.orderRef}`)).toBeDefined();
    expect(await store.get(`order:${cancelled.orderRef}`)).toBeDefined();

    await fake.expire(expired.orderRef);
    await client.cancel(cancelled.orderRef);
    clock.time += 6 * 60_000; // past the failed order's collectable window
    for (let i = 0; i < 20; i++) await client.auth({ endUserIp });
    expect(await store.get(`order:${expired.orderRef}`)).toBeUndefined();
    expect(await store.get(`order:${cancelled.orderRef}`)).toBeUndefined();
  });

  it("is described as it behaves in docs/testing.md", () => {
    const docs = readFileSync(
      new URL("../docs/testing.md", import.meta.url),
      "utf8",
    );
    const section = docs.slice(docs.indexOf("### Several processes"));
    expect(section).not.toMatch(/does not grow without bound/);
    for (const remedy of ["`fake.expire`", "`cancel`", "new fake"])
      expect(section).toContain(remedy);
  });

  it("sets no timer", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeBankId();
      const client = createBankIdClient({
        environment: "test",
        transport: fake.transport,
      });
      for (let i = 0; i < 20; i++) await client.auth({ endUserIp });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
