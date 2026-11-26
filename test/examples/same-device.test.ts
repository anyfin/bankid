// Runs the same-device login sample in README.md itself: a matching nonce
// alone logs nobody in; the session must also hold the completed result of
// its own order.
import { beforeAll, expect, it } from "vitest";
import {
  createBankIdClient,
  type BankIdClient,
  type CollectResponse,
} from "../../src/index.ts";
import { createFakeBankId } from "../../src/testing/index.ts";
import { loadDocSample } from "./doc-sample.ts";

interface Session {
  orderRef: string;
  nonce: string;
  completed?: unknown;
}
interface Sample {
  startLogin: (
    endUserIp: string,
  ) => Promise<{ session: Session; autoStartToken: string }>;
  saveResult: (session: Session, result: CollectResponse) => void;
  finishLogin: (
    session: Session,
    returnedNonce: string | null,
  ) => { personalNumber?: string } | undefined;
}

const holder = globalThis as { readmeBankId?: BankIdClient };
let sample: Sample;

beforeAll(async () => {
  sample = await loadDocSample<Sample>(
    "README.md",
    "export function finishLogin",
  );
});

const setup = () => {
  const fake = createFakeBankId();
  holder.readmeBankId = createBankIdClient({
    environment: "test",
    transport: fake.transport,
  });
  return { fake, bankid: holder.readmeBankId };
};

it("logs the user in when the nonce matches and the order completed", async () => {
  const { fake, bankid } = setup();
  const { session } = await sample.startLogin("192.0.2.1");
  await fake.complete(session.orderRef, { personalNumber: "190010101010" });
  sample.saveResult(session, await bankid.collect(session.orderRef));
  expect(sample.finishLogin(session, session.nonce)).toMatchObject({
    personalNumber: "190010101010",
  });
  expect(sample.finishLogin(session, "another nonce")).toBeUndefined();
  expect(sample.finishLogin(session, null)).toBeUndefined();
});

it("refuses a matching nonce while the order has not completed", async () => {
  const { fake, bankid } = setup();
  const { session } = await sample.startLogin("192.0.2.1");
  expect(sample.finishLogin(session, session.nonce)).toBeUndefined();
  sample.saveResult(session, await bankid.collect(session.orderRef));
  expect(sample.finishLogin(session, session.nonce)).toBeUndefined();
  await fake.fail(session.orderRef, "userCancel");
  sample.saveResult(session, await bankid.collect(session.orderRef));
  expect(sample.finishLogin(session, session.nonce)).toBeUndefined();
});

it("does not take another order's result", async () => {
  const { fake, bankid } = setup();
  const { session } = await sample.startLogin("192.0.2.1");
  const other = await bankid.auth({ endUserIp: "192.0.2.1" });
  await fake.complete(other.orderRef, { personalNumber: "190010101010" });
  sample.saveResult(session, await bankid.collect(other.orderRef));
  expect(sample.finishLogin(session, session.nonce)).toBeUndefined();
});
