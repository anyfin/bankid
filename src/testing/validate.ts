// Request checks for the fake, from the request schemas in BankID's spec.
// Each check returns the `details` text for an `invalidParameters` error, or
// undefined when the request is valid.
import { isIP } from "node:net";
import {
  checkPaymentBody,
  checkPaymentRequired,
  codePoints,
  type PaymentPath,
} from "../payment.ts";

export type Body = Record<string, unknown>;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const base64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// BankID's only documented details texts are "No such order" and "Incorrect
// personalNumber", so the fake follows the second one's wording.
const incorrect = (field: string): string => `Incorrect ${field}`;

type Check = (body: Body) => string | undefined;

const optionalString =
  (
    field: string,
    { min, max, encoded }: { min: number; max: number; encoded?: boolean },
  ): Check =>
  body => {
    const value = body[field];
    if (value === undefined) return undefined;
    // The spec's minLength and maxLength count Unicode code points.
    if (
      typeof value !== "string" ||
      codePoints(value) < min ||
      codePoints(value) > max ||
      (encoded === true && !base64.test(value))
    )
      return incorrect(field);
    return undefined;
  };

const required =
  (field: string, check: Check): Check =>
  body =>
    body[field] === undefined ? incorrect(field) : check(body);

const endUserIp: Check = body =>
  typeof body.endUserIp === "string" && isIP(body.endUserIp) !== 0
    ? undefined
    : incorrect("endUserIp");

const optionalBoolean =
  (field: string): Check =>
  body =>
    body[field] === undefined || typeof body[field] === "boolean"
      ? undefined
      : incorrect(field);

const userVisibleDataFormat: Check = body =>
  body.userVisibleDataFormat === undefined ||
  body.userVisibleDataFormat === "plaintext" ||
  body.userVisibleDataFormat === "simpleMarkdownV1"
    ? undefined
    : incorrect("userVisibleDataFormat");

// The members of the spec's `app` and `web` schemas, with their limits. The
// spec's referringDomain pattern is unanchored; its description allows only
// 0-9, a-z, "." and "-", which is what is checked.
const members: Record<"app" | "web", Record<string, Check>> = {
  app: {
    appIdentifier: optionalString("appIdentifier", { min: 2, max: 256 }),
    deviceOS: optionalString("deviceOS", { min: 1, max: 128 }),
    deviceIdentifier: optionalString("deviceIdentifier", { min: 1, max: 64 }),
    deviceModelName: optionalString("deviceModelName", { min: 1, max: 128 }),
  },
  web: {
    deviceIdentifier: optionalString("deviceIdentifier", { min: 1, max: 64 }),
    referringDomain: body =>
      optionalString("referringDomain", { min: 3, max: 253 })(body) ??
      (body.referringDomain === undefined ||
      /^[0-9a-z.-]*$/.test(body.referringDomain as string)
        ? undefined
        : incorrect("referringDomain")),
    userAgent: optionalString("userAgent", { min: 1, max: 512 }),
  },
};

// The spec allows `app` or `web`, not both, each with at least one of its
// members.
const appOrWeb: Check = body => {
  for (const field of ["app", "web"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    const known = members[field];
    if (
      !isObject(value) ||
      !Object.keys(value).some(key => Object.hasOwn(known, key))
    )
      return incorrect(field);
    for (const check of Object.values(known)) {
      const details = check(value);
      if (details !== undefined) return details;
    }
  }
  if (body.app !== undefined && body.web !== undefined)
    return incorrect("app and web");
  return undefined;
};

const isPersonalNumber = (value: unknown): boolean =>
  typeof value === "string" && /^[0-9]{12}$/.test(value);

const topLevelPersonalNumber: Check = body =>
  isPersonalNumber(body.personalNumber)
    ? undefined
    : incorrect("personalNumber");

const callInitiator: Check = body =>
  body.callInitiator === "user" || body.callInitiator === "RP"
    ? undefined
    : incorrect("callInitiator");

// Phone orders carry the personal number at the top level, and their
// requirement has none.
const requirement =
  ({ withPersonalNumber }: { withPersonalNumber: boolean }): Check =>
  body => {
    const value = body.requirement;
    if (value === undefined) return undefined;
    if (!isObject(value)) return incorrect("requirement");
    const {
      personalNumber,
      mrtd,
      stepUp,
      pinCode,
      certificatePolicies,
      cardReader,
    } = value;
    if (
      personalNumber !== undefined &&
      !(withPersonalNumber && isPersonalNumber(personalNumber))
    )
      return incorrect("personalNumber");
    if (mrtd !== undefined && typeof mrtd !== "boolean")
      return incorrect("mrtd");
    if (pinCode !== undefined && typeof pinCode !== "boolean")
      return incorrect("pinCode");
    if (
      cardReader !== undefined &&
      cardReader !== "class1" &&
      cardReader !== "class2"
    )
      return incorrect("cardReader");
    if (
      certificatePolicies !== undefined &&
      !(
        Array.isArray(certificatePolicies) &&
        certificatePolicies.every(policy => typeof policy === "string")
      )
    )
      return incorrect("certificatePolicies");
    if (stepUp !== undefined) {
      // stepUp is mrtd, or mrtd and face; face alone and stepUp with mrtd are
      // not allowed.
      if (
        !Array.isArray(stepUp) ||
        !stepUp.every(item => item === "mrtd" || item === "face") ||
        !stepUp.includes("mrtd") ||
        mrtd !== undefined
      )
        return incorrect("stepUp");
    }
    return undefined;
  };

const checks =
  (list: Check[]): Check =>
  body => {
    for (const check of list) {
      const details = check(body);
      if (details !== undefined) return details;
    }
    return undefined;
  };

/** Checks an `/auth` request body. */
export const checkAuth: Check = checks([
  required("endUserIp", endUserIp),
  optionalString("userVisibleData", { min: 1, max: 1500, encoded: true }),
  optionalString("userNonVisibleData", { min: 1, max: 1500, encoded: true }),
  userVisibleDataFormat,
  optionalString("returnUrl", { min: 1, max: 512 }),
  optionalBoolean("returnRisk"),
  appOrWeb,
  requirement({ withPersonalNumber: true }),
]);

/** Checks a `/sign` request body. */
export const checkSign: Check = checks([
  required("endUserIp", endUserIp),
  required(
    "userVisibleData",
    optionalString("userVisibleData", { min: 1, max: 40_000, encoded: true }),
  ),
  optionalString("userNonVisibleData", { min: 1, max: 200_000, encoded: true }),
  userVisibleDataFormat,
  optionalString("returnUrl", { min: 1, max: 512 }),
  optionalBoolean("returnRisk"),
  appOrWeb,
  requirement({ withPersonalNumber: true }),
]);

/** Checks a `/collect` or `/cancel` request body. */
export const checkOrderRef: Check = body =>
  typeof body.orderRef === "string" && body.orderRef !== ""
    ? undefined
    : incorrect("orderRef");

/** Checks a `/phone/auth` request body. */
export const checkPhoneAuth: Check = checks([
  required("callInitiator", callInitiator),
  required("personalNumber", topLevelPersonalNumber),
  optionalString("userVisibleData", { min: 1, max: 1500, encoded: true }),
  optionalString("userNonVisibleData", { min: 1, max: 1500, encoded: true }),
  userVisibleDataFormat,
  requirement({ withPersonalNumber: false }),
]);

/** Checks a `/phone/sign` request body. */
export const checkPhoneSign: Check = checks([
  required("callInitiator", callInitiator),
  required("personalNumber", topLevelPersonalNumber),
  required(
    "userVisibleData",
    optionalString("userVisibleData", { min: 1, max: 40_000, encoded: true }),
  ),
  optionalString("userNonVisibleData", { min: 1, max: 200_000, encoded: true }),
  userVisibleDataFormat,
  requirement({ withPersonalNumber: false }),
]);

// The payment endpoints' own rules, shared with the client, which runs them
// before sending. Their `details` names the field as sent.
const payment =
  (path: PaymentPath): Check =>
  body => {
    const problem = checkPaymentBody(path, body);
    return problem === undefined ? undefined : incorrect(problem.field);
  };

// The same required fields, checked first, as for the other endpoints.
const paymentRequired =
  (path: PaymentPath): Check =>
  body => {
    const problem = checkPaymentRequired(path, body);
    return problem === undefined ? undefined : incorrect(problem.field);
  };

/** Checks a `/payment` request body. */
export const checkPayment: Check = checks([
  paymentRequired("/payment"),
  userVisibleDataFormat,
  optionalString("returnUrl", { min: 1, max: 512 }),
  optionalBoolean("returnRisk"),
  appOrWeb,
  requirement({ withPersonalNumber: true }),
  payment("/payment"),
]);

/** Checks a `/payment/bulk` request body. */
export const checkPaymentBulk: Check = checks([
  paymentRequired("/payment/bulk"),
  optionalString("returnUrl", { min: 1, max: 512 }),
  optionalBoolean("returnRisk"),
  appOrWeb,
  requirement({ withPersonalNumber: true }),
  payment("/payment/bulk"),
]);

/** Checks a `/phone/payment` request body. */
export const checkPhonePayment: Check = checks([
  paymentRequired("/phone/payment"),
  userVisibleDataFormat,
  requirement({ withPersonalNumber: false }),
  payment("/phone/payment"),
]);

/** Checks a `/phone/payment/bulk` request body. */
export const checkPhonePaymentBulk: Check = checks([
  paymentRequired("/phone/payment/bulk"),
  requirement({ withPersonalNumber: false }),
  payment("/phone/payment/bulk"),
]);

/** Checks an `/other/payment` request body. */
export const checkOtherPayment: Check = checks([
  paymentRequired("/other/payment"),
  userVisibleDataFormat,
  optionalString("returnUrl", { min: 1, max: 512 }),
  optionalBoolean("returnRisk"),
  appOrWeb,
  requirement({ withPersonalNumber: false }),
  payment("/other/payment"),
]);
