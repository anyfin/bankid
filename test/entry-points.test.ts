import { describe, expect, it } from "vitest";
import * as server from "../src/index.ts";
import * as client from "../src/client/index.ts";
import * as testing from "../src/testing/index.ts";

describe("entry points", () => {
  it("exports the client, errors and order helpers from the server entry point", () => {
    expect(Object.keys(server).sort()).toEqual([
      "BankIdApiError",
      "BankIdTransportError",
      "createBankIdClient",
      "createNodeTransport",
      "createReturnUrl",
      "describe",
      "qrCode",
      "verifyReturn",
    ]);
  });

  it("exports only browser-safe helpers from the client entry point", () => {
    expect(Object.keys(client).sort()).toEqual(["describe", "startUrl"]);
    expect(client.describe).toBe(server.describe);
    expect(client).not.toHaveProperty("createNodeTransport");
  });

  it("exports the fake, its store and the test certificate from the testing entry point", () => {
    expect(Object.keys(testing).sort()).toEqual([
      "createFakeBankId",
      "createMemoryStore",
      "fakeMarker",
      "testCredentials",
    ]);
  });

  it("keeps the test certificate out of the server and client entry points", () => {
    for (const entry of [server, client])
      expect(Object.values(entry)).not.toContain(testing.testCredentials);
  });
});
