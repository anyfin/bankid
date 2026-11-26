// The rules BankID's spec and guides state for payment orders, checked on the
// request body as sent (text fields base64-encoded). The client runs them
// before sending and the fake runs them on what it receives, so both refuse
// the same requests. Problems name the field and the rule, never the value,
// since values are names, account numbers and amounts.
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import type { BankIdPath } from "./transport.ts";
import type {
  BulkTransactionType,
  RiskFlag,
  RiskWarning,
  TransactionType,
} from "./types.ts";

/** The five payment endpoints. */
export type PaymentPath = Extract<
  BankIdPath,
  | "/payment"
  | "/payment/bulk"
  | "/phone/payment"
  | "/phone/payment/bulk"
  | "/other/payment"
>;

/** A broken rule: the field as sent (`a.b[0].c`) and what is wrong with it. */
export interface PaymentProblem {
  field: string;
  reason: string;
}

type Body = Record<string, unknown>;
type Check = (value: unknown, field: string) => PaymentProblem | undefined;

const isObject = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const problem = (field: string, reason: string): PaymentProblem => ({
  field,
  reason,
});

// Records rather than arrays, so the compiler checks each list against the
// spec's enum in both directions.
const keys = <K extends string>(record: Record<K, true>): readonly K[] =>
  Object.keys(record) as K[];

const riskWarnings = new Set<string>(
  keys<RiskWarning>({
    newRecipient: true,
    largeAmount: true,
    foreignCurrency: true,
    cryptoCurrencyPurchase: true,
    moneyTransfer: true,
    overseasTransaction: true,
    recurringPayment: true,
    partialNameMatch: true,
    noNameMatch: true,
    other: true,
  }),
);

const riskFlags = new Set<string>(
  keys<RiskFlag>({
    newCard: true,
    newCustomer: true,
    newRecipient: true,
    highRiskRecipient: true,
    largeAmount: true,
    foreignCurrency: true,
    cryptoCurrencyPurchase: true,
    moneyTransfer: true,
    overseasTransaction: true,
    recurringPayment: true,
    suspiciousPaymentPattern: true,
    partialNameMatch: true,
    noNameMatch: true,
    other: true,
  }),
);

type Presence = "required" | "optional" | "forbidden";

/**
 * Per transaction type, from the schemas `Card`, `Npa`, `Bankgiro`,
 * `Plusgiro`, `SameBank`, `DomesticBank`, `ForeignBank` and `Direct`: whether
 * `money` and `date` are required, and which recipient schema applies.
 */
const transactionRules: Record<
  TransactionType,
  {
    money: Presence;
    date: Exclude<Presence, "forbidden">;
    recipient: "named" | "account" | "direct";
  }
> = {
  card: { money: "optional", date: "optional", recipient: "named" },
  // `Npa` has no `money`, and `Money` says it "isn't allowed" for npa.
  npa: { money: "forbidden", date: "optional", recipient: "named" },
  bankgiro: { money: "required", date: "required", recipient: "account" },
  plusgiro: { money: "required", date: "required", recipient: "account" },
  samebank: { money: "required", date: "required", recipient: "account" },
  domesticbank: { money: "required", date: "required", recipient: "account" },
  foreignbank: { money: "required", date: "required", recipient: "account" },
  direct: { money: "required", date: "optional", recipient: "direct" },
};

const allTransactionTypes = Object.keys(transactionRules) as TransactionType[];

/** `TransactionBulk.transactionType`. */
const bulkTransactionTypes = keys<BulkTransactionType>({
  bankgiro: true,
  plusgiro: true,
  samebank: true,
  domesticbank: true,
  foreignbank: true,
});

const oneOf = (list: readonly string[]): string =>
  list.length === 1
    ? (list[0] as string)
    : `${list.slice(0, -1).join(", ")} or ${list.at(-1) as string}`;

/**
 * Unicode code points, which is what the spec's string lengths count, such as
 * its 40-character limits and its `minLength` and `maxLength`.
 */
export const codePoints = (text: string): number => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const decodeText = (value: string): string | undefined => {
  if (!base64Pattern.test(value)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(value, "base64"),
    );
  } catch {
    return undefined;
  }
};

/**
 * A `...B64` field: the spec says "a base64 encoded utf-8 string with a
 * maximum length of 40 unicode code points" and gives a `maxLength` for the
 * encoded string.
 */
const encodedName =
  (maxLength: number): Check =>
  (value, field) => {
    if (typeof value !== "string") return problem(field, "must be a string");
    if (value === "") return problem(field, "must not be empty");
    const text = decodeText(value);
    if (text === undefined)
      return problem(field, "must be base64-encoded UTF-8 text");
    if (codePoints(text) > 40)
      return problem(field, "must be at most 40 characters");
    if (value.length > maxLength)
      return problem(
        field,
        `must be at most ${maxLength} characters once base64-encoded`,
      );
    return undefined;
  };

const recipientName = encodedName(215);
const thirdPartyInitiator = encodedName(270);

/** `userVisibleData` and `userNonVisibleData` on the payment endpoints. */
const encodedText: Check = (value, field) => {
  if (typeof value !== "string") return problem(field, "must be a string");
  if (value === "") return problem(field, "must not be empty");
  if (decodeText(value) === undefined)
    return problem(field, "must be base64-encoded UTF-8 text");
  if (value.length > 1000)
    return problem(
      field,
      "must be at most 1000 characters once base64-encoded",
    );
  return undefined;
};

const accountNumber: Check = (value, field) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 42 &&
  /^[A-Z0-9.,() -]+$/.test(value)
    ? undefined
    : problem(
        field,
        "must be 1 to 42 characters, each A-Z, 0-9, space or one of . , ( ) -",
      );

const phoneNumber: Check = (value, field) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 25 &&
  /^[0-9() +-]*$/.test(value)
    ? undefined
    : problem(
        field,
        "must be 1 to 25 characters, each a digit, space or one of ( ) + -",
      );

const date: Check = (value, field) => {
  if (typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().startsWith(value)
    )
      return undefined;
  }
  return problem(field, "must be a date written YYYY-MM-DD");
};

const money: Check = (value, field) => {
  if (!isObject(value))
    return problem(field, "must be an object with amount and currency");
  const { amount, currency } = value;
  if (
    typeof amount !== "string" ||
    amount.length > 48 ||
    !/^[0-9]*,?[0-9]*$/.test(amount) ||
    !/[0-9]/.test(amount)
  )
    return problem(
      `${field}.amount`,
      'must be digits with at most one "," as decimal separator, at most 48 characters',
    );
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
    return problem(
      `${field}.currency`,
      "must be an ISO 4217 alphabetic currency code, such as SEK",
    );
  return undefined;
};

const riskWarning: Check = (value, field) =>
  typeof value === "string" && riskWarnings.has(value)
    ? undefined
    : problem(field, `must be one of ${oneOf([...riskWarnings])}`);

const riskFlagList: Check = (value, field) => {
  if (!Array.isArray(value)) return problem(field, "must be an array");
  return value.every(flag => typeof flag === "string" && riskFlags.has(flag))
    ? undefined
    : problem(field, `may only hold ${oneOf([...riskFlags])}`);
};

const optional =
  (check: Check): Check =>
  (value, field) =>
    value === undefined ? undefined : check(value, field);

const required =
  (check: Check): Check =>
  (value, field) =>
    value === undefined ? problem(field, "is required") : check(value, field);

/** Runs checks on fields of an object, returning the first problem. */
const fields = (
  object: Body,
  path: string,
  list: readonly [string, Check][],
): PaymentProblem | undefined => {
  for (const [name, check] of list) {
    const found = check(object[name], path === "" ? name : `${path}.${name}`);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * `RecipientCard` and `RecipientNpa`: exactly one of `name` (plain text, kept
 * by the spec for backward compatibility, at most 40 characters) and
 * `nameB64`.
 */
const namedRecipient = (recipient: Body, path: string) => {
  if (recipient.nameB64 !== undefined && recipient.name !== undefined)
    return problem(`${path}.name`, "must not be given together with nameB64");
  if (recipient.name !== undefined)
    return typeof recipient.name === "string" &&
      codePoints(recipient.name) <= 40
      ? undefined
      : problem(`${path}.name`, "must be a string of at most 40 characters");
  return fields(recipient, path, [["nameB64", required(recipientName)]]);
};

/** `RecipientBankgiro` and the other account recipients, and `RecipientGenericBulk`. */
const accountRecipient = (recipient: Body, path: string) =>
  fields(recipient, path, [
    ["accountNumber", required(accountNumber)],
    ["nameB64", optional(recipientName)],
  ]);

/** `RecipientDirect`: at least one of its four fields. */
const directRecipient = (recipient: Body, path: string) => {
  const any = ["nameB64", "legalNameB64", "accountNumber", "phoneNumber"];
  if (any.every(name => recipient[name] === undefined))
    return problem(
      path,
      "needs at least one of nameB64, legalNameB64, accountNumber and phoneNumber",
    );
  return fields(recipient, path, [
    ["nameB64", optional(recipientName)],
    ["legalNameB64", optional(recipientName)],
    ["accountNumber", optional(accountNumber)],
    ["phoneNumber", optional(phoneNumber)],
  ]);
};

const recipientChecks = {
  named: namedRecipient,
  account: accountRecipient,
  direct: directRecipient,
};

const presence = (rule: Presence, check: Check, type: string): Check =>
  rule === "required"
    ? (value, field) =>
        value === undefined
          ? problem(field, `is required for transactionType ${type}`)
          : check(value, field)
    : rule === "forbidden"
      ? (value, field) =>
          value === undefined
            ? undefined
            : problem(field, `is not allowed for transactionType ${type}`)
      : optional(check);

/** `UserVisibleTransaction`, limited to the types the endpoint allows. */
const transaction =
  (allowed: readonly TransactionType[]): Check =>
  (value, path) => {
    if (!isObject(value)) return problem(path, "must be an object");
    const type = value.transactionType;
    if (!(allowed as readonly unknown[]).includes(type))
      return problem(
        `${path}.transactionType`,
        `must be ${oneOf(allowed)} on this endpoint`,
      );
    const rule = transactionRules[type as TransactionType];
    const recipient = value.recipient;
    if (!isObject(recipient))
      return problem(
        `${path}.recipient`,
        recipient === undefined ? "is required" : "must be an object",
      );
    return (
      recipientChecks[rule.recipient](recipient, `${path}.recipient`) ??
      fields(value, path, [
        ["money", presence(rule.money, money, type as string)],
        ["date", presence(rule.date, date, type as string)],
        ["riskWarning", optional(riskWarning)],
        [
          "recurring",
          optional((flag, field) =>
            typeof flag === "boolean"
              ? undefined
              : problem(field, "must be a boolean"),
          ),
        ],
        ["thirdPartyInitiatorB64", optional(thirdPartyInitiator)],
      ])
    );
  };

const list =
  (min: number, max: number, noun: string, check: Check): Check =>
  (value, field) => {
    if (!Array.isArray(value) || value.length < min || value.length > max)
      return problem(field, `must be an array of ${min} to ${max} ${noun}`);
    for (const [index, item] of value.entries()) {
      const found = check(item, `${field}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  };

/** `UserVisibleTransactionBulk_payments_inner_allOf_fromAccount`. */
const fromAccount: Check = (value, path) => {
  if (!isObject(value)) return problem(path, "must be an object");
  // BankID rejects a fromAccount with both, although the spec's "either
  // nameB64 or accountNumber is required" reads as if both were allowed.
  if ((value.nameB64 === undefined) === (value.accountNumber === undefined))
    return problem(path, "needs nameB64 or accountNumber, not both");
  return fields(value, path, [
    ["nameB64", optional(recipientName)],
    ["accountNumber", optional(accountNumber)],
  ]);
};

/** `UserVisibleTransactionBulk_payments_inner`. */
const bulkPayment: Check = (value, path) => {
  if (!isObject(value)) return problem(path, "must be an object");
  if (
    !(bulkTransactionTypes as readonly unknown[]).includes(
      value.transactionType,
    )
  )
    return problem(
      `${path}.transactionType`,
      `must be ${oneOf(bulkTransactionTypes)} in a bulk payment`,
    );
  // The guides say bulk payments do not support recurring payments, and
  // `TransactionBulk` has no `recurring`.
  if (value.recurring !== undefined)
    return problem(`${path}.recurring`, "is not supported in a bulk payment");
  if (!isObject(value.recipient))
    return problem(
      `${path}.recipient`,
      value.recipient === undefined ? "is required" : "must be an object",
    );
  return (
    accountRecipient(value.recipient, `${path}.recipient`) ??
    fields(value, path, [
      ["date", required(date)],
      ["money", required(money)],
      ["fromAccount", optional(fromAccount)],
      ["riskWarning", optional(riskWarning)],
      ["riskFlags", optional(riskFlagList)],
    ])
  );
};

/** `UserVisibleTransactionBulk`. */
const transactionBulk: Check = (value, path) => {
  if (!isObject(value)) return problem(path, "must be an object");
  return fields(value, path, [
    ["payments", required(list(1, 40, "payments", bulkPayment))],
    ["sums", required(list(1, 4, "sums", money))],
    ["thirdPartyInitiatorB64", optional(thirdPartyInitiator)],
  ]);
};

const ipAddress: Check = (value, field) =>
  typeof value === "string" && isIP(value) !== 0
    ? undefined
    : problem(field, "must be an IPv4 or IPv6 address");

const callInitiator: Check = (value, field) =>
  value === "user" || value === "RP"
    ? undefined
    : problem(field, 'must be "user" or "RP"');

const personalNumber: Check = (value, field) =>
  typeof value === "string" && /^[0-9]{12}$/.test(value)
    ? undefined
    : problem(field, "must be 12 digits");

/** The caller and user fields every phone request schema requires. */
const phoneUser: readonly [string, Check][] = [
  ["callInitiator", required(callInitiator)],
  ["personalNumber", required(personalNumber)],
];

/** The fields each payment endpoint's request schema requires of the user. */
const requiredFields: Record<PaymentPath, readonly [string, Check][]> = {
  "/payment": [["endUserIp", required(ipAddress)]],
  "/payment/bulk": [["endUserIp", required(ipAddress)]],
  "/phone/payment": phoneUser,
  "/phone/payment/bulk": phoneUser,
  "/other/payment": [["personalNumber", required(personalNumber)]],
};

// The text the user signs. The body is as sent, so it is already
// base64-encoded, and empty only when the caller's text was.
const textToSign: [string, Check] = [
  "userVisibleData",
  required((value, field) =>
    value === "" ? problem(field, "must not be empty") : undefined,
  ),
];

/**
 * What `/auth` and `/sign` require, checked before sending as for payments:
 * the user's IP address, and for `/sign` the text the user signs.
 */
const startRequiredFields: Record<
  "/auth" | "/sign",
  readonly [string, Check][]
> = {
  "/auth": [["endUserIp", required(ipAddress)]],
  "/sign": [["endUserIp", required(ipAddress)], textToSign],
};

/**
 * What `/phone/auth` and `/phone/sign` require, checked before sending as for
 * phone payments: `callInitiator` and `personalNumber`, and for `/phone/sign`
 * the text the user signs.
 */
const phoneRequiredFields: Record<
  "/phone/auth" | "/phone/sign",
  readonly [string, Check][]
> = {
  "/phone/auth": phoneUser,
  "/phone/sign": [...phoneUser, textToSign],
};

/** Checks the fields `/phone/auth` or `/phone/sign` requires. */
export const checkPhoneRequired = (
  path: "/phone/auth" | "/phone/sign",
  body: Body,
): PaymentProblem | undefined => fields(body, "", phoneRequiredFields[path]);

/** Checks the fields `/auth` or `/sign` requires; see startRequiredFields. */
export const checkStartRequired = (
  path: "/auth" | "/sign",
  body: Body,
): PaymentProblem | undefined => fields(body, "", startRequiredFields[path]);

/** Checks only the fields the payment endpoint requires of the user. */
export const checkPaymentRequired = (
  path: PaymentPath,
  body: Body,
): PaymentProblem | undefined => fields(body, "", requiredFields[path]);

/** `returnUrl`, on the payment requests that take one: 1 to 512 characters. */
const returnUrl: Check = (value, field) =>
  typeof value === "string" && value !== "" && codePoints(value) <= 512
    ? undefined
    : problem(field, "must be a string of 1 to 512 characters");

// The phone payment requests have no returnUrl.
const takesReturnUrl: Record<PaymentPath, boolean> = {
  "/payment": true,
  "/payment/bulk": true,
  "/other/payment": true,
  "/phone/payment": false,
  "/phone/payment/bulk": false,
};

const endpoints: Record<
  PaymentPath,
  { transaction: readonly TransactionType[] } | { bulk: true }
> = {
  "/payment": { transaction: allTransactionTypes },
  "/phone/payment": { transaction: allTransactionTypes },
  // `otherPayment_request` takes `UserVisibleTransactionCardNpa`.
  "/other/payment": { transaction: ["card", "npa"] },
  "/payment/bulk": { bulk: true },
  "/phone/payment/bulk": { bulk: true },
};

/**
 * Checks a payment request body as sent: the fields the endpoint requires
 * (`endUserIp`, or `callInitiator` and `personalNumber`, or `personalNumber`),
 * `userVisibleTransaction` or `userVisibleTransactionBulk`, `riskFlags`, the
 * payment endpoints' limits on `userVisibleData` and `userNonVisibleData`,
 * the length of `returnUrl` where the endpoint takes one, and no
 * `userVisibleDataFormat` on bulk payments. Returns the first problem, or
 * undefined. Other optional fields every endpoint shares, such as
 * `requirement`, `app` and `web`, are left to BankID.
 */
export const checkPaymentBody = (
  path: PaymentPath,
  body: Body,
): PaymentProblem | undefined => {
  const endpoint = endpoints[path];
  const common: [string, Check][] = [
    ...requiredFields[path],
    ["userVisibleData", optional(encodedText)],
    ["userNonVisibleData", optional(encodedText)],
    ...(takesReturnUrl[path]
      ? [["returnUrl", optional(returnUrl)] as [string, Check]]
      : []),
  ];
  if ("bulk" in endpoint)
    return fields(body, "", [
      ...common,
      [
        "userVisibleDataFormat",
        // The guides say bulk payments support text but not formatting, and
        // the bulk request schemas have no `userVisibleDataFormat`.
        (value, field) =>
          value === undefined
            ? undefined
            : problem(field, "is not supported for bulk payments"),
      ],
      ["userVisibleTransactionBulk", required(transactionBulk)],
    ]);
  return fields(body, "", [
    ...common,
    ["riskFlags", optional(riskFlagList)],
    ["userVisibleTransaction", required(transaction(endpoint.transaction))],
  ]);
};

const base64 = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64");

/** Plain-text fields of the public types and the encoded field each becomes. */
const encodedNames = {
  name: "nameB64",
  legalName: "legalNameB64",
  thirdPartyInitiator: "thirdPartyInitiatorB64",
} as const;
type PlainName = keyof typeof encodedNames;

/**
 * Copies an object with its plain-text fields base64-encoded under their
 * spec names. Anything that is not an object is left for the rules to report.
 */
const encodeNames = (
  value: unknown,
  path: string,
  names: readonly PlainName[],
): unknown => {
  if (!isObject(value)) return value;
  const out: Body = { ...value };
  for (const plain of names) {
    const encoded = encodedNames[plain];
    if (Object.hasOwn(value, encoded))
      throw new TypeError(
        `${path}.${encoded} is not accepted: pass ${path}.${plain} as plain text and the library encodes it`,
      );
    const text = value[plain];
    if (text === undefined) continue;
    if (typeof text !== "string")
      throw new TypeError(`${path}.${plain} must be a string`);
    delete out[plain];
    out[encoded] = base64(text);
  }
  return out;
};

const encodeTransaction = (value: unknown, path: string): unknown => {
  const out = encodeNames(value, path, ["thirdPartyInitiator"]);
  if (isObject(out) && out.recipient !== undefined)
    out.recipient = encodeNames(out.recipient, `${path}.recipient`, [
      "name",
      "legalName",
    ]);
  return out;
};

const encodeBulk = (value: unknown, path: string): unknown => {
  const out = encodeNames(value, path, ["thirdPartyInitiator"]);
  if (isObject(out) && Array.isArray(out.payments))
    out.payments = out.payments.map((payment: unknown, index) => {
      const at = `${path}.payments[${index}]`;
      if (!isObject(payment)) return payment;
      return {
        ...payment,
        recipient: encodeNames(payment.recipient, `${at}.recipient`, ["name"]),
        ...(payment.fromAccount === undefined
          ? {}
          : {
              fromAccount: encodeNames(
                payment.fromAccount,
                `${at}.fromAccount`,
                ["name"],
              ),
            }),
      };
    });
  return out;
};

/** Field names as the public types spell them: `nameB64` becomes `name`. */
const plainNames = (text: string): string =>
  text.replace(/\b(name|legalName|thirdPartyInitiator)B64\b/g, "$1");

/**
 * Turns a payment request in the public types into the body BankID expects:
 * text fields base64-encoded, plain names under their `...B64` spec names.
 * Throws a `TypeError` for a text field that is not a string or a field given
 * under its encoded name. The request object is not changed.
 */
export const encodePayment = (request: Body): Body => {
  const body: Body = { ...request };
  for (const field of ["userVisibleData", "userNonVisibleData"]) {
    const text = request[field];
    if (text === undefined) continue;
    if (typeof text !== "string")
      throw new TypeError(`${field} must be a string`);
    body[field] = base64(text);
  }
  if (body.userVisibleTransaction !== undefined)
    body.userVisibleTransaction = encodeTransaction(
      body.userVisibleTransaction,
      "userVisibleTransaction",
    );
  if (body.userVisibleTransactionBulk !== undefined)
    body.userVisibleTransactionBulk = encodeBulk(
      body.userVisibleTransactionBulk,
      "userVisibleTransactionBulk",
    );
  return body;
};

/**
 * Encodes a payment request with {@link encodePayment} and checks it with
 * {@link checkPaymentBody}. Throws a `TypeError` prefixed with `method` that
 * names the field, as the public types spell it, and the rule, for a request
 * BankID would refuse. The message never holds the value.
 */
export const encodePaymentRequest = (
  method: string,
  path: PaymentPath,
  request: object,
): Body => {
  if (!isObject(request))
    throw new TypeError(`${method} needs a request object`);
  let body: Body;
  try {
    body = encodePayment(request);
  } catch (error) {
    if (error instanceof TypeError)
      throw new TypeError(`${method}: ${error.message}`);
    throw error;
  }
  const found = checkPaymentBody(path, body);
  if (found !== undefined)
    throw new TypeError(
      `${method}: ${plainNames(`${found.field} ${found.reason}`)}`,
    );
  return body;
};
