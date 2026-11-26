// Shared by the server and client entry points, so it must not use Node APIs.

/**
 * A known value or any other string. BankID may add new codes without notice,
 * so callers must handle values they do not recognise. The `string & {}` form
 * keeps editor completion for the known values.
 */
export type OrOther<Known extends string> = Known | (string & {});

/** Hint codes BankID documents for a pending order. */
export type KnownPendingHintCode =
  | "outstandingTransaction"
  | "noClient"
  | "started"
  | "userMrtd"
  | "userCallConfirm"
  | "userSign"
  | "processing"
  | "userStepUp"
  | "userFace";

/** Hint codes BankID documents for a failed order. */
export type KnownFailedHintCode =
  | "expiredTransaction"
  | "certificateErr"
  | "userCancel"
  | "cancelled"
  | "startFailed"
  | "userDeclinedCall"
  | "notSupportedByUserApp"
  | "mrtdVerificationFailed"
  | "facialRecognitionFailed"
  | "nfcNotSupportedByDevice"
  | "multipleBankIdsOnDevice"
  | "stepUpFailed";

/** Hint code of a pending order: a documented one or any other string. */
export type PendingHintCode = OrOther<KnownPendingHintCode>;

/** Hint code of a failed order: a documented one or any other string. */
export type FailedHintCode = OrOther<KnownFailedHintCode>;
