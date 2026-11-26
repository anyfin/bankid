// Runs the payment sample in README.md itself against the fake BankID.
import { expect, it } from "vitest";
import {
  createBankIdClient,
  qrCode,
  type BankIdClient,
  type OrderResponse,
} from "../../src/index.ts";
import { createFakeBankId } from "../../src/testing/index.ts";
import { loadDocSample } from "./doc-sample.ts";

const holder = globalThis as { readmeBankId?: BankIdClient };

it("returns what the caller needs to start the app and show the QR code", async () => {
  const { approvePurchase } = await loadDocSample<{
    approvePurchase: (
      endUserIp: string,
    ) => Promise<{ order: OrderResponse; startedAt: number }>;
  }>("README.md", "export async function approvePurchase");
  const fake = createFakeBankId();
  holder.readmeBankId = createBankIdClient({
    environment: "test",
    transport: fake.transport,
  });
  const before = Date.now();
  const { order, startedAt } = await approvePurchase("192.0.2.1");
  expect(Object.keys(order).sort()).toEqual([
    "autoStartToken",
    "orderRef",
    "qrStartSecret",
    "qrStartToken",
  ]);
  expect(startedAt).toBeGreaterThanOrEqual(before);
  await fake.scan(order.orderRef, qrCode(order, { startedAt }));
  await fake.complete(order.orderRef, { personalNumber: "190010101010" });
  expect(await holder.readmeBankId.collect(order.orderRef)).toMatchObject({
    status: "complete",
  });
});
