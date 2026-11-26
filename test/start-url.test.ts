import { describe, expect, it } from "vitest";
import { startUrl } from "../src/client/index.ts";

describe("startUrl", () => {
  it("opens the BankID app through a web link on a phone", () => {
    expect(startUrl({ autoStartToken: "abc-123", device: "phone" })).toBe(
      "https://app.bankid.com/?autostarttoken=abc-123",
    );
  });

  it("opens the BankID app through the bankid scheme on a desktop", () => {
    expect(startUrl({ autoStartToken: "abc-123", device: "desktop" })).toBe(
      "bankid:///?autostarttoken=abc-123",
    );
  });

  it("encodes a token that has characters with a meaning in URLs", () => {
    const autoStartToken = "a b&c=d?e#f/g+h%i";
    const encoded = "a%20b%26c%3Dd%3Fe%23f%2Fg%2Bh%25i";
    expect(startUrl({ autoStartToken, device: "phone" })).toBe(
      `https://app.bankid.com/?autostarttoken=${encoded}`,
    );
    expect(startUrl({ autoStartToken, device: "desktop" })).toBe(
      `bankid:///?autostarttoken=${encoded}`,
    );
  });

  it.each(["phone", "desktop"] as const)(
    "never adds a redirect parameter on %s",
    device => {
      const url = startUrl({ autoStartToken: "redirect=x&redirect", device });
      expect(new URL(url).searchParams.has("redirect")).toBe(false);
      expect([...new URL(url).searchParams.keys()]).toEqual(["autostarttoken"]);
    },
  );

  it("rejects an empty token", () => {
    expect(() => startUrl({ autoStartToken: "", device: "phone" })).toThrow(
      /autoStartToken/,
    );
  });

  it("rejects an unknown device", () => {
    expect(() =>
      startUrl({ autoStartToken: "abc", device: "tablet" as "phone" }),
    ).toThrow(/tablet/);
  });
});
