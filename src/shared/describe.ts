// Shared by the server and client entry points, so it must not use Node APIs.
import type {
  ErrorCode,
  KnownErrorCode,
  KnownFailedHintCode,
  KnownPendingHintCode,
} from "../types.ts";

/**
 * The short name of one of BankID's recommended user messages. BankID
 * publishes the Swedish and English text for each one; this library returns
 * only the name. BankID writes the two variants of RFA15 and RFA17 as
 * "RFA15 (A)" and "RFA15 (B)"; here they are `RFA15A` and `RFA15B`.
 */
export type UserMessage =
  | "RFA1"
  | "RFA2"
  | "RFA3"
  | "RFA4"
  | "RFA5"
  | "RFA6"
  | "RFA8"
  | "RFA9"
  | "RFA13"
  | "RFA15A"
  | "RFA15B"
  | "RFA16"
  | "RFA17A"
  | "RFA17B"
  | "RFA19"
  | "RFA20"
  | "RFA21"
  | "RFA22"
  | "RFA23"
  | "RFA24"
  | "RFA25"
  | "RFA26"
  | "RFA27"
  | "RFA28"
  | "RFA29"
  | "RFA30";

/**
 * How the order reaches the BankID app, which decides some messages.
 * - `autoStart`: your service opens the BankID app with the autostart token,
 *   on the same device. `device` is the kind of device the user is on.
 * - `qrCode`: the user scans the animated QR code with BankID on another
 *   device.
 * - `phoneCall`: an order from `phone.auth`, `phone.sign` or `phone.payment`;
 *   the user opens the BankID app themselves while on a call with you.
 * - `other`: an order from `other.payment`; the user opens the BankID app
 *   themselves, with no QR code, autostart or call.
 */
export type DescribeContext =
  | { start: "autoStart"; device: "phone" | "desktop" }
  | { start: "qrCode" }
  | { start: "phoneCall" }
  | { start: "other" };

/**
 * Anything with an order status and an optional hint code, such as a
 * `CollectResponse` or a `RelayedStatus`.
 */
export interface WithStatus {
  status: "pending" | "complete" | "failed";
  hintCode?: string | undefined;
}

/** Anything with a BankID error code, such as a `BankIdApiError`. */
export interface WithErrorCode {
  errorCode: ErrorCode;
}

type ContextMessage = UserMessage | ((context: DescribeContext) => UserMessage);

// From the hintCode table in BankID's spec. Codes the spec gives no message
// for get the message the spec gives for an unknown code.
export const pendingMessages: Record<KnownPendingHintCode, ContextMessage> = {
  outstandingTransaction: context =>
    context.start === "autoStart" ? "RFA13" : "RFA1",
  noClient: "RFA1",
  // The spec ties `started` to the autostart token, but BankID's test
  // environment has sent it for an order started with a QR code too.
  started: context =>
    context.start === "autoStart" && context.device === "desktop"
      ? "RFA15A"
      : "RFA15B",
  userMrtd: "RFA23",
  // Only for phone orders. No message in the spec.
  userCallConfirm: "RFA21",
  userSign: "RFA9",
  processing: "RFA21",
  userStepUp: "RFA25",
  userFace: "RFA24",
};

export const failedMessages: Record<KnownFailedHintCode, ContextMessage> = {
  expiredTransaction: "RFA8",
  certificateErr: "RFA16",
  userCancel: "RFA6",
  cancelled: "RFA3",
  // RFA17B is about scanning the QR code, so every other start gets RFA17A.
  startFailed: context => (context.start === "qrCode" ? "RFA17B" : "RFA17A"),
  // Only for phone orders. No message in the spec.
  userDeclinedCall: "RFA22",
  // The spec says to ask the user to update the app, but names no message.
  notSupportedByUserApp: "RFA22",
  mrtdVerificationFailed: "RFA26",
  facialRecognitionFailed: "RFA27",
  nfcNotSupportedByDevice: "RFA28",
  multipleBankIdsOnDevice: "RFA29",
  stepUpFailed: "RFA30",
};

// From BankID's errors guide. It says the codes that point to a fault in the
// relying party's own system should not be shown as a BankID error, without
// naming a message; they get the message for an unknown code.
export const errorMessages: Record<KnownErrorCode, UserMessage> = {
  alreadyInProgress: "RFA4",
  invalidParameters: "RFA22",
  unauthorized: "RFA22",
  notFound: "RFA22",
  methodNotAllowed: "RFA22",
  requestTimeout: "RFA5",
  unsupportedMediaType: "RFA22",
  internalError: "RFA5",
  // Retry without telling the user; show this if it keeps failing.
  maintenance: "RFA5",
};

const lookup = <K extends string, V>(
  table: Record<K, V>,
  key: string | undefined,
): V | undefined =>
  typeof key === "string" && Object.hasOwn(table, key)
    ? table[key as K]
    : undefined;

/**
 * Returns BankID's recommended user message for an order status, such as a
 * collect response or a `RelayedStatus`, or `undefined` for a complete order.
 * Unknown or absent hint codes get RFA21 when pending and RFA22 when failed,
 * as BankID requires for unknown codes.
 */
export function describe<Result extends WithStatus>(
  result: Result,
  context: DescribeContext,
): UserMessage | undefined;
/**
 * Returns BankID's recommended user message for an error code. Unknown codes
 * get RFA22, as BankID requires.
 */
export function describe(error: WithErrorCode): UserMessage;
// The first overload is generic so that an object literal with more fields,
// such as a whole collect response, passes the excess property check.
export function describe(
  input: WithStatus | WithErrorCode,
  context?: DescribeContext,
): UserMessage | undefined {
  if ("errorCode" in input)
    return lookup(errorMessages, input.errorCode) ?? "RFA22";
  if (input.status !== "pending" && input.status !== "failed") return undefined;
  if (
    context?.start !== "autoStart" &&
    context?.start !== "qrCode" &&
    context?.start !== "phoneCall" &&
    context?.start !== "other"
  )
    throw new TypeError(
      'describe needs a context with start "autoStart", "qrCode", "phoneCall" or "other" for a collect result',
    );
  const message =
    input.status === "pending"
      ? (lookup(pendingMessages, input.hintCode) ?? "RFA21")
      : (lookup(failedMessages, input.hintCode) ?? "RFA22");
  return typeof message === "string" ? message : message(context);
}
