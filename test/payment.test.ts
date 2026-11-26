// Payment orders: the request bodies the client sends, the rules from BankID's
// spec and guides it checks before sending, and the same rules in the fake.
// Each rule's test names the spec schema and field (or guide) it comes from.
import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { components } from "../src/generated/auth-sign.ts";
import {
  BankIdApiError,
  createBankIdClient,
  describe as describeResult,
  qrCode,
  type BankIdOtherClient,
  type BankIdPaymentClient,
  type BankIdPhonePaymentClient,
  type BankIdTransportRequest,
  type BankIdTransportResponse,
  type BulkPayment,
  type BulkTransactionType,
  type CardTransaction,
  type Money,
  type OtherOrderResponse,
  type OtherPaymentRequest,
  type PaymentBulkRequest,
  type PaymentRequest,
  type RiskFlag,
  type RiskWarning,
  type TransactionType,
  type UserVisibleTransaction,
} from "../src/index.ts";
import { encodePayment, type PaymentPath } from "../src/payment.ts";
import { createFakeBankId } from "../src/testing/index.ts";

type Schemas = components["schemas"];

const orderRef = "131daac9-16c6-4618-beb0-365768f37288";
const order = {
  orderRef,
  autoStartToken: "7c40b5c9-fa74-49cf-b98c-bfe651f9a7c6",
  qrStartToken: "67df3917-fa0d-44e5-b327-edcc928297f8",
  qrStartSecret: "d28db9a7-4cde-429e-a983-359be676944c",
};
const personalNumber = "190010101010";
const endUserIp = "192.0.2.10";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const recording = (response: object = order) => {
  const requests: BankIdTransportRequest[] = [];
  const bankid = createBankIdClient({
    environment: "test",
    transport: async request => {
      requests.push(request);
      return { status: 200, body: JSON.stringify(response) };
    },
  });
  return { bankid, requests };
};

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

// Values that must never appear in an error message.
const sensitive = {
  merchant: "Kaffebaren Söder AB",
  payee: "Elbolaget i Norr",
  account: "5050-1055",
  amount: "1234,56",
};
const sek = (amount = sensitive.amount): Money => ({ amount, currency: "SEK" });

const transactions: Record<TransactionType, UserVisibleTransaction> = {
  card: {
    transactionType: "card",
    recipient: { name: sensitive.merchant },
    money: sek(),
    riskWarning: "largeAmount",
    recurring: true,
  },
  npa: { transactionType: "npa", recipient: { name: sensitive.merchant } },
  bankgiro: {
    transactionType: "bankgiro",
    recipient: { name: sensitive.payee, accountNumber: sensitive.account },
    money: sek(),
    date: "2026-12-01",
  },
  plusgiro: {
    transactionType: "plusgiro",
    recipient: { accountNumber: "123-4569" },
    money: sek("100"),
    date: "2026-12-01",
    riskWarning: "newRecipient",
  },
  samebank: {
    transactionType: "samebank",
    recipient: { name: "Åsa", accountNumber: "8862321312" },
    money: { amount: "66,22", currency: "NOK" },
    date: "2025-11-10",
  },
  domesticbank: {
    transactionType: "domesticbank",
    recipient: { accountNumber: "8327-9, 123 456 789-0" },
    money: sek("0"),
    date: "2026-02-28",
  },
  foreignbank: {
    transactionType: "foreignbank",
    recipient: { name: "Müller GmbH", accountNumber: "DE89370400440532013000" },
    money: { amount: "9900,01", currency: "EUR" },
    date: "2028-02-29",
    riskWarning: "overseasTransaction",
  },
  direct: {
    transactionType: "direct",
    recipient: { legalName: "Betal AB", phoneNumber: "+46 (0)70-123 45 67" },
    money: { amount: "9900,01", currency: "USD" },
    thirdPartyInitiator: "Tredje part",
  },
};

/** The transaction as BankID expects it, with names under their B64 fields. */
const wireTransactions: Record<TransactionType, Record<string, unknown>> = {
  card: {
    transactionType: "card",
    recipient: { nameB64: b64(sensitive.merchant) },
    money: sek(),
    riskWarning: "largeAmount",
    recurring: true,
  },
  npa: {
    transactionType: "npa",
    recipient: { nameB64: b64(sensitive.merchant) },
  },
  bankgiro: {
    transactionType: "bankgiro",
    recipient: {
      nameB64: b64(sensitive.payee),
      accountNumber: sensitive.account,
    },
    money: sek(),
    date: "2026-12-01",
  },
  plusgiro: {
    transactionType: "plusgiro",
    recipient: { accountNumber: "123-4569" },
    money: sek("100"),
    date: "2026-12-01",
    riskWarning: "newRecipient",
  },
  samebank: {
    transactionType: "samebank",
    recipient: { nameB64: "w4VzYQ==", accountNumber: "8862321312" },
    money: { amount: "66,22", currency: "NOK" },
    date: "2025-11-10",
  },
  domesticbank: {
    transactionType: "domesticbank",
    recipient: { accountNumber: "8327-9, 123 456 789-0" },
    money: sek("0"),
    date: "2026-02-28",
  },
  foreignbank: {
    transactionType: "foreignbank",
    recipient: {
      nameB64: b64("Müller GmbH"),
      accountNumber: "DE89370400440532013000",
    },
    money: { amount: "9900,01", currency: "EUR" },
    date: "2028-02-29",
    riskWarning: "overseasTransaction",
  },
  direct: {
    transactionType: "direct",
    recipient: {
      legalNameB64: b64("Betal AB"),
      phoneNumber: "+46 (0)70-123 45 67",
    },
    money: { amount: "9900,01", currency: "USD" },
    thirdPartyInitiatorB64: b64("Tredje part"),
  },
};

const bulkPayment = (overrides: Partial<BulkPayment> = {}): BulkPayment => ({
  transactionType: "bankgiro",
  recipient: { name: sensitive.payee, accountNumber: sensitive.account },
  money: sek(),
  date: "2026-12-01",
  ...overrides,
});

const bulk: PaymentBulkRequest = {
  endUserIp,
  userVisibleData: "Fakturor december",
  userVisibleTransactionBulk: {
    payments: [
      bulkPayment({
        fromAccount: { name: "Lönekonto" },
        riskWarning: "largeAmount",
        riskFlags: ["newRecipient", "largeAmount"],
      }),
      bulkPayment({
        transactionType: "plusgiro",
        recipient: { accountNumber: "123-4569" },
        fromAccount: { accountNumber: "12312313" },
      }),
    ],
    sums: [sek("2469,12")],
    thirdPartyInitiator: "Tredje part",
  },
};

const wireBulk = {
  endUserIp,
  userVisibleData: b64("Fakturor december"),
  userVisibleTransactionBulk: {
    payments: [
      {
        transactionType: "bankgiro",
        recipient: {
          nameB64: b64(sensitive.payee),
          accountNumber: sensitive.account,
        },
        money: sek(),
        date: "2026-12-01",
        fromAccount: { nameB64: b64("Lönekonto") },
        riskWarning: "largeAmount",
        riskFlags: ["newRecipient", "largeAmount"],
      },
      {
        transactionType: "plusgiro",
        recipient: { accountNumber: "123-4569" },
        money: sek(),
        date: "2026-12-01",
        fromAccount: { accountNumber: "12312313" },
      },
    ],
    sums: [sek("2469,12")],
    thirdPartyInitiatorB64: b64("Tredje part"),
  },
};

describe("payment request bodies", () => {
  it.each(Object.keys(transactions) as TransactionType[])(
    "posts a %s payment to /payment with names base64-encoded",
    async type => {
      const { bankid, requests } = recording();
      const result = await bankid.payment({
        endUserIp,
        userVisibleData: "Köp hos Kaffebaren",
        userVisibleTransaction: transactions[type],
      });
      expect(result).toEqual(order);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/payment");
      expect(requests[0]?.body).toStrictEqual({
        endUserIp,
        userVisibleData: b64("Köp hos Kaffebaren"),
        userVisibleTransaction: wireTransactions[type],
      });
    },
  );

  it("posts every /payment field the spec defines", async () => {
    const { bankid, requests } = recording();
    await bankid.payment({
      endUserIp,
      returnUrl: "https://example.com/pay#nonce=1",
      returnRisk: true,
      riskFlags: ["newCard", "newCustomer", "suspiciousPaymentPattern"],
      userVisibleData: "# Köp",
      userVisibleDataFormat: "simpleMarkdownV1",
      userNonVisibleData: "id=ö",
      userVisibleTransaction: transactions.card,
      web: { referringDomain: "example.com" },
      requirement: { personalNumber, stepUp: ["mrtd", "face"] },
    });
    expect(requests[0]?.body).toStrictEqual({
      endUserIp,
      returnUrl: "https://example.com/pay#nonce=1",
      returnRisk: true,
      riskFlags: ["newCard", "newCustomer", "suspiciousPaymentPattern"],
      userVisibleData: "IyBLw7Zw",
      userVisibleDataFormat: "simpleMarkdownV1",
      userNonVisibleData: "aWQ9w7Y=",
      userVisibleTransaction: wireTransactions.card,
      web: { referringDomain: "example.com" },
      requirement: { personalNumber, stepUp: ["mrtd", "face"] },
    });
  });

  it("posts a bulk payment to /payment/bulk", async () => {
    const { bankid, requests } = recording();
    expect(await bankid.payment.bulk(bulk)).toEqual(order);
    expect(requests[0]?.path).toBe("/payment/bulk");
    expect(requests[0]?.body).toStrictEqual(wireBulk);
  });

  it.each(["user", "RP"] as const)(
    "posts a phone payment to /phone/payment with callInitiator %s",
    async callInitiator => {
      const { bankid, requests } = recording({ orderRef });
      const result = await bankid.phone.payment({
        callInitiator,
        personalNumber,
        riskFlags: ["moneyTransfer"],
        userVisibleData: "Överföring",
        userVisibleDataFormat: "plaintext",
        userVisibleTransaction: transactions.direct,
        requirement: { pinCode: true },
      });
      expect(result).toEqual({ orderRef });
      expect(requests[0]?.path).toBe("/phone/payment");
      expect(requests[0]?.body).toStrictEqual({
        callInitiator,
        personalNumber,
        riskFlags: ["moneyTransfer"],
        userVisibleData: b64("Överföring"),
        userVisibleDataFormat: "plaintext",
        userVisibleTransaction: wireTransactions.direct,
        requirement: { pinCode: true },
      });
    },
  );

  it("posts a phone bulk payment to /phone/payment/bulk", async () => {
    const { bankid, requests } = recording({ orderRef });
    const { endUserIp: _, ...rest } = bulk;
    const { endUserIp: __, ...wireRest } = wireBulk;
    await bankid.phone.payment.bulk({
      ...rest,
      callInitiator: "RP",
      personalNumber,
    });
    expect(requests[0]?.path).toBe("/phone/payment/bulk");
    expect(requests[0]?.body).toStrictEqual({
      ...wireRest,
      callInitiator: "RP",
      personalNumber,
    });
  });

  it.each(["card", "npa"] as const)(
    "posts a %s payment to /other/payment",
    async type => {
      const { bankid, requests } = recording({ orderRef });
      const request: OtherPaymentRequest = {
        personalNumber,
        returnRisk: true,
        userVisibleTransaction: transactions[type] as CardTransaction,
      };
      expect(await bankid.other.payment(request)).toEqual({ orderRef });
      expect(requests[0]?.path).toBe("/other/payment");
      expect(requests[0]?.body).toStrictEqual({
        personalNumber,
        returnRisk: true,
        userVisibleTransaction: wireTransactions[type],
      });
    },
  );

  it("leaves the caller's request unchanged", async () => {
    const { bankid } = recording();
    const request: PaymentRequest = {
      endUserIp,
      userVisibleTransaction: transactions.direct,
    };
    const copy = structuredClone(request);
    await bankid.payment(request);
    expect(request).toStrictEqual(copy);
    await bankid.payment.bulk(bulk);
  });

  it("passes unknown fields through, for fields BankID adds later", async () => {
    const { bankid, requests } = recording();
    await bankid.payment({
      endUserIp,
      userVisibleTransaction: {
        ...transactions.card,
        newField: 1,
      } as never,
    });
    expect(requests[0]?.body.userVisibleTransaction).toMatchObject({
      newField: 1,
    });
  });

  it("turns an error response into a BankIdApiError with the payment path", async () => {
    const bankid = createBankIdClient({
      environment: "test",
      transport: async () => ({
        status: 400,
        body: '{"errorCode":"invalidParameters","details":"Incorrect x"}',
      }),
    });
    const error = await rejection(bankid.payment.bulk(bulk));
    expect(error).toBeInstanceOf(BankIdApiError);
    expect(error).toMatchObject({ path: "/payment/bulk" });
  });
});

type Method =
  | "payment"
  | "payment.bulk"
  | "phone.payment"
  | "phone.payment.bulk"
  | "other.payment";

const paths: Record<Method, PaymentPath> = {
  payment: "/payment",
  "payment.bulk": "/payment/bulk",
  "phone.payment": "/phone/payment",
  "phone.payment.bulk": "/phone/payment/bulk",
  "other.payment": "/other/payment",
};

const base: Record<Method, Record<string, unknown>> = {
  payment: { endUserIp, userVisibleTransaction: transactions.card },
  "payment.bulk": {
    endUserIp,
    userVisibleTransactionBulk: bulk.userVisibleTransactionBulk,
  },
  "phone.payment": {
    callInitiator: "user",
    personalNumber,
    userVisibleTransaction: transactions.card,
  },
  "phone.payment.bulk": {
    callInitiator: "user",
    personalNumber,
    userVisibleTransactionBulk: bulk.userVisibleTransactionBulk,
  },
  "other.payment": {
    personalNumber,
    userVisibleTransaction: transactions.card,
  },
};

const send = (
  bankid: ReturnType<typeof createBankIdClient>,
  method: Method,
  request: Record<string, unknown>,
): Promise<unknown> => {
  const anyRequest = request as never;
  switch (method) {
    case "payment":
      return bankid.payment(anyRequest);
    case "payment.bulk":
      return bankid.payment.bulk(anyRequest);
    case "phone.payment":
      return bankid.phone.payment(anyRequest);
    case "phone.payment.bulk":
      return bankid.phone.payment.bulk(anyRequest);
    case "other.payment":
      return bankid.other.payment(anyRequest);
  }
};

const withTransaction = (transaction: object, method: Method = "payment") => ({
  ...base[method],
  userVisibleTransaction: transaction,
});

const withBulk = (
  changes: Record<string, unknown>,
  method: Method = "payment.bulk",
) => ({
  ...base[method],
  userVisibleTransactionBulk: {
    ...bulk.userVisibleTransactionBulk,
    ...changes,
  },
});

const withBulkPayment = (payment: Record<string, unknown>) =>
  withBulk({ payments: [payment] });

const without = (transaction: object, field: string) => {
  const copy: Record<string, unknown> = { ...transaction };
  delete copy[field];
  return copy;
};
const transfers = [
  "bankgiro",
  "plusgiro",
  "samebank",
  "domesticbank",
  "foreignbank",
] as const;

/**
 * One rule each: the spec field or guide it comes from, the method, a request
 * that breaks it, and the field and rule the error names. `field` is as the
 * public types spell it; the fake's details use the spec's names.
 */
const rules: {
  source: string;
  method: Method;
  request: Record<string, unknown>;
  field: string;
  reason: string;
}[] = [
  ...(
    [
      ["payment", "endUserIp"],
      ["payment.bulk", "endUserIp"],
      ["phone.payment", "callInitiator"],
      ["phone.payment", "personalNumber"],
      ["phone.payment.bulk", "callInitiator"],
      ["phone.payment.bulk", "personalNumber"],
      ["other.payment", "personalNumber"],
    ] as const
  ).map(([method, field]) => ({
    source: `${method} request required: ${field}`,
    method,
    request: Object.fromEntries(
      Object.entries(base[method]).filter(([name]) => name !== field),
    ),
    field,
    reason: "is required",
  })),
  ...(["payment", "payment.bulk"] as const).map(method => ({
    source: `${method} request: endUserIp is an IPv4 or IPv6 address`,
    method,
    request: { ...base[method], endUserIp: "not-an-address" },
    field: "endUserIp",
    reason: "must be an IPv4 or IPv6 address",
  })),
  ...(["phone.payment", "phone.payment.bulk"] as const).map(method => ({
    source: `${method} request: callInitiator enum`,
    method,
    request: { ...base[method], callInitiator: "bank" },
    field: "callInitiator",
    reason: 'must be "user" or "RP"',
  })),
  ...(["phone.payment", "other.payment"] as const).map(method => ({
    source: `${method} request: personalNumber pattern`,
    method,
    request: { ...base[method], personalNumber: "19001010-1010" },
    field: "personalNumber",
    reason: "must be 12 digits",
  })),
  {
    source: "payment_request required: userVisibleTransaction",
    method: "payment",
    request: { endUserIp },
    field: "userVisibleTransaction",
    reason: "is required",
  },
  {
    source: "UserVisibleTransactionParentType.transactionType enum",
    method: "payment",
    request: withTransaction({ ...transactions.card, transactionType: "cash" }),
    field: "userVisibleTransaction.transactionType",
    reason:
      "must be card, npa, bankgiro, plusgiro, samebank, domesticbank, foreignbank or direct on this endpoint",
  },
  ...(
    [
      "bankgiro",
      "plusgiro",
      "samebank",
      "domesticbank",
      "foreignbank",
      "direct",
    ] as const
  ).map(type => ({
    source: `otherPayment_request.userVisibleTransaction is UserVisibleTransactionCardNpa: no ${type}`,
    method: "other.payment" as const,
    request: withTransaction(transactions[type], "other.payment"),
    field: "userVisibleTransaction.transactionType",
    reason: "must be card or npa on this endpoint",
  })),
  {
    source: "Npa has no money; Money: not allowed when transactionType is npa",
    method: "payment",
    request: withTransaction({ ...transactions.npa, money: sek() }),
    field: "userVisibleTransaction.money",
    reason: "is not allowed for transactionType npa",
  },
  ...[...transfers, "direct" as const].map(type => ({
    source: `${type} required: money`,
    method: "phone.payment" as const,
    request: withTransaction(
      without(transactions[type], "money"),
      "phone.payment",
    ),
    field: "userVisibleTransaction.money",
    reason: `is required for transactionType ${type}`,
  })),
  ...transfers.map(type => ({
    source: `${type} required: date`,
    method: "payment" as const,
    request: withTransaction(without(transactions[type], "date")),
    field: "userVisibleTransaction.date",
    reason: `is required for transactionType ${type}`,
  })),
  {
    source: "Card required: recipient",
    method: "payment",
    request: withTransaction(without(transactions.card, "recipient")),
    field: "userVisibleTransaction.recipient",
    reason: "is required",
  },
  {
    source: "RecipientCard: exactly one of name and nameB64",
    method: "other.payment",
    request: withTransaction(
      { ...transactions.card, recipient: {} },
      "other.payment",
    ),
    field: "userVisibleTransaction.recipient.name",
    reason: "is required",
  },
  {
    source: "RecipientNpa: exactly one of name and nameB64",
    method: "payment",
    request: withTransaction({ ...transactions.npa, recipient: {} }),
    field: "userVisibleTransaction.recipient.name",
    reason: "is required",
  },
  {
    source: "RecipientCommon.nameB64: at most 40 unicode code points",
    method: "payment",
    request: withTransaction({
      ...transactions.card,
      recipient: { name: `${sensitive.merchant}${"x".repeat(41)}` },
    }),
    field: "userVisibleTransaction.recipient.name",
    reason: "must be at most 40 characters",
  },
  {
    source: "RecipientCommon.nameB64: maxLength 215",
    method: "payment",
    request: withTransaction({
      ...transactions.card,
      recipient: { name: "🙂".repeat(40) },
    }),
    field: "userVisibleTransaction.recipient.name",
    reason: "must be at most 215 characters once base64-encoded",
  },
  {
    source: "RecipientCommon.nameB64: minLength 1",
    method: "payment",
    request: withTransaction({ ...transactions.card, recipient: { name: "" } }),
    field: "userVisibleTransaction.recipient.name",
    reason: "must not be empty",
  },
  ...transfers.map(type => ({
    source: `Recipient${type} required: accountNumber`,
    method: "payment" as const,
    request: withTransaction({
      ...transactions[type],
      recipient: { name: sensitive.payee },
    }),
    field: "userVisibleTransaction.recipient.accountNumber",
    reason: "is required",
  })),
  {
    source: "RecipientBankgiro.accountNumber pattern ^[A-Z0-9.,() -]+$",
    method: "payment",
    request: withTransaction({
      ...transactions.bankgiro,
      recipient: { accountNumber: "se45-5000" },
    }),
    field: "userVisibleTransaction.recipient.accountNumber",
    reason:
      "must be 1 to 42 characters, each A-Z, 0-9, space or one of . , ( ) -",
  },
  {
    source: "RecipientForeignBank.accountNumber maxLength 42",
    method: "payment",
    request: withTransaction({
      ...transactions.foreignbank,
      recipient: { accountNumber: "1".repeat(43) },
    }),
    field: "userVisibleTransaction.recipient.accountNumber",
    reason:
      "must be 1 to 42 characters, each A-Z, 0-9, space or one of . , ( ) -",
  },
  {
    source:
      "RecipientDirect: at least one of nameB64, legalNameB64, account or phone",
    method: "payment",
    request: withTransaction({ ...transactions.direct, recipient: {} }),
    field: "userVisibleTransaction.recipient",
    reason:
      "needs at least one of name, legalName, accountNumber and phoneNumber",
  },
  {
    source: "RecipientDirect.phoneNumber pattern ^[\\d() +-]*$",
    method: "payment",
    request: withTransaction({
      ...transactions.direct,
      recipient: { phoneNumber: "070 123 45 6x" },
    }),
    field: "userVisibleTransaction.recipient.phoneNumber",
    reason: "must be 1 to 25 characters, each a digit, space or one of ( ) + -",
  },
  {
    source: "RecipientDirect.phoneNumber maxLength 25",
    method: "payment",
    request: withTransaction({
      ...transactions.direct,
      recipient: { phoneNumber: "1".repeat(26) },
    }),
    field: "userVisibleTransaction.recipient.phoneNumber",
    reason: "must be 1 to 25 characters, each a digit, space or one of ( ) + -",
  },
  {
    source: "RecipientDirect.legalNameB64: at most 40 unicode code points",
    method: "payment",
    request: withTransaction({
      ...transactions.direct,
      recipient: { legalName: "x".repeat(41) },
    }),
    field: "userVisibleTransaction.recipient.legalName",
    reason: "must be at most 40 characters",
  },
  ...["100.00", "1,00,0", "", "12a", ",", "1".repeat(49)].map(amount => ({
    source: `Money.amount: one "," decimal separator, the rest numbers, maxLength 48 (${JSON.stringify(amount).slice(0, 12)})`,
    method: "payment" as const,
    request: withTransaction({ ...transactions.card, money: sek(amount) }),
    field: "userVisibleTransaction.money.amount",
    reason:
      'must be digits with at most one "," as decimal separator, at most 48 characters',
  })),
  ...["sek", "SEKR", "SE", ""].map(currency => ({
    source: `Money.currency: ISO 4217 alphabetic code, length 3 (${JSON.stringify(currency)})`,
    method: "payment" as const,
    request: withTransaction({
      ...transactions.card,
      money: { amount: "1", currency },
    }),
    field: "userVisibleTransaction.money.currency",
    reason: "must be an ISO 4217 alphabetic currency code, such as SEK",
  })),
  {
    source: "Card.money is a Money object",
    method: "payment",
    request: withTransaction({ ...transactions.card, money: "100 SEK" }),
    field: "userVisibleTransaction.money",
    reason: "must be an object with amount and currency",
  },
  ...["2026-13-01", "2026-02-29", "01/12/2026", "2026-12-1"].map(date => ({
    source: `UserVisibleTransactionParentType.date: format date, YYYY-MM-DD (${date})`,
    method: "payment" as const,
    request: withTransaction({ ...transactions.bankgiro, date }),
    field: "userVisibleTransaction.date",
    reason: "must be a date written YYYY-MM-DD",
  })),
  ...(["payment", "payment.bulk", "other.payment"] as const).flatMap(method =>
    ["", "x".repeat(513), 7].map(returnUrl => ({
      source: `returnUrl: minLength 1, maxLength 512 (${method}, ${String(returnUrl).length} characters)`,
      method,
      request: { ...base[method], returnUrl },
      field: "returnUrl",
      reason: "must be a string of 1 to 512 characters",
    })),
  ),
  {
    source: "riskWarning enum",
    method: "payment",
    request: withTransaction({ ...transactions.card, riskWarning: "scary" }),
    field: "userVisibleTransaction.riskWarning",
    reason:
      "must be one of newRecipient, largeAmount, foreignCurrency, cryptoCurrencyPurchase, moneyTransfer, overseasTransaction, recurringPayment, partialNameMatch, noNameMatch or other",
  },
  {
    source: "UserVisibleTransactionParentType.recurring: boolean",
    method: "payment",
    request: withTransaction({ ...transactions.card, recurring: "yes" }),
    field: "userVisibleTransaction.recurring",
    reason: "must be a boolean",
  },
  {
    source:
      "UserVisibleTransactionParentType.thirdPartyInitiatorB64: at most 40 unicode code points",
    method: "payment",
    request: withTransaction({
      ...transactions.direct,
      thirdPartyInitiator: "x".repeat(41),
    }),
    field: "userVisibleTransaction.thirdPartyInitiator",
    reason: "must be at most 40 characters",
  },
  {
    source: "payment_request.riskFlags items enum",
    method: "payment",
    request: { ...base.payment, riskFlags: ["newCard", "unheardOf"] },
    field: "riskFlags",
    reason:
      "may only hold newCard, newCustomer, newRecipient, highRiskRecipient, largeAmount, foreignCurrency, cryptoCurrencyPurchase, moneyTransfer, overseasTransaction, recurringPayment, suspiciousPaymentPattern, partialNameMatch, noNameMatch or other",
  },
  {
    source: "otherPayment_request.riskFlags: array",
    method: "other.payment",
    request: { ...base["other.payment"], riskFlags: "newCard" },
    field: "riskFlags",
    reason: "must be an array",
  },
  {
    source: "userVisibleData_payment maxLength 1000",
    method: "phone.payment",
    request: { ...base["phone.payment"], userVisibleData: "x".repeat(751) },
    field: "userVisibleData",
    reason: "must be at most 1000 characters once base64-encoded",
  },
  {
    source: "userVisibleData_payment minLength 1",
    method: "other.payment",
    request: { ...base["other.payment"], userVisibleData: "" },
    field: "userVisibleData",
    reason: "must not be empty",
  },
  {
    source: "userNonVisibleData_payment maxLength 1000",
    method: "payment.bulk",
    request: { ...base["payment.bulk"], userNonVisibleData: "x".repeat(751) },
    field: "userNonVisibleData",
    reason: "must be at most 1000 characters once base64-encoded",
  },
  {
    source: "paymentBulk_request required: userVisibleTransactionBulk",
    method: "payment.bulk",
    request: { endUserIp },
    field: "userVisibleTransactionBulk",
    reason: "is required",
  },
  {
    source: "UserVisibleTransactionBulk.payments minItems 1",
    method: "payment.bulk",
    request: withBulk({ payments: [] }),
    field: "userVisibleTransactionBulk.payments",
    reason: "must be an array of 1 to 40 payments",
  },
  {
    source: "UserVisibleTransactionBulk.payments maxItems 40",
    method: "phone.payment.bulk",
    request: withBulk(
      { payments: Array.from({ length: 41 }, () => bulkPayment()) },
      "phone.payment.bulk",
    ),
    field: "userVisibleTransactionBulk.payments",
    reason: "must be an array of 1 to 40 payments",
  },
  {
    source: "UserVisibleTransactionBulk.sums minItems 1",
    method: "payment.bulk",
    request: withBulk({ sums: [] }),
    field: "userVisibleTransactionBulk.sums",
    reason: "must be an array of 1 to 4 sums",
  },
  {
    source: "UserVisibleTransactionBulk.sums maxItems 4",
    method: "payment.bulk",
    request: withBulk({ sums: Array.from({ length: 5 }, () => sek()) }),
    field: "userVisibleTransactionBulk.sums",
    reason: "must be an array of 1 to 4 sums",
  },
  {
    source: "UserVisibleTransactionBulk.sums items are Money",
    method: "payment.bulk",
    request: withBulk({ sums: [sek(), { amount: "1", currency: "kr" }] }),
    field: "userVisibleTransactionBulk.sums[1].currency",
    reason: "must be an ISO 4217 alphabetic currency code, such as SEK",
  },
  {
    source: "UserVisibleTransactionBulk required: sums",
    method: "payment.bulk",
    request: withBulk({ sums: undefined }),
    field: "userVisibleTransactionBulk.sums",
    reason: "is required",
  },
  ...(["card", "npa", "direct"] as const).map(type => ({
    source: `TransactionBulk.transactionType enum: no ${type}`,
    method: "payment.bulk" as const,
    request: withBulkPayment({ ...bulkPayment(), transactionType: type }),
    field: "userVisibleTransactionBulk.payments[0].transactionType",
    reason:
      "must be bankgiro, plusgiro, samebank, domesticbank or foreignbank in a bulk payment",
  })),
  {
    source: "TransactionBulk required: date",
    method: "payment.bulk",
    request: withBulkPayment(without(bulkPayment(), "date")),
    field: "userVisibleTransactionBulk.payments[0].date",
    reason: "is required",
  },
  {
    source: "TransactionBulk required: money",
    method: "payment.bulk",
    request: withBulk({
      payments: [bulkPayment(), without(bulkPayment(), "money")],
    }),
    field: "userVisibleTransactionBulk.payments[1].money",
    reason: "is required",
  },
  {
    source: "RecipientGenericBulk required: accountNumber",
    method: "payment.bulk",
    request: withBulkPayment({
      ...bulkPayment(),
      recipient: { name: sensitive.payee },
    }),
    field: "userVisibleTransactionBulk.payments[0].recipient.accountNumber",
    reason: "is required",
  },
  {
    source: "fromAccount: either nameB64 or accountNumber is required",
    method: "payment.bulk",
    request: withBulkPayment({ ...bulkPayment(), fromAccount: {} }),
    field: "userVisibleTransactionBulk.payments[0].fromAccount",
    reason: "needs name or accountNumber, not both",
  },
  {
    source: "fromAccount: BankID rejects nameB64 together with accountNumber",
    method: "payment.bulk",
    request: withBulkPayment({
      ...bulkPayment(),
      fromAccount: { name: "Lönekonto", accountNumber: "12312313" },
    }),
    field: "userVisibleTransactionBulk.payments[0].fromAccount",
    reason: "needs name or accountNumber, not both",
  },
  {
    source: "fromAccount.accountNumber pattern ^[A-Z0-9.,() -]+$",
    method: "payment.bulk",
    request: withBulkPayment({
      ...bulkPayment(),
      fromAccount: { accountNumber: "konto 1" },
    }),
    field: "userVisibleTransactionBulk.payments[0].fromAccount.accountNumber",
    reason:
      "must be 1 to 42 characters, each A-Z, 0-9, space or one of . , ( ) -",
  },
  {
    source: "UserVisibleTransactionBulk_payments_inner.riskFlags enum",
    method: "payment.bulk",
    request: withBulkPayment({ ...bulkPayment(), riskFlags: ["nope"] }),
    field: "userVisibleTransactionBulk.payments[0].riskFlags",
    reason:
      "may only hold newCard, newCustomer, newRecipient, highRiskRecipient, largeAmount, foreignCurrency, cryptoCurrencyPurchase, moneyTransfer, overseasTransaction, recurringPayment, suspiciousPaymentPattern, partialNameMatch, noNameMatch or other",
  },
  {
    source:
      "guides: bulk payments do not support recurring payments; TransactionBulk has no recurring",
    method: "payment.bulk",
    request: withBulkPayment({ ...bulkPayment(), recurring: false }),
    field: "userVisibleTransactionBulk.payments[0].recurring",
    reason: "is not supported in a bulk payment",
  },
  {
    source:
      "guides: bulk payments support text but not formatting; no userVisibleDataFormat in paymentBulk_request",
    method: "payment.bulk",
    request: { ...base["payment.bulk"], userVisibleDataFormat: "plaintext" },
    field: "userVisibleDataFormat",
    reason: "is not supported for bulk payments",
  },
  {
    source:
      "guides: no formatting in bulk; no userVisibleDataFormat in phonePaymentBulk_request",
    method: "phone.payment.bulk",
    request: {
      ...base["phone.payment.bulk"],
      userVisibleDataFormat: "simpleMarkdownV1",
    },
    field: "userVisibleDataFormat",
    reason: "is not supported for bulk payments",
  },
  {
    source:
      "UserVisibleTransactionBulk.thirdPartyInitiatorB64: at most 40 unicode code points",
    method: "payment.bulk",
    request: withBulk({ thirdPartyInitiator: "x".repeat(41) }),
    field: "userVisibleTransactionBulk.thirdPartyInitiator",
    reason: "must be at most 40 characters",
  },
];

/** The spec's name for a field the public types spell without `B64`. */
const specName = (field: string) =>
  field.replace(/\b(name|legalName|thirdPartyInitiator)$/, "$1B64");

describe("payment rules", () => {
  describe.each(rules)("$source", ({ method, request, field, reason }) => {
    it(`the client refuses it before sending: ${field} ${reason}`, async () => {
      const { bankid, requests } = recording();
      const error = await rejection(send(bankid, method, request));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`${method}: ${field} ${reason}`);
      for (const value of Object.values(sensitive))
        expect((error as Error).message).not.toContain(value);
      expect(requests).toHaveLength(0);
    });

    it("the fake refuses it with invalidParameters", async () => {
      const fake = createFakeBankId();
      const response = await fake.transport({
        method: "POST",
        path: paths[method],
        body: encodePayment(request),
        signal: new AbortController().signal,
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body as string)).toStrictEqual({
        errorCode: "invalidParameters",
        details: `Incorrect ${specName(field)}`,
      });
    });
  });

  it("accepts the limits themselves", async () => {
    const fake = createFakeBankId();
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    await bankid.payment.bulk(
      withBulk({
        payments: Array.from({ length: 40 }, () => bulkPayment()),
        sums: Array.from({ length: 4 }, () => sek()),
        thirdPartyInitiator: "x".repeat(40),
      }) as never,
    );
    await bankid.payment({
      endUserIp,
      returnUrl: `https://example.com/${"x".repeat(492)}`,
      userVisibleData: "x".repeat(750),
      userNonVisibleData: "x".repeat(750),
      riskFlags: [],
      userVisibleTransaction: {
        transactionType: "card",
        recipient: { name: "x".repeat(40) },
        money: { amount: "1".repeat(48), currency: "SEK" },
        thirdPartyInitiator: "Å".repeat(40),
      },
    });
    for (const amount of ["0", "100", "100,000", "1000,00", "5,", ",5"])
      await bankid.payment({
        endUserIp,
        userVisibleTransaction: {
          ...(transactions.card as CardTransaction),
          money: sek(amount),
        },
      });
    await bankid.payment({
      endUserIp,
      userVisibleTransaction: {
        transactionType: "direct",
        recipient: { accountNumber: "A".repeat(42) },
        money: sek(),
      },
    });
  });

  it("checks every payment in a bulk, naming its index", async () => {
    const { bankid } = recording();
    const payments = [bulkPayment(), bulkPayment(), bulkPayment({ date: "x" })];
    const error = await rejection(
      bankid.payment.bulk({
        ...bulk,
        userVisibleTransactionBulk: {
          ...bulk.userVisibleTransactionBulk,
          payments,
        },
      }),
    );
    expect((error as Error).message).toBe(
      "payment.bulk: userVisibleTransactionBulk.payments[2].date must be a date written YYYY-MM-DD",
    );
  });

  it("refuses names given in their encoded form, since it encodes them itself", async () => {
    const { bankid } = recording();
    const error = await rejection(
      bankid.payment(
        withTransaction({
          ...transactions.card,
          recipient: { nameB64: b64(sensitive.merchant) },
        }) as never,
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "payment: userVisibleTransaction.recipient.nameB64 is not accepted: pass userVisibleTransaction.recipient.name as plain text and the library encodes it",
    );
    await expect(
      bankid.payment.bulk(
        withBulk({ thirdPartyInitiatorB64: b64("x") }) as never,
      ),
    ).rejects.toThrow("thirdPartyInitiatorB64 is not accepted");
  });

  it("refuses text fields that are not strings", async () => {
    const { bankid } = recording();
    await expect(
      bankid.payment(
        withTransaction({
          ...transactions.card,
          recipient: { name: 7 },
        }) as never,
      ),
    ).rejects.toThrow(
      new TypeError(
        "payment: userVisibleTransaction.recipient.name must be a string",
      ),
    );
    await expect(
      bankid.other.payment({
        ...base["other.payment"],
        userVisibleData: 7,
      } as never),
    ).rejects.toThrow(
      new TypeError("other.payment: userVisibleData must be a string"),
    );
    await expect(bankid.payment(null as never)).rejects.toThrow(
      new TypeError("payment needs a request object"),
    );
    await expect(
      bankid.payment(withTransaction("card" as never) as never),
    ).rejects.toThrow("payment: userVisibleTransaction must be an object");
  });
});

describe("the fake's own checks on payment requests", () => {
  const post = (path: PaymentPath, body: Record<string, unknown>) =>
    createFakeBankId()
      .transport({
        method: "POST",
        path,
        body,
        signal: new AbortController().signal,
      })
      .then((response: BankIdTransportResponse) => ({
        status: response.status,
        body: JSON.parse(response.body as string) as Record<string, unknown>,
      }));

  it("accepts the request examples in BankID's spec", async () => {
    // From the spec's examples for /payment (request), /payment/bulk and
    // /other/payment (stepUp, which uses the plain `name`).
    const examples: [PaymentPath, Record<string, unknown>][] = [
      [
        "/payment",
        {
          endUserIp: "192.168.1.2",
          returnUrl:
            "https://bankid.example/auth/login_page#nonce=a3618c72-bc71-4002-b3de-509555b175db",
          returnRisk: true,
          riskFlags: ["largeAmount", "newCustomer", "newCard"],
          userVisibleTransaction: {
            transactionType: "card",
            recipient: { nameB64: "UGF5bWVudCBSZWNpcGllbnRzIEluYy4=" },
            money: { amount: "100,00", currency: "EUR" },
            riskWarning: "largeAmount",
          },
          userVisibleData: "IFRoaXMgaXMgYSBzYW1wbGUgdGV4dCB0byBiZSBzaWduZWQ=",
          userVisibleDataFormat: "simpleMarkdownV1",
          userNonVisibleData:
            "VGV4dCBpbmNsdWRlZCBidXQgbm90IGRpc3BsYXllZCB0byB0aGUgdXNlcg==",
        },
      ],
      [
        "/payment/bulk",
        {
          endUserIp: "192.168.1.2",
          returnRisk: true,
          userVisibleTransactionBulk: {
            payments: [
              {
                transactionType: "plusgiro",
                recipient: {
                  nameB64: "UGF5bWVudCBSZWNpcGllbnRzIEluYy4=",
                  accountNumber: "123-4569",
                },
                money: { amount: "100,00", currency: "SEK" },
                riskWarning: "largeAmount",
                date: "2025-11-10",
              },
              {
                transactionType: "bankgiro",
                recipient: {
                  nameB64: "UGF5bWVudCBSZWNpcGllbnRzIEJhbmtnaXJvIEluYy4=",
                  accountNumber: "1234-1234",
                },
                fromAccount: { accountNumber: "12312313" },
                money: { amount: "100,00", currency: "SEK" },
                riskWarning: "largeAmount",
                date: "2025-11-10",
                riskFlags: ["largeAmount", "newCustomer", "newCard"],
              },
            ],
            sums: [{ amount: "200,00", currency: "SEK" }],
            thirdPartyInitiatorB64: "VGhpcmRQYXJ0eSBDb21wYW55",
          },
          userVisibleData: "IFRoaXMgaXMgYSBzYW1wbGUgdGV4dCB0byBiZSBzaWduZWQ=",
        },
      ],
      [
        "/other/payment",
        {
          personalNumber: "200001012384",
          userVisibleTransaction: {
            transactionType: "card",
            recipient: { name: "Payment Recipients Inc." },
          },
          requirement: { stepUp: ["mrtd", "face"] },
        },
      ],
    ];
    for (const [path, body] of examples)
      expect((await post(path, body)).status).toBe(200);
  });

  it("refuses a recipient with both name and nameB64 (RecipientCard: exactly one)", async () => {
    expect(
      (
        await post("/payment", {
          endUserIp,
          userVisibleTransaction: {
            transactionType: "card",
            recipient: { name: "A", nameB64: b64("A") },
          },
        })
      ).body,
    ).toStrictEqual({
      errorCode: "invalidParameters",
      details: "Incorrect userVisibleTransaction.recipient.name",
    });
  });

  it("refuses a B64 field that is not base64 UTF-8", async () => {
    for (const nameB64 of ["not base64!", b64("x").slice(1), "/w=="])
      expect(
        (
          await post("/payment", {
            endUserIp,
            userVisibleTransaction: {
              transactionType: "npa",
              recipient: { nameB64 },
            },
          })
        ).body.details,
      ).toBe("Incorrect userVisibleTransaction.recipient.nameB64");
  });

  it.each([
    [
      "/payment",
      { userVisibleTransaction: wireTransactions.card },
      "endUserIp",
    ],
    [
      "/payment/bulk",
      { userVisibleTransactionBulk: wireBulk.userVisibleTransactionBulk },
      "endUserIp",
    ],
    [
      "/phone/payment",
      { personalNumber, userVisibleTransaction: wireTransactions.card },
      "callInitiator",
    ],
    [
      "/phone/payment/bulk",
      {
        callInitiator: "RP",
        userVisibleTransactionBulk: wireBulk.userVisibleTransactionBulk,
      },
      "personalNumber",
    ],
    [
      "/other/payment",
      { userVisibleTransaction: wireTransactions.card },
      "personalNumber",
    ],
    [
      "/other/payment",
      {
        personalNumber,
        requirement: { personalNumber },
        userVisibleTransaction: wireTransactions.card,
      },
      "personalNumber",
    ],
    [
      "/payment",
      {
        endUserIp,
        userVisibleDataFormat: "html",
        userVisibleTransaction: wireTransactions.card,
      },
      "userVisibleDataFormat",
    ],
  ] as const)(
    "checks the fields %s shares with other endpoints (%#)",
    async (path, body, field) => {
      expect((await post(path, body)).body).toStrictEqual({
        errorCode: "invalidParameters",
        details: `Incorrect ${field}`,
      });
    },
  );
});

describe("payment orders through the fake", () => {
  const setup = () => {
    const fake = createFakeBankId();
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    return { fake, bankid };
  };
  const user = { personalNumber, name: "Alex Johnson" };

  it("runs a card payment: QR scan, then complete", async () => {
    const { fake, bankid } = setup();
    const startedAt = Date.now();
    const started = await bankid.payment({
      endUserIp,
      returnRisk: true,
      userVisibleData: "Köp hos Kaffebaren",
      userVisibleTransaction: transactions.card,
    });
    expect(Object.keys(started).sort()).toEqual([
      "autoStartToken",
      "orderRef",
      "qrStartSecret",
      "qrStartToken",
    ]);
    const seen: string[] = [];
    for await (const result of bankid.watch(started.orderRef, {
      intervalMs: 1,
    })) {
      seen.push(
        result.status === "complete" ? "complete" : (result.hintCode ?? "none"),
      );
      if (
        result.status === "pending" &&
        result.hintCode === "outstandingTransaction"
      )
        await fake.scan(started.orderRef, qrCode(started, { startedAt }));
      else if (result.status === "pending")
        await fake.complete(started.orderRef, user);
      else if (result.status === "complete") {
        expect(result.completionData.user).toMatchObject(user);
        expect(result.completionData.device?.ipAddress).toBe(endUserIp);
        expect(result.completionData.risk).toBe("low");
        expect(
          Buffer.from(result.completionData.signature ?? "", "base64").toString(
            "utf8",
          ),
        ).toContain(b64("Köp hos Kaffebaren"));
      }
    }
    expect(seen).toEqual(["outstandingTransaction", "userSign", "complete"]);
  });

  it("runs a bulk payment to completion", async () => {
    const { fake, bankid } = setup();
    const started = await bankid.payment.bulk(bulk);
    await fake.setPending(started.orderRef, "userSign");
    await fake.complete(started.orderRef, user);
    const result = await bankid.collect(started.orderRef);
    expect(result.status).toBe("complete");
    if (result.status === "complete")
      expect(result.completionData.user?.personalNumber).toBe(personalNumber);
  });

  it("runs a phone payment with call confirmation, without an IP address", async () => {
    const { fake, bankid } = setup();
    const { orderRef: ref, ...rest } = await bankid.phone.payment({
      callInitiator: "RP",
      personalNumber,
      userVisibleTransaction: transactions.samebank,
    });
    expect(rest).toEqual({});
    await fake.setPending(ref, "userCallConfirm");
    const pending = await bankid.collect(ref);
    expect(pending).toMatchObject({
      status: "pending",
      hintCode: "userCallConfirm",
    });
    expect(describeResult(pending, { start: "phoneCall" })).toBe("RFA21");
    await fake.complete(ref, user);
    const result = await bankid.collect(ref);
    if (result.status !== "complete") throw new Error("not complete");
    expect(result.completionData.device).not.toHaveProperty("ipAddress");
  });

  it("runs a phone bulk payment that the user declines", async () => {
    const { fake, bankid } = setup();
    const { endUserIp: _, ...rest } = bulk;
    const { orderRef: ref } = await bankid.phone.payment.bulk({
      ...rest,
      callInitiator: "user",
      personalNumber,
    });
    await fake.fail(ref, "userDeclinedCall");
    expect(await bankid.collect(ref)).toMatchObject({
      status: "failed",
      hintCode: "userDeclinedCall",
    });
  });

  it("starts an other.payment order with only an orderRef, no QR code and no call", async () => {
    const { fake, bankid } = setup();
    const started: OtherOrderResponse = await bankid.other.payment({
      personalNumber,
      userVisibleTransaction: transactions.npa as never,
    });
    expect(Object.keys(started)).toEqual(["orderRef"]);
    await expect(fake.scan(started.orderRef, "bankid.x.0.y")).rejects.toThrow(
      "is an /other/payment order, which has no QR code",
    );
    await expect(
      fake.setPending(started.orderRef, "userCallConfirm"),
    ).rejects.toThrow("only for phone orders");
    const pending = await bankid.collect(started.orderRef);
    expect(describeResult(pending, { start: "other" })).toBe("RFA1");
    await fake.fail(started.orderRef, "startFailed");
    expect(
      describeResult(await bankid.collect(started.orderRef), {
        start: "other",
      }),
    ).toBe("RFA17A");
  });

  it("refuses a second order for the same personal number with alreadyInProgress", async () => {
    const { bankid } = setup();
    const first = await bankid.auth({
      endUserIp,
      requirement: { personalNumber },
    });
    const error = await rejection(
      bankid.payment({
        endUserIp,
        requirement: { personalNumber },
        userVisibleTransaction: transactions.card,
      }),
    );
    expect(error).toMatchObject({
      errorCode: "alreadyInProgress",
      path: "/payment",
    });
    expect(await bankid.collect(first.orderRef)).toMatchObject({
      status: "failed",
      hintCode: "cancelled",
    });
    const other = await bankid.other.payment({
      personalNumber,
      userVisibleTransaction: transactions.card as CardTransaction,
    });
    await expect(
      bankid.phone.payment.bulk({
        callInitiator: "RP",
        personalNumber,
        userVisibleTransactionBulk: bulk.userVisibleTransactionBulk,
      }),
    ).rejects.toMatchObject({ errorCode: "alreadyInProgress" });
    expect(await bankid.collect(other.orderRef)).toMatchObject({
      hintCode: "cancelled",
    });
  });

  it("autoCompletes a payment order with the requirement's personal number", async () => {
    const fake = createFakeBankId({
      autoComplete: { afterMs: 0, user: { personalNumber: "200001012384" } },
    });
    const bankid = createBankIdClient({
      environment: "test",
      transport: fake.transport,
    });
    const { orderRef: ref } = await bankid.payment.bulk({
      ...bulk,
      requirement: { personalNumber },
    });
    expect(await bankid.collect(ref)).toMatchObject({
      status: "complete",
      completionData: { user: { personalNumber } },
    });
  });
});

describe("payment types", () => {
  it("derive their enums from the spec", () => {
    expectTypeOf<UserVisibleTransaction["transactionType"]>().toEqualTypeOf<
      NonNullable<Schemas["UserVisibleTransaction"]["transactionType"]>
    >();
    expectTypeOf<TransactionType>().toEqualTypeOf<
      | "card"
      | "npa"
      | "bankgiro"
      | "plusgiro"
      | "samebank"
      | "domesticbank"
      | "foreignbank"
      | "direct"
    >();
    expectTypeOf<
      OtherPaymentRequest["userVisibleTransaction"]["transactionType"]
    >().toEqualTypeOf<
      NonNullable<Schemas["UserVisibleTransactionCardNpa"]["transactionType"]>
    >();
    expectTypeOf<
      BulkPayment["transactionType"]
    >().toEqualTypeOf<BulkTransactionType>();
    expectTypeOf<BulkTransactionType>().toEqualTypeOf<
      "bankgiro" | "plusgiro" | "samebank" | "domesticbank" | "foreignbank"
    >();
    expectTypeOf<RiskWarning>().toEqualTypeOf<Schemas["riskWarning"]>();
    expectTypeOf<RiskFlag[]>().toEqualTypeOf<Schemas["riskFlags"]>();
    expectTypeOf<Money>().toEqualTypeOf<{ amount: string; currency: string }>();
  });

  it("make payment a function with a bulk method, on the client and on phone", () => {
    const { bankid } = recording();
    expectTypeOf(bankid.payment).toBeCallableWith({
      endUserIp,
      userVisibleTransaction: transactions.card,
    });
    expectTypeOf<BankIdPaymentClient["bulk"]>().toBeCallableWith(bulk);
    expectTypeOf<BankIdPhonePaymentClient["bulk"]>()
      .parameter(0)
      .toHaveProperty("callInitiator");
    expectTypeOf<
      BankIdOtherClient["payment"]
    >().returns.resolves.toEqualTypeOf<{ orderRef: string }>();
    expect(typeof bankid.payment).toBe("function");
    expect(typeof bankid.payment.bulk).toBe("function");
    expect(typeof bankid.phone.payment.bulk).toBe("function");
  });

  it("reject requests the spec does not allow", () => {
    const { bankid } = recording();
    const card = transactions.card as CardTransaction;
    const payment = { endUserIp } as const;
    const phone = { callInitiator: "user", personalNumber } as const;
    const date = "2026-12-01";
    const money = sek();
    // Each call below is a type error; they are never awaited or sent.
    const calls = () => [
      bankid.payment({
        ...payment,
        // @ts-expect-error npa takes no money
        userVisibleTransaction: {
          transactionType: "npa",
          recipient: { name: "A" },
          money,
        },
      }),
      bankid.payment({
        ...payment,
        // @ts-expect-error bankgiro needs a date
        userVisibleTransaction: {
          transactionType: "bankgiro",
          recipient: { accountNumber: "1" },
          money,
        },
      }),
      bankid.payment({
        ...payment,
        // @ts-expect-error a transfer needs money
        userVisibleTransaction: {
          transactionType: "foreignbank",
          recipient: { accountNumber: "1" },
          date,
        },
      }),
      bankid.payment({
        ...payment,
        // @ts-expect-error a transfer recipient needs an account number
        userVisibleTransaction: {
          transactionType: "samebank",
          recipient: { name: "A" },
          money,
          date,
        },
      }),
      bankid.payment({
        ...payment,
        userVisibleTransaction: {
          transactionType: "direct",
          // @ts-expect-error a direct recipient needs at least one field
          recipient: {},
          money,
        },
      }),
      bankid.payment({
        ...payment,
        // @ts-expect-error a card recipient needs a name
        userVisibleTransaction: { transactionType: "card", recipient: {} },
      }),
      bankid.payment({
        ...payment,
        userVisibleTransaction: {
          ...card,
          // @ts-expect-error names are plain text; the library encodes them
          recipient: { nameB64: "QQ==" },
        },
      }),
      bankid.payment({
        ...payment,
        // @ts-expect-error not a transaction type
        userVisibleTransaction: { ...card, transactionType: "cash" },
      }),
      bankid.payment({
        ...payment,
        userVisibleTransaction: card,
        // @ts-expect-error not a risk flag
        riskFlags: ["x"],
      }),
      bankid.other.payment({
        personalNumber,
        // @ts-expect-error other.payment takes card or npa only
        userVisibleTransaction: transactions.bankgiro,
      }),
      bankid.other.payment({
        personalNumber,
        // @ts-expect-error other.payment takes no endUserIp
        endUserIp,
        userVisibleTransaction: card,
      }),
      // @ts-expect-error other.payment needs a personal number
      bankid.other.payment({ userVisibleTransaction: card }),
      bankid.phone.payment({
        ...phone,
        // @ts-expect-error phone.payment takes no endUserIp
        endUserIp,
        userVisibleTransaction: card,
      }),
      // @ts-expect-error phone.payment needs callInitiator
      bankid.phone.payment({ personalNumber, userVisibleTransaction: card }),
      bankid.payment.bulk({
        ...payment,
        userVisibleTransactionBulk: {
          // @ts-expect-error bulk payments cannot be card payments
          payments: [{ ...bulkPayment(), transactionType: "card" }],
          sums: [money],
        },
      }),
      bankid.payment.bulk({
        ...payment,
        userVisibleTransactionBulk: {
          // @ts-expect-error bulk payments cannot be recurring
          payments: [{ ...bulkPayment(), recurring: true }],
          sums: [money],
        },
      }),
      bankid.payment.bulk({
        ...payment,
        userVisibleTransactionBulk: {
          // @ts-expect-error fromAccount needs a name or an account number
          payments: [{ ...bulkPayment(), fromAccount: {} }],
          sums: [money],
        },
      }),
      bankid.payment.bulk({
        ...payment,
        userVisibleTransactionBulk: {
          payments: [
            {
              ...bulkPayment(),
              // @ts-expect-error fromAccount takes a name or an account number, not both
              fromAccount: { name: "Lönekonto", accountNumber: "12312313" },
            },
          ],
          sums: [money],
        },
      }),
      bankid.payment.bulk({
        ...payment,
        // @ts-expect-error sums are required
        userVisibleTransactionBulk: { payments: [bulkPayment()] },
      }),
      bankid.payment.bulk({
        ...payment,
        userVisibleTransactionBulk: bulk.userVisibleTransactionBulk,
        // @ts-expect-error bulk payments show plain text only
        userVisibleDataFormat: "plaintext",
      }),
      bankid.payment.bulk({
        ...payment,
        userVisibleTransactionBulk: bulk.userVisibleTransactionBulk,
        // @ts-expect-error riskFlags go on each bulk payment
        riskFlags: ["newCard"],
      }),
      bankid.phone.payment.bulk({
        ...phone,
        userVisibleTransactionBulk: bulk.userVisibleTransactionBulk,
        // @ts-expect-error phone orders take no returnUrl
        returnUrl: "https://example.com/",
      }),
    ];
    expect(calls).toBeTypeOf("function");
  });
});
