import { timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReturnUrl, qrCode, verifyReturn } from "../src/index.ts";

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// The worked example in BankID's QR code guide.
const order = {
  qrStartToken: "67df3917-fa0d-44e5-b327-edcc928297f8",
  qrStartSecret: "d28db9a7-4cde-429e-a983-359be676944c",
};
const guide = [
  "bankid.67df3917-fa0d-44e5-b327-edcc928297f8.0.dc69358e712458a66a7525beef148ae8526b1c71610eff2c16cdffb4cdac9bf8",
  "bankid.67df3917-fa0d-44e5-b327-edcc928297f8.1.949d559bf23403952a94d103e67743126381eda00f0b3cbddbf7c96b1adcbce2",
  "bankid.67df3917-fa0d-44e5-b327-edcc928297f8.2.a9e5ec59cb4eee4ef4117150abc58fad7a85439a6a96ccbecc3668b41795b3f3",
];

describe("qrCode", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reproduces the example in BankID's QR code guide", () => {
    const startedAt = 1_700_000_000_000;
    expect(
      [0, 1, 2].map(t =>
        qrCode(order, { startedAt, now: startedAt + t * 1000 }),
      ),
    ).toEqual(guide);
  });

  it("counts whole seconds since the order started", () => {
    const startedAt = new Date("2026-01-01T12:00:00.000Z");
    const at = (ms: number) =>
      qrCode(order, { startedAt, now: new Date(startedAt.getTime() + ms) });
    expect(at(999)).toBe(guide[0]);
    expect(at(1000)).toBe(guide[1]);
    expect(at(2999)).toBe(guide[2]);
    expect(at(30_000).split(".")[2]).toBe("30");
  });

  it("uses the current time by default", () => {
    vi.useFakeTimers({ now: 1_700_000_002_500 });
    expect(qrCode(order, { startedAt: 1_700_000_000_000 })).toBe(guide[2]);
  });

  it("treats a time before the start as time 0", () => {
    expect(qrCode(order, { startedAt: 5000, now: 4000 })).toBe(guide[0]);
  });

  it("rejects an invalid time", () => {
    expect(() => qrCode(order, { startedAt: Number.NaN })).toThrow(TypeError);
    expect(() =>
      qrCode(order, { startedAt: new Date("not a date"), now: 0 }),
    ).toThrow("startedAt must be a valid Date or number");
  });
});

describe("createReturnUrl", () => {
  it("puts a random nonce in the fragment", () => {
    const { returnUrl, nonce } = createReturnUrl(
      "https://example.com/login?next=%2Fhome",
    );
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(returnUrl).toBe(
      `https://example.com/login?next=%2Fhome#nonce=${nonce}`,
    );
    expect(createReturnUrl("https://example.com/login").nonce).not.toBe(nonce);
  });

  it("accepts app URLs and URL objects", () => {
    const { returnUrl, nonce } = createReturnUrl("myapp://login");
    expect(returnUrl).toBe(`myapp://login#nonce=${nonce}`);
    const fromObject = createReturnUrl(new URL("https://example.com/"));
    expect(fromObject.returnUrl).toBe(
      `https://example.com/#nonce=${fromObject.nonce}`,
    );
  });

  it("rejects a URL that already has a fragment or does not parse", () => {
    expect(() => createReturnUrl("https://example.com/#a")).toThrow(
      "must not have a fragment",
    );
    expect(() => createReturnUrl("https://example.com/#")).toThrow(
      "must not have a fragment",
    );
    expect(() => createReturnUrl("/login")).toThrow(TypeError);
  });

  it("refuses a URL that would be longer than BankID's 512 characters, without echoing it", () => {
    // The nonce adds "#nonce=" and 43 characters.
    const fits = `https://example.com/${"a".repeat(512 - 20 - 50)}`;
    expect(createReturnUrl(fits).returnUrl).toHaveLength(512);
    const tooLong = `${fits}b`;
    let error: unknown;
    try {
      createReturnUrl(tooLong);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "createReturnUrl: the URL with its nonce is longer than the 512 characters BankID allows",
    );
  });

  it("names only the argument when the URL does not parse", () => {
    const secret = "/login?session=4d1f9e";
    let error: unknown;
    try {
      createReturnUrl(secret);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "createReturnUrl: the URL must be an absolute URL",
    );
    expect(JSON.stringify(error)).not.toContain("4d1f9e");
    expect(Object.keys(error as object)).toEqual([]);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("verifyReturn", () => {
  const nonce = createReturnUrl("https://example.com/").nonce;

  it("accepts the same nonce", () => {
    expect(verifyReturn({ expected: nonce, received: `${nonce}` })).toBe(true);
  });

  it("rejects a different nonce of the same length", () => {
    const other = createReturnUrl("https://example.com/").nonce;
    expect(other).toHaveLength(nonce.length);
    expect(verifyReturn({ expected: nonce, received: other })).toBe(false);
  });

  it("rejects a nonce of a different length", () => {
    expect(verifyReturn({ expected: nonce, received: nonce.slice(1) })).toBe(
      false,
    );
    expect(verifyReturn({ expected: nonce, received: `${nonce}x` })).toBe(
      false,
    );
  });

  it("rejects missing values", () => {
    for (const [expected, received] of [
      [nonce, undefined],
      [nonce, null],
      [nonce, ""],
      [undefined, nonce],
      [null, nonce],
      ["", nonce],
      [undefined, undefined],
      ["", ""],
    ] as const)
      expect(verifyReturn({ expected, received })).toBe(false);
  });

  it("compares with crypto.timingSafeEqual, also for different lengths", () => {
    vi.mocked(timingSafeEqual).mockClear();
    expect(verifyReturn({ expected: nonce, received: "short" })).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledOnce();
  });
});
