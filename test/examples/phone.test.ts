// Runs a phone flow like the one in README.md against the fake BankID. The
// README's samples themselves are type-checked by scripts/check-docs.mjs.
import { expect, it } from "vitest";
import {
  createBankIdClient,
  describe,
  type BankIdClient,
  type UserMessage,
} from "../../src/index.ts";
import { createFakeBankId } from "../../src/testing/index.ts";

/**
 * Identifies the person your agent is talking to. Tell them to open the
 * BankID app; the order is waiting there. Each message is the name of one of
 * BankID's recommended texts, such as RFA1 ("Start your BankID app").
 */
const identifyCaller = async (
  bankid: BankIdClient,
  personalNumber: string,
  showAgent: (message: UserMessage | undefined) => void,
): Promise<string | undefined> => {
  const { orderRef } = await bankid.phone.auth({
    callInitiator: "user", // "RP" when you called them
    personalNumber,
    userVisibleData: "You are identifying yourself to Example Bank",
  });
  for await (const result of bankid.watch(orderRef)) {
    showAgent(describe(result, { start: "phoneCall" }));
    if (result.status === "complete") return result.completionData.user?.name;
  }
  return undefined;
};

it("identifies a caller through the fake BankID", async () => {
  const fake = createFakeBankId({
    autoComplete: {
      afterMs: 0,
      user: { personalNumber: "190010101010", name: "Alex Johnson" },
    },
  });
  const bankid = createBankIdClient({
    environment: "test",
    transport: fake.transport,
  });
  const messages: (UserMessage | undefined)[] = [];
  const name = await identifyCaller(bankid, "190010101010", message =>
    messages.push(message),
  );
  expect(name).toBe("Alex Johnson");
  expect(messages).toEqual([undefined]);
});
