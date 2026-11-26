// Public protocol types. They are written by hand for readable names and
// documentation, but derived from the generated spec types wherever the spec
// defines the shape, so a change to the spec shows up as a type error here.
import type { components } from "./generated/auth-sign.ts";

import type {
  FailedHintCode,
  KnownFailedHintCode,
  KnownPendingHintCode,
  OrOther,
  PendingHintCode,
} from "./shared/hint-codes.ts";

export type {
  FailedHintCode,
  KnownFailedHintCode,
  KnownPendingHintCode,
  OrOther,
  PendingHintCode,
};

type Schemas = components["schemas"];

/** Fields BankID expects base64-encoded, which this library encodes for you. */
type EncodedText = "userVisibleData" | "userNonVisibleData";

/** Request for {@link BankIdClient.auth}. */
export interface AuthRequest extends Omit<
  Schemas["auth_request"],
  EncodedText | "requirement"
> {
  /** Text shown to the user, as plain text. The library base64-encodes it. */
  userVisibleData?: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["auth_request_requirement"];
}

/** Request for {@link BankIdClient.sign}. */
export interface SignRequest extends Omit<
  Schemas["sign_request"],
  EncodedText | "requirement"
> {
  /** Text the user signs, as plain text. The library base64-encodes it. */
  userVisibleData: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["sign_request_requirement"];
}

/** Response to starting an auth or sign order. */
export type OrderResponse = Schemas["order_response"];

/**
 * Who started the phone call: `"user"` when the user called you, `"RP"` when
 * you called the user.
 */
export type CallInitiator = Schemas["callInitiator"];

/** Request for {@link BankIdPhoneClient.auth}. */
export interface PhoneAuthRequest extends Omit<
  Schemas["phoneAuth_request"],
  EncodedText | "requirement"
> {
  /** Text shown to the user, as plain text. The library base64-encodes it. */
  userVisibleData?: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["phoneAuth_request_requirement"];
}

/** Request for {@link BankIdPhoneClient.sign}. */
export interface PhoneSignRequest extends Omit<
  Schemas["phoneSign_request"],
  EncodedText | "requirement"
> {
  /** Text the user signs, as plain text. The library base64-encodes it. */
  userVisibleData: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["phoneSign_request_requirement"];
}

/**
 * Response to starting a phone order: only the order reference. There is no
 * QR code or autostart token, since the user opens the BankID app themselves.
 */
export type PhoneOrderResponse = Schemas["limited_response"];

/**
 * A monetary amount. `amount` is digits with at most one `","` as the decimal
 * separator, such as `"100,00"`; `currency` is an ISO 4217 code such as
 * `"SEK"`.
 */
export type Money = Schemas["Money"];

/**
 * A warning the BankID app shows with the payment, such as `"largeAmount"`.
 * There is room for one per payment.
 */
export type RiskWarning = Schemas["riskWarning"];

/**
 * A flag for BankID's risk assessment, never shown to the user. BankID
 * documents them as not yet used.
 */
export type RiskFlag = Schemas["riskFlags"][number];

/** The kinds of transaction a payment order can approve. */
export type TransactionType = NonNullable<
  Schemas["UserVisibleTransactionParentType"]["transactionType"]
>;

/** The kinds of transaction a bulk payment order can hold. */
export type BulkTransactionType = Schemas["TransactionBulk"]["transactionType"];

/** Fields every transaction type takes. */
interface TransactionFields extends Omit<
  Schemas["UserVisibleTransactionParentType"],
  "transactionType" | "recurring" | "thirdPartyInitiatorB64"
> {
  /** Whether to show the payment as recurring. Default false. */
  recurring?: boolean;
  /**
   * The third party initiating the payment, as plain text of at most 40
   * characters. The library sends it base64-encoded as
   * `thirdPartyInitiatorB64`.
   */
  thirdPartyInitiator?: string;
}

/**
 * The recipient of a card payment (the merchant) or of a non-payment
 * authentication.
 */
export interface NamedRecipient extends Omit<
  Schemas["RecipientCard"],
  "name" | "nameB64"
> {
  /**
   * The name shown to the user, as plain text of at most 40 characters. The
   * library sends it base64-encoded as `nameB64`.
   */
  name: string;
}

/** The recipient of a bankgiro, plusgiro or bank transfer. */
export interface AccountRecipient extends Omit<
  Schemas["RecipientBankgiro"],
  "nameB64"
> {
  /**
   * The name shown to the user, as plain text of at most 40 characters. The
   * library sends it base64-encoded as `nameB64`.
   */
  name?: string;
}

interface DirectRecipientFields extends Omit<
  Schemas["RecipientDirect"],
  "nameB64" | "legalNameB64"
> {
  /**
   * The name shown to the user, as plain text of at most 40 characters. The
   * library sends it base64-encoded as `nameB64`.
   */
  name?: string;
  /**
   * The recipient's legal name, as plain text of at most 40 characters. The
   * library sends it base64-encoded as `legalNameB64`.
   */
  legalName?: string;
}

/**
 * The recipient of a direct payment: at least one of `name`, `legalName`,
 * `accountNumber` and `phoneNumber`.
 */
export type DirectRecipient = DirectRecipientFields &
  (
    | { name: string }
    | { legalName: string }
    | { accountNumber: string }
    | { phoneNumber: string }
  );

/** A card payment. `money` is optional. */
export interface CardTransaction extends TransactionFields {
  transactionType: "card";
  recipient: NamedRecipient;
  money?: Money;
}

/** A non-payment authentication. It takes no `money`. */
export interface NpaTransaction extends TransactionFields {
  transactionType: "npa";
  recipient: NamedRecipient;
  money?: never;
}

/** Fields of the transfer types, which all need an account, money and a date. */
interface TransferFields extends TransactionFields {
  recipient: AccountRecipient;
  money: Money;
  /** The date of the payment, as `YYYY-MM-DD`. */
  date: string;
}

/** A bankgiro payment. */
export interface BankgiroTransaction extends TransferFields {
  transactionType: "bankgiro";
}

/** A plusgiro payment. */
export interface PlusgiroTransaction extends TransferFields {
  transactionType: "plusgiro";
}

/** A transfer within the same bank. */
export interface SameBankTransaction extends TransferFields {
  transactionType: "samebank";
}

/** A transfer to another Swedish bank. */
export interface DomesticBankTransaction extends TransferFields {
  transactionType: "domesticbank";
}

/** A transfer to a foreign bank. */
export interface ForeignBankTransaction extends TransferFields {
  transactionType: "foreignbank";
}

/** A direct payment. */
export interface DirectTransaction extends TransactionFields {
  transactionType: "direct";
  recipient: DirectRecipient;
  money: Money;
}

/**
 * The transaction the user approves, discriminated on `transactionType`. Text
 * fields are plain strings; the library base64-encodes them.
 */
export type UserVisibleTransaction =
  | CardTransaction
  | NpaTransaction
  | BankgiroTransaction
  | PlusgiroTransaction
  | SameBankTransaction
  | DomesticBankTransaction
  | ForeignBankTransaction
  | DirectTransaction;

interface FromAccountFields extends Omit<
  Schemas["UserVisibleTransactionBulk_payments_inner_allOf_fromAccount"],
  "nameB64"
> {
  /**
   * The account's name, as plain text of at most 40 characters. The library
   * sends it base64-encoded as `nameB64`.
   */
  name?: string;
}

/**
 * The account a bulk payment is taken from: a name or an account number.
 * BankID rejects an account with both.
 */
export type FromAccount = FromAccountFields &
  (
    | { name: string; accountNumber?: never }
    | { accountNumber: string; name?: never }
  );

/**
 * One payment in a bulk payment order: a bankgiro, plusgiro or bank transfer.
 * Bulk payments cannot be recurring.
 */
export interface BulkPayment extends Omit<
  Schemas["UserVisibleTransactionBulk_payments_inner"],
  "recipient" | "fromAccount" | "money"
> {
  recipient: AccountRecipient;
  money: Money;
  /**
   * The account the payment is taken from. Adjacent payments with the same
   * account are grouped together in the app.
   */
  fromAccount?: FromAccount;
  recurring?: never;
}

/** The payments the user approves in one bulk payment order. */
export interface UserVisibleTransactionBulk {
  /** 1 to 40 payments. */
  payments: readonly BulkPayment[];
  /** 1 to 4 sums to show, such as one per currency. */
  sums: readonly Money[];
  /**
   * The third party initiating the payments, as plain text of at most 40
   * characters. The library sends it base64-encoded as
   * `thirdPartyInitiatorB64`.
   */
  thirdPartyInitiator?: string;
}

/** Request for {@link BankIdPaymentClient}. */
export interface PaymentRequest extends Omit<
  Schemas["payment_request"],
  EncodedText | "requirement" | "userVisibleTransaction"
> {
  /** Text shown to the user, as plain text. The library base64-encodes it. */
  userVisibleData?: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** The payment the user approves. */
  userVisibleTransaction: UserVisibleTransaction;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["payment_request_requirement"];
}

/**
 * Request for {@link BankIdPaymentClient.bulk}. It takes no
 * `userVisibleDataFormat`, since bulk payments show plain text only.
 */
export interface PaymentBulkRequest extends Omit<
  Schemas["paymentBulk_request"],
  EncodedText | "requirement" | "userVisibleTransactionBulk"
> {
  /** Text shown to the user, as plain text. The library base64-encodes it. */
  userVisibleData?: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** The payments the user approves. */
  userVisibleTransactionBulk: UserVisibleTransactionBulk;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["payment_request_requirement"];
}

/** Request for {@link BankIdPhonePaymentClient}. */
export interface PhonePaymentRequest extends Omit<
  Schemas["phonePayment_request"],
  EncodedText | "requirement" | "userVisibleTransaction"
> {
  /** Text shown to the user, as plain text. The library base64-encodes it. */
  userVisibleData?: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** The payment the user approves. */
  userVisibleTransaction: UserVisibleTransaction;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["phoneSign_request_requirement"];
}

/**
 * Request for {@link BankIdPhonePaymentClient.bulk}. It takes no
 * `userVisibleDataFormat`, since bulk payments show plain text only.
 */
export interface PhonePaymentBulkRequest extends Omit<
  Schemas["phonePaymentBulk_request"],
  EncodedText | "requirement" | "userVisibleTransactionBulk"
> {
  /** Text shown to the user, as plain text. The library base64-encodes it. */
  userVisibleData?: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** The payments the user approves. */
  userVisibleTransactionBulk: UserVisibleTransactionBulk;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["phoneSign_request_requirement"];
}

/**
 * Request for {@link BankIdOtherClient.payment}. Only a card payment or a
 * non-payment authentication.
 */
export interface OtherPaymentRequest extends Omit<
  Schemas["otherPayment_request"],
  EncodedText | "requirement" | "userVisibleTransaction"
> {
  /** Text shown to the user, as plain text. The library base64-encodes it. */
  userVisibleData?: string;
  /** Data not shown to the user, as plain text. The library base64-encodes it. */
  userNonVisibleData?: string;
  /** The card payment or non-payment authentication the user approves. */
  userVisibleTransaction: CardTransaction | NpaTransaction;
  /** Conditions the user and their BankID must meet to complete the order. */
  requirement?: Schemas["otherPayment_request_requirement"];
}

/**
 * Response to starting an order with {@link BankIdOtherClient.payment}: only
 * the order reference. There is no QR code or autostart token; the user opens
 * the BankID app themselves.
 */
export type OtherOrderResponse = Schemas["limited_response"];

type CollectStatus = Schemas["collect_response"]["status"];
type CollectBase<S extends CollectStatus> = Omit<
  Schemas["collect_response"],
  "status" | "hintCode" | "completionData"
> & { status: S };

/** Risk levels BankID documents for a completed order. */
export type KnownRiskLevel = Schemas["risk"];

/**
 * The risk level BankID gives a completed order: a documented one or any
 * other string, since BankID may add levels without notice, so handle a
 * level you do not recognise.
 */
export type RiskLevel = OrOther<KnownRiskLevel>;

/** Information about the user and the completed order. */
export interface CompletionData extends Omit<
  Schemas["collect_response_completionData"],
  "risk"
> {
  /**
   * The risk level of the order, only when the order asked for it with
   * `returnRisk` and BankID could work it out. See {@link RiskLevel}.
   */
  risk?: RiskLevel;
}

/** The order is still in progress; keep collecting. */
export interface CollectPending extends CollectBase<"pending"> {
  /**
   * What is happening with the order, to show the user the right message.
   * BankID's spec does not require it; without one, `describe` gives RFA21.
   */
  hintCode?: PendingHintCode | undefined;
}

/** The order is complete. Do not collect it again. */
export interface CollectComplete extends CollectBase<"complete"> {
  completionData: CompletionData;
}

/** The order failed. Do not collect it again. */
export interface CollectFailed extends CollectBase<"failed"> {
  /**
   * Why the order failed, to show the user the right message. BankID's spec
   * does not require it; without one, `describe` gives RFA22.
   */
  hintCode?: FailedHintCode | undefined;
}

/** Response from {@link BankIdClient.collect}, discriminated on `status`. */
export type CollectResponse = CollectPending | CollectComplete | CollectFailed;

/** Error codes BankID documents for the auth and sign API. */
export type KnownErrorCode =
  | "alreadyInProgress"
  | "invalidParameters"
  | "unauthorized"
  | "notFound"
  | "methodNotAllowed"
  | "requestTimeout"
  | "unsupportedMediaType"
  | "internalError"
  | "maintenance";

/** Error code from BankID: a documented one or any other string. */
export type ErrorCode = OrOther<KnownErrorCode>;
