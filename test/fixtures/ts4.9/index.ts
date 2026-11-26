import {
  BankIdApiError,
  BankIdTransportError,
  createBankIdClient,
  createNodeTransport,
  createReturnUrl,
  describe,
  qrCode,
  verifyReturn,
  type BankIdOtherClient,
  type BankIdPaymentClient,
  type BankIdPhoneClient,
  type BankIdPhonePaymentClient,
  type BankIdTransport,
  type NodeTransportOptions,
  type BulkPayment,
  type CallInitiator,
  type CollectResponse,
  type DescribeContext,
  type ErrorCode,
  type Money,
  type OrderResponse,
  type OtherOrderResponse,
  type PaymentBulkRequest,
  type PaymentRequest,
  type PendingHintCode,
  type PhoneAuthRequest,
  type PhoneOrderResponse,
  type PhonePaymentRequest,
  type PhoneSignRequest,
  type ReturnUrl,
  type RiskFlag,
  type UserMessage,
  type UserVisibleTransaction,
} from "bankid";
import {
  describe as describeInBrowser,
  startUrl,
  type RelayedStatus,
  type StartDevice,
  type WithStatus,
} from "bankid/client";
import {
  createFakeBankId,
  createMemoryStore,
  fakeMarker,
  testCredentials,
  type FakeBankId,
  type FakeBankIdStore,
  type FakeUser,
  type JsonValue,
} from "bankid/testing";

const transport: BankIdTransport = async ({ path, body, signal }) => {
  signal.throwIfAborted();
  return { status: 200, body: JSON.stringify({ path, body }) };
};

export const bankid = createBankIdClient({ environment: "test", transport });
export const withCredentials = () =>
  createBankIdClient({
    environment: "production",
    credentials: { pfx: new Uint8Array(), passphrase: "" },
    timeoutMs: 5000,
  });

// @ts-expect-error environment is required
createBankIdClient({ transport });
// @ts-expect-error credentials are required without a transport
createBankIdClient({ environment: "test" });

export const summary = (result: CollectResponse): string => {
  switch (result.status) {
    case "pending": {
      const known: PendingHintCode = "userSign";
      return result.hintCode === known
        ? "sign"
        : (result.hintCode ?? "pending");
    }
    case "complete":
      return result.completionData.user?.name ?? "";
    case "failed":
      // BankID's spec does not require a hint code.
      return result.hintCode ?? "failed";
  }
};

export const code = (error: unknown): ErrorCode | undefined =>
  error instanceof BankIdApiError
    ? error.errorCode
    : error instanceof BankIdTransportError
      ? error.reason
      : undefined;

export const qr: string = qrCode(
  { qrStartToken: "token", qrStartSecret: "secret" },
  { startedAt: new Date(), now: Date.now() },
);
export const returned: ReturnUrl = createReturnUrl("https://example.com/");
export const verified: boolean = verifyReturn({
  expected: returned.nonce,
  received: undefined,
});

const context: DescribeContext = { start: "autoStart", device: "phone" };
export const message = (result: CollectResponse): UserMessage | undefined =>
  describe(result, context);
export const errorMessage: UserMessage = describe({ errorCode: "maintenance" });
// @ts-expect-error a collect result needs a context
describe({ orderRef: "ref", status: "pending", hintCode: "userSign" });
export const noHintCode: UserMessage | undefined = describe(
  { orderRef: "ref", status: "failed" },
  context,
);

export const watchAll = async (signal: AbortSignal): Promise<string[]> => {
  const statuses: string[] = [];
  for await (const result of bankid.watch("ref", {
    signal,
    intervalMs: 2000,
    maxConsecutiveRetries: 5,
  }))
    statuses.push(result.status);
  return statuses;
};

const initiator: CallInitiator = "RP";
const phoneAuth: PhoneAuthRequest = {
  callInitiator: initiator,
  personalNumber: "190010101010",
  requirement: { stepUp: ["mrtd"] },
};
const phoneSign: PhoneSignRequest = {
  callInitiator: "user",
  personalNumber: "190010101010",
  userVisibleData: "Sign this",
};
const phone: BankIdPhoneClient = bankid.phone;
export const phoneOrders = async (): Promise<PhoneOrderResponse[]> => [
  await phone.auth(phoneAuth),
  await bankid.phone.sign(phoneSign, { signal: AbortSignal.timeout(1000) }),
];
export const phoneMessage = (result: CollectResponse) =>
  describe(result, { start: "phoneCall" });
// @ts-expect-error phone orders take no endUserIp
bankid.phone.auth({ ...phoneAuth, endUserIp: "::1" });
// @ts-expect-error phone orders take no returnUrl
bankid.phone.sign({ ...phoneSign, returnUrl: "https://example.com/" });
// @ts-expect-error the personal number is not a requirement on phone orders
bankid.phone.auth({ ...phoneAuth, requirement: { personalNumber: "1" } });
// @ts-expect-error callInitiator is required
bankid.phone.auth({ personalNumber: "190010101010" });
export const misuse = (order: PhoneOrderResponse) => [
  // @ts-expect-error a phone order has no QR start token or secret
  qrCode(order, { startedAt: 0 }),
  // @ts-expect-error a phone order has no autostart token
  startUrl({ ...order, device: "phone" }),
];

const amount: Money = { amount: "100,00", currency: "SEK" };
const card: UserVisibleTransaction = {
  transactionType: "card",
  recipient: { name: "Example Shop" },
  money: amount,
  riskWarning: "largeAmount",
};
const flags: RiskFlag[] = ["newCard"];
const cardPayment: PaymentRequest = {
  endUserIp: "192.0.2.1",
  riskFlags: flags,
  userVisibleTransaction: card,
};
const transfer: BulkPayment = {
  transactionType: "bankgiro",
  recipient: { name: "Example Utility", accountNumber: "5050-1055" },
  money: amount,
  date: "2026-12-01",
  fromAccount: { accountNumber: "12312313" },
};
const bulkPayment: PaymentBulkRequest = {
  endUserIp: "192.0.2.1",
  userVisibleTransactionBulk: { payments: [transfer], sums: [amount] },
};
const phonePayment: PhonePaymentRequest = {
  callInitiator: "user",
  personalNumber: "190010101010",
  userVisibleTransaction: {
    transactionType: "direct",
    recipient: { phoneNumber: "+46 70 123 45 67" },
    money: amount,
  },
};
const payment: BankIdPaymentClient = bankid.payment;
const phonePayments: BankIdPhonePaymentClient = bankid.phone.payment;
const other: BankIdOtherClient = bankid.other;
export const payments = async (): Promise<
  [
    OrderResponse,
    OrderResponse,
    PhoneOrderResponse,
    PhoneOrderResponse,
    OtherOrderResponse,
  ]
> => [
  await payment(cardPayment),
  await payment.bulk(bulkPayment, { signal: AbortSignal.timeout(1000) }),
  await phonePayments(phonePayment),
  await phonePayments.bulk({
    callInitiator: "RP",
    personalNumber: "190010101010",
    userVisibleTransactionBulk: bulkPayment.userVisibleTransactionBulk,
  }),
  await other.payment({
    personalNumber: "190010101010",
    userVisibleTransaction: {
      transactionType: "npa",
      recipient: { name: "Example Bank" },
    },
  }),
];
export const otherMessage = (result: CollectResponse) =>
  describe(result, { start: "other" });
bankid.payment({
  ...cardPayment,
  // @ts-expect-error npa takes no money
  userVisibleTransaction: {
    transactionType: "npa",
    recipient: { name: "A" },
    money: amount,
  },
});
bankid.payment({
  ...cardPayment,
  // @ts-expect-error a bankgiro payment needs a date
  userVisibleTransaction: { ...transfer, date: undefined },
});
bankid.other.payment({
  personalNumber: "190010101010",
  // @ts-expect-error other.payment takes card or npa only
  userVisibleTransaction: transfer,
});
bankid.payment.bulk({
  ...bulkPayment,
  userVisibleTransactionBulk: {
    // @ts-expect-error a bulk payment cannot be a card payment
    payments: [{ ...transfer, transactionType: "card" }],
    sums: [amount],
  },
});

const device: StartDevice = "desktop";
export const phoneUrl: string = startUrl({
  autoStartToken: "token",
  device: "phone",
});
export const desktopUrl: string = startUrl({ autoStartToken: "token", device });
// @ts-expect-error the device is required
startUrl({ autoStartToken: "token" });
// @ts-expect-error only phone and desktop are known devices
startUrl({ autoStartToken: "token", device: "tablet" });

export const relayed = (result: CollectResponse): RelayedStatus => {
  switch (result.status) {
    case "pending":
      return { status: "pending", hintCode: result.hintCode, qrCode: qr };
    case "complete":
      return { status: "complete" };
    case "failed":
      return { status: "failed", hintCode: result.hintCode };
  }
};
export const relayedWithoutHintCode: RelayedStatus = { status: "pending" };
export const browserMessage: UserMessage | undefined = describeInBrowser(
  { orderRef: "ref", status: "pending", hintCode: "userSign" },
  { start: "qrCode" },
);
export const relayedMessage = (
  status: RelayedStatus,
): UserMessage | undefined => describeInBrowser(status, { start: "qrCode" });
export const serverRelayedMessage: UserMessage | undefined = describe(
  relayedWithoutHintCode,
  context,
);
const asStatus: WithStatus = relayedWithoutHintCode;
export const anyStatusMessage = describeInBrowser(asStatus, context);

const store: FakeBankIdStore = createMemoryStore();
const user: FakeUser = { personalNumber: "190010101010", name: "Alex Johnson" };
export const fake: FakeBankId = createFakeBankId({
  store,
  now: () => Date.now(),
  autoComplete: { afterMs: 5000, user },
});
export const viaFake = createBankIdClient({
  environment: "test",
  transport: fake.transport,
});
export const script = async (orderRef: string): Promise<void> => {
  await fake.setPending(orderRef, ["outstandingTransaction", "userSign"]);
  await fake.setPending(orderRef, "noClient");
  await fake.scan(orderRef, qr);
  await fake.complete(orderRef, user, { risk: "low" });
  await fake.fail(orderRef, "userCancel");
  await fake.expire(orderRef);
};
export const json: JsonValue = { a: [1, "b", null, true] };
export const marker: string = fakeMarker;
export const withTestCredentials = createBankIdClient({
  environment: "test",
  credentials: testCredentials,
});
const transportOptions: NodeTransportOptions = {
  environment: "test",
  credentials: testCredentials,
};
const builtIn: BankIdTransport = createNodeTransport(transportOptions);
export const wrapped = createBankIdClient({
  environment: "test",
  transport: async request => {
    const response = await builtIn(request);
    return { status: response.status, body: response.body };
  },
});
// @ts-expect-error the environment is required
createNodeTransport({ credentials: testCredentials });
// @ts-expect-error the client owns the timeout
createNodeTransport({ ...transportOptions, timeoutMs: 1000 });
export const transportInBrowser: typeof import("bankid/client") extends {
  createNodeTransport: unknown;
}
  ? true
  : false = false;
// @ts-expect-error a user needs a personal number
fake.complete("ref", { name: "No Number" });
// @ts-expect-error the fake's signature cannot be overridden
fake.complete("ref", user, { signature: "PHJlYWwvPg==" });
// @ts-expect-error the store must have get, set and delete
createFakeBankId({ store: { get: async () => undefined } });
