// Runs the rendering samples in README.md and docs/user-messages.md, which
// must show notSupportedByUserApp's own "update the app" case, since
// describe gives it the generic RFA22, and must have a text for every
// message describe can return.
import { expect, it } from "vitest";
import { describe, type CollectResponse } from "../../src/index.ts";
import { failedMessages, pendingMessages } from "../../src/shared/describe.ts";
import { loadDocSample } from "./doc-sample.ts";

const notSupported: CollectResponse = {
  orderRef: "ref",
  status: "failed",
  hintCode: "notSupportedByUserApp",
};
const cancelled: CollectResponse = {
  orderRef: "ref",
  status: "failed",
  hintCode: "userCancel",
};

it("describe gives notSupportedByUserApp no message of its own", () => {
  expect(describe(notSupported, { start: "qrCode" })).toBe("RFA22");
});

it("the user messages guide tells the user to update the app", async () => {
  const { messageFor } = await loadDocSample<{
    messageFor: (result: CollectResponse) => string | undefined;
  }>("docs/user-messages.md", "export function messageFor");
  expect(messageFor(notSupported)).toMatch(/update/i);
  expect(messageFor(cancelled)).toBe("The action was cancelled.");
});

it("the user messages guide has its own text for every known hint code", async () => {
  const { messageFor } = await loadDocSample<{
    messageFor: (result: CollectResponse) => string | undefined;
  }>("docs/user-messages.md", "export function messageFor");
  // RFA22's text, which a partial table hands to any message it lacks.
  const rfa22 = messageFor({
    orderRef: "ref",
    status: "failed",
    hintCode: "x",
  });
  const codes: [CollectResponse["status"], string[]][] = [
    ["pending", Object.keys(pendingMessages)],
    ["failed", Object.keys(failedMessages)],
  ];
  for (const [status, hintCodes] of codes)
    for (const hintCode of hintCodes) {
      const result = { orderRef: "ref", status, hintCode } as CollectResponse;
      const text = messageFor(result);
      expect(text, hintCode).toBeTypeOf("string");
      if (describe(result, { start: "qrCode" }) !== "RFA22")
        expect(text, hintCode).not.toBe(rfa22);
    }
});

it("the README singles out notSupportedByUserApp", async () => {
  const { messageName } = await loadDocSample<{
    messageName: (result: CollectResponse) => string | undefined;
  }>("README.md", "export function messageName");
  expect(messageName(notSupported)).toBe("updateApp");
  expect(messageName(cancelled)).toBe("RFA6");
});
