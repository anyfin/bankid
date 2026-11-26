import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionRootCa, testRootCa } from "../src/root-ca.ts";

const fromRepo = (name: string) =>
  new X509Certificate(
    readFileSync(new URL(`../cert/${name}`, import.meta.url)),
  );

describe("bundled root CAs", () => {
  it.each([
    ["production", productionRootCa, "prod.ca", "BankID SSL Root CA v1"],
    ["test", testRootCa, "test.ca", "Test BankID SSL Root CA v1 Test"],
  ])(
    "%s is the certificate in cert/ and is BankID's root CA",
    (_, embedded, file, commonName) => {
      const certificate = new X509Certificate(embedded);
      expect(certificate.fingerprint256).toBe(fromRepo(file).fingerprint256);
      expect(certificate.subject).toContain(`CN=${commonName}`);
      expect(certificate.subject).toContain("O=Finansiell ID-Teknik BID AB");
      expect(certificate.issuer).toBe(certificate.subject);
      expect(certificate.ca).toBe(true);
    },
  );
});
