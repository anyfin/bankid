import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";
import { describe, expect, it } from "vitest";
import { createBankIdClient } from "../src/index.ts";
import { testCredentials } from "../src/testing/index.ts";

describe("testCredentials", () => {
  it("is the test certificate in cert/, byte for byte", () => {
    const file = readFileSync(
      new URL("../cert/FPTestcert5_20240610.p12", import.meta.url),
    );
    expect(
      Buffer.from(testCredentials.pfx as string, "base64").equals(file),
    ).toBe(true);
  });

  it("opens with the passphrase from BankID's test documentation", () => {
    expect(testCredentials.passphrase).toBe("qwerty123");
    expect(() =>
      createSecureContext({
        pfx: Buffer.from(testCredentials.pfx as string, "base64"),
        passphrase: testCredentials.passphrase,
      }),
    ).not.toThrow();
    expect(() =>
      createBankIdClient({ environment: "test", credentials: testCredentials }),
    ).not.toThrow();
  });

  it("cannot be changed", () => {
    expect(Object.isFrozen(testCredentials)).toBe(true);
  });
});
