// Runs the library calls README.md shows for several server instances: the
// QR code computed from the stored order alone, and the relayed status that
// never carries anything from the completed order.
import { beforeAll, expect, it } from "vitest";
import {
  createBankIdClient,
  qrCode,
  type BankIdClient,
  type CollectResponse,
  type OrderResponse,
} from "../../src/index.ts";
import type { RelayedStatus } from "../../src/client/index.ts";
import { createFakeBankId } from "../../src/testing/index.ts";
import { loadDocSample } from "./doc-sample.ts";

interface Sample {
  currentQrCode: (order: OrderResponse, startedAt: number) => string;
  collectOnce: (orderRef: string) => Promise<CollectResponse>;
  relay: (result: CollectResponse) => RelayedStatus;
}

const holder = globalThis as { readmeBankId?: BankIdClient };
let sample: Sample;

beforeAll(async () => {
  sample = await loadDocSample<Sample>("README.md", "export const relay");
});

it("serves the QR code from the stored order, without collecting", () => {
  const order: OrderResponse = {
    orderRef: "131daac9-16c6-4618-beb0-365768f37288",
    autoStartToken: "7c40b5c9-fa74-49cf-b98c-bfe651f9a7c6",
    qrStartToken: "67df3917-fa0d-44e5-b327-edcc928297f8",
    qrStartSecret: "d28db9a7-4cde-429e-a983-359be676944c",
  };
  const startedAt = Date.now() - 3000;
  expect(sample.currentQrCode(order, startedAt)).toBe(
    qrCode(order, { startedAt }),
  );
});

it("relays a completed order without its completion data", async () => {
  const fake = createFakeBankId();
  holder.readmeBankId = createBankIdClient({
    environment: "test",
    transport: fake.transport,
  });
  const { orderRef } = await holder.readmeBankId.auth({
    endUserIp: "192.0.2.1",
  });
  expect(sample.relay(await sample.collectOnce(orderRef))).toEqual({
    status: "pending",
    hintCode: "outstandingTransaction",
  });
  await fake.complete(orderRef, { personalNumber: "190010101010" });
  const relayed = sample.relay(await sample.collectOnce(orderRef));
  expect(relayed).toEqual({ status: "complete" });
  expect(JSON.stringify(relayed)).not.toContain("190010101010");
  const failed = await holder.readmeBankId.auth({ endUserIp: "192.0.2.1" });
  await fake.fail(failed.orderRef, "userCancel");
  expect(sample.relay(await sample.collectOnce(failed.orderRef))).toEqual({
    status: "failed",
    hintCode: "userCancel",
  });
});
