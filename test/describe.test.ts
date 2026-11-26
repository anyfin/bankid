import { readFileSync } from "node:fs";
import { describe as group, expect, expectTypeOf, it } from "vitest";
import {
  BankIdApiError,
  describe,
  type CollectResponse,
  type DescribeContext,
  type UserMessage,
} from "../src/index.ts";
import {
  describe as describeForClient,
  type RelayedComplete,
  type RelayedFailed,
  type RelayedPending,
  type RelayedStatus,
  type WithStatus,
} from "../src/client/index.ts";
import {
  errorMessages,
  failedMessages,
  pendingMessages,
} from "../src/shared/describe.ts";

const contexts: DescribeContext[] = [
  { start: "autoStart", device: "phone" },
  { start: "autoStart", device: "desktop" },
  { start: "qrCode" },
  { start: "phoneCall" },
  { start: "other" },
];
const phone = contexts[0]!;
const desktop = contexts[1]!;
const qr = contexts[2]!;
const phoneCall = contexts[3]!;
const other = contexts[4]!;

const orderRef = "131daac9-16c6-4618-beb0-365768f37288";
const pending = (hintCode: string): CollectResponse => ({
  orderRef,
  status: "pending",
  hintCode,
});
const failed = (hintCode: string): CollectResponse => ({
  orderRef,
  status: "failed",
  hintCode,
});

/**
 * Reads the two hint code tables (pending, then failed) from the `hintCode`
 * schema in the checked-in spec, with the messages each row names.
 */
const specHintCodes = () => {
  const spec = readFileSync(
    new URL("../spec/openapi-auth-sign.yaml", import.meta.url),
    "utf8",
  );
  const start = spec.indexOf("\n    hintCode:\n      description: |-\n");
  const end = spec.indexOf("\n      type: string", start);
  if (start < 0 || end < 0) throw new Error("hintCode schema not found");
  const tables = spec.slice(start, end).split("This is a final state");
  if (tables.length !== 2) throw new Error("expected two hint code tables");
  return tables.map(table =>
    [...table.matchAll(/<tr>\s*<td>([^<]*)<\/td>([\s\S]*?)<\/tr>/g)]
      .map(([, code, row]) => ({
        code: code!.trim(),
        messages: [...new Set(row!.match(/RFA\d+/g) ?? [])],
      }))
      .filter(({ code }) => /^[a-zA-Z]+$/.test(code) && code !== "hintCode"),
  ) as [Row[], Row[]];
};
interface Row {
  code: string;
  messages: string[];
}

const [specPending, specFailed] = specHintCodes();

// Hint codes for which the spec names no message, and what describe returns.
const noMessageInSpec: Record<string, UserMessage> = {
  userCallConfirm: "RFA21",
  userDeclinedCall: "RFA22",
  notSupportedByUserApp: "RFA22",
};

/** Whether `message` is `named` or one of its lettered variants (RFA15A). */
const matches = (message: string | undefined, named: string[]) =>
  named.some(n => message === n || message?.replace(/[AB]$/, "") === n);

group("describe: hint codes from the spec", () => {
  it("finds the hint code tables in the spec", () => {
    expect(specPending.map(r => r.code)).toContain("userSign");
    expect(specFailed.map(r => r.code)).toContain("userCancel");
  });

  it("maps exactly the hint codes the spec lists", () => {
    expect(Object.keys(pendingMessages).sort()).toEqual(
      specPending.map(r => r.code).sort(),
    );
    expect(Object.keys(failedMessages).sort()).toEqual(
      specFailed.map(r => r.code).sort(),
    );
  });

  for (const [status, rows, make] of [
    ["pending", specPending, pending],
    ["failed", specFailed, failed],
  ] as const) {
    for (const { code, messages } of rows) {
      it(`${status} ${code}: ${messages.join(" or ") || "no message in spec"}`, () => {
        for (const context of contexts) {
          const message = describe(make(code), context);
          if (messages.length === 0)
            expect(message).toBe(noMessageInSpec[code]);
          else expect(matches(message, messages), String(message)).toBe(true);
        }
      });
    }
  }
});

group("describe: messages that depend on the context", () => {
  it("outstandingTransaction: RFA13 after an autostart, else RFA1", () => {
    const result = pending("outstandingTransaction");
    expect(describe(result, phone)).toBe("RFA13");
    expect(describe(result, desktop)).toBe("RFA13");
    expect(describe(result, qr)).toBe("RFA1");
    expect(describe(result, phoneCall)).toBe("RFA1");
    expect(describe(result, other)).toBe("RFA1");
  });

  it("started: RFA15A on a computer, RFA15B on a phone or tablet", () => {
    const result = pending("started");
    expect(describe(result, desktop)).toBe("RFA15A");
    expect(describe(result, phone)).toBe("RFA15B");
    expect(describe(result, qr)).toBe("RFA15B");
    expect(describe(result, phoneCall)).toBe("RFA15B");
    expect(describe(result, other)).toBe("RFA15B");
  });

  it("startFailed: RFA17B with a QR code, else RFA17A", () => {
    const result = failed("startFailed");
    expect(describe(result, phone)).toBe("RFA17A");
    expect(describe(result, desktop)).toBe("RFA17A");
    expect(describe(result, qr)).toBe("RFA17B");
    expect(describe(result, phoneCall)).toBe("RFA17A");
    expect(describe(result, other)).toBe("RFA17A");
  });

  it("phone call statuses: RFA21 while the user confirms the call, RFA22 when declined", () => {
    expect(describe(pending("userCallConfirm"), phoneCall)).toBe("RFA21");
    expect(describe(failed("userDeclinedCall"), phoneCall)).toBe("RFA22");
  });
});

group("describe: absent hint codes", () => {
  it("returns RFA21 for a pending result without a hint code", () => {
    for (const context of contexts)
      expect(describe({ orderRef, status: "pending" }, context)).toBe("RFA21");
  });

  it("returns RFA22 for a failed result without a hint code", () => {
    for (const context of contexts)
      expect(describe({ orderRef, status: "failed" }, context)).toBe("RFA22");
  });
});

group("describe: unknown hint codes", () => {
  it("returns RFA21 for an unknown pending hint code", () => {
    for (const context of contexts) {
      expect(describe(pending("somethingNew"), context)).toBe("RFA21");
      expect(describe(pending("toString"), context)).toBe("RFA21");
    }
  });

  it("returns RFA22 for an unknown failed hint code", () => {
    for (const context of contexts) {
      expect(describe(failed("somethingNew"), context)).toBe("RFA22");
      expect(describe(failed("__proto__"), context)).toBe("RFA22");
    }
  });
});

group("describe: other results", () => {
  it("returns undefined for a complete order", () => {
    const complete: CollectResponse = {
      orderRef,
      status: "complete",
      completionData: {} as never,
    };
    expect(describe(complete, qr)).toBeUndefined();
  });

  it("needs a context for a collect result", () => {
    // @ts-expect-error the context is required for a collect result
    expect(() => describe(pending("userSign"))).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error only autoStart, qrCode, phoneCall and other exist
      describe(pending("userSign"), { start: "manual" }),
    ).toThrow(TypeError);
  });

  it("has the documented types", () => {
    expectTypeOf(describe(pending("userSign"), qr)).toEqualTypeOf<
      UserMessage | undefined
    >();
    expectTypeOf(
      describe({ errorCode: "maintenance" }),
    ).toEqualTypeOf<UserMessage>();
    // @ts-expect-error a phone or desktop device is needed with autoStart
    const missingDevice: DescribeContext = { start: "autoStart" };
    expect(missingDevice).toBeDefined();
  });
});

group("describe: relayed statuses", () => {
  const relayedPending: RelayedPending = {
    status: "pending",
    hintCode: "userSign",
    qrCode: "bankid.qr",
  };
  const relayedFailed: RelayedFailed = {
    status: "failed",
    hintCode: "userCancel",
  };
  const relayedComplete: RelayedComplete = { status: "complete" };

  it("takes a RelayedStatus with no placeholder orderRef", () => {
    for (const fn of [describe, describeForClient]) {
      expect(fn(relayedPending, qr)).toBe("RFA9");
      expect(fn(relayedFailed, qr)).toBe("RFA6");
      expect(fn(relayedComplete, qr)).toBeUndefined();
      expect(fn({ status: "pending" }, qr)).toBe("RFA21");
      expect(fn({ status: "failed" }, qr)).toBe("RFA22");
    }
  });

  it("gives the same message for a relayed status as for its collect result", () => {
    for (const context of contexts) {
      expect(describe(relayedPending, context)).toBe(
        describe(pending("userSign"), context),
      );
      expect(describe(relayedFailed, context)).toBe(
        describe(failed("userCancel"), context),
      );
    }
  });

  it("type-checks every relayed status and collect response", () => {
    const relayed = relayedPending as RelayedStatus;
    expectTypeOf(describe(relayed, qr)).toEqualTypeOf<
      UserMessage | undefined
    >();
    expectTypeOf(describeForClient(relayedFailed, qr)).toEqualTypeOf<
      UserMessage | undefined
    >();
    expectTypeOf(describe(relayedComplete, qr)).toEqualTypeOf<
      UserMessage | undefined
    >();
    expectTypeOf<RelayedStatus>().toExtend<WithStatus>();
    expectTypeOf<CollectResponse>().toExtend<WithStatus>();
    // A whole collect response as an object literal still passes.
    expect(describe({ orderRef, status: "pending", hintCode: "x" }, qr)).toBe(
      "RFA21",
    );
  });

  it("still refuses what is not an order status", () => {
    // @ts-expect-error a relayed status needs a context too
    expect(() => describe(relayedPending)).toThrow(TypeError);
    // @ts-expect-error status is pending, complete or failed
    expect(describe({ status: "started" }, qr)).toBeUndefined();
    const error = new BankIdApiError({
      errorCode: "maintenance",
      details: "",
      status: 503,
      path: "/collect",
    });
    // @ts-expect-error an error takes no context: its status is an HTTP status
    expect(describe(error, qr)).toBe("RFA5");
  });
});

// BankID's spec lists no error codes; these are the codes and messages in
// BankID's errors guide (api-references/errors). A code with no message there
// is a fault in the relying party's own system.
const errorsGuide: Record<string, string | undefined> = {
  alreadyInProgress: "RFA4",
  invalidParameters: undefined,
  unauthorized: undefined,
  notFound: undefined,
  methodNotAllowed: undefined,
  requestTimeout: "RFA5",
  unsupportedMediaType: undefined,
  internalError: "RFA5",
  maintenance: "RFA5",
};

group("describe: error codes", () => {
  it("maps exactly the error codes in the errors guide", () => {
    expect(Object.keys(errorMessages).sort()).toEqual(
      Object.keys(errorsGuide).sort(),
    );
  });

  for (const [errorCode, message] of Object.entries(errorsGuide)) {
    it(`${errorCode}: ${message ?? "no message in the guide, RFA22"}`, () => {
      expect(describe({ errorCode })).toBe(message ?? "RFA22");
    });
  }

  it("returns RFA22 for an unknown error code", () => {
    expect(describe({ errorCode: "somethingNew" })).toBe("RFA22");
    expect(describe({ errorCode: "constructor" })).toBe("RFA22");
  });

  it("accepts a BankIdApiError", () => {
    const error = new BankIdApiError({
      errorCode: "alreadyInProgress",
      details: "",
      status: 400,
      path: "/auth",
    });
    expect(describe(error)).toBe("RFA4");
  });
});
