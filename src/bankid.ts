import * as fs from "fs";
import * as https from "https";
import * as path from "path";

import type { AxiosInstance } from "axios";
import axios from "axios";
import { QrGenerator, QrGeneratorOptions } from "./qrgenerator";

//
// Utility types
//

type AtLeastOne<T> = {
  [K in keyof T]: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

type UserVisibleDataFormat = "plaintext" | "simpleMarkdownV1";

type App = AtLeastOne<{
  appIdentifier: string;
  deviceOS: string;
  deviceModelName: string;
  deviceIdentifier: string;
}>;

type Web = AtLeastOne<{
  deviceIdentifier: string;
  referringDomain: string;
  userAgent: string;
}>;

//
// Type definitions for /auth
//

export interface AuthRequestV5 {
  endUserIp: string;
  personalNumber?: string;
  requirement?: AuthOptionalRequirements;
  userVisibleData?: string;
  userVisibleDataFormat?: UserVisibleDataFormat;
  userNonVisibleData?: string;
  returnUrl?: string;
  returnRisk?: boolean;
  app?: App;
  web?: Web;
}

export interface AuthResponse {
  /**
   * Use in deeplink to start BankId on same device.
   * @example `bankid:///?autostarttoken=[TOKEN]&redirect=[RETURNURL]`
   */
  autoStartToken: string;
  qrStartSecret: string;
  qrStartToken: string;
  orderRef: string;
}

interface AuthOptionalRequirements {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  mrtd?: boolean;
  personalNumber?: string;
  pinCode?: boolean;
}


//
// Type definitions for /sign
//

export interface SignRequest extends AuthRequestV5 {
  userVisibleData: string;
}

export interface SignResponse extends AuthResponse {}

//
// Type definitions for /payment
//

export interface PaymentRequest {
  endUserIp: string;
  userVisibleTransaction: UserVisibleTransaction;
  returnUrl?: string;
  returnRisk?: boolean;
  riskFlags?: RiskFlag[];
  userVisibleData?: string;
  userVisibleDataFormat?: UserVisibleDataFormat;
  userNonVisibleData?: string;
  app?: App;
  web?: Web;
  requirement?: PaymentRequirement;
}

export interface PaymentResponse extends AuthResponse {}

interface UserVisibleTransaction {
  transactionType: "card" | "npa";
  recipient: {
    name: string;
  };
  money?: {
    amount: string;
    currency: string;
  };
  riskWarning?: RiskWarning;
}

type RiskFlag = 
  | "newCard"
  | "newCustomer" 
  | "newRecipient"
  | "highRiskRecipient"
  | "largeAmount"
  | "foreignCurrency"
  | "cryptoCurrencyPurchase"
  | "moneyTransfer"
  | "overseasTransaction"
  | "recurringPayment"
  | "suspiciousPaymentPattern"
  | "other";

type RiskWarning = string;

interface PaymentRequirement {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  mrtd?: boolean;
  personalNumber?: string;
  pinCode?: boolean;
}

//
// Type definitions for /phone/auth
//

export interface PhoneAuthRequest {
  callInitiator: "user" | "RP";
  personalNumber?: string;
  userVisibleData?: string;
  userVisibleDataFormat?: UserVisibleDataFormat;
  userNonVisibleData?: string;
  requirement?: PhoneAuthRequirement;
}

export interface PhoneAuthResponse {
  orderRef: string;
}

interface PhoneAuthRequirement {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  mrtd?: boolean;
  pinCode?: boolean;
}

//
// Type definitions for /phone/sign
//

export interface PhoneSignRequest {
  callInitiator: "user" | "RP";
  userVisibleData: string;
  personalNumber?: string;
  userVisibleDataFormat?: UserVisibleDataFormat;
  userNonVisibleData?: string;
  requirement?: PhoneSignRequirement;
}

export interface PhoneSignResponse {
  orderRef: string;
}

interface PhoneSignRequirement {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  mrtd?: boolean;
  pinCode?: boolean;
}

//
// Type definitions for /other/payment
//

export interface OtherPaymentRequest {
  personalNumber: string;
  userVisibleTransaction: UserVisibleTransaction;
  returnUrl?: string;
  returnRisk?: boolean;
  riskFlags?: RiskFlag[];
  userVisibleData?: string;
  userVisibleDataFormat?: UserVisibleDataFormat;
  userNonVisibleData?: string;
  app?: App;
  web?: Web;
  requirement?: OtherPaymentRequirement;
}

export interface OtherPaymentResponse {
  orderRef: string;
}

interface OtherPaymentRequirement {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  mrtd?: boolean;
  pinCode?: boolean;
  risk?: "low" | "moderate";
}

//
// Type definitions for /collect
//

export interface CollectRequest {
  orderRef: string;
}

type CollectResponse = CollectResponseV5 | CollectResponseV6;
export interface CollectResponseV5 {
  orderRef: string;
  status: "pending" | "failed" | "complete";
  hintCode?: FailedHintCode | PendingHintCode;
  completionData?: CompletionData;
}

export interface CompletionData {
  user: {
    personalNumber: string;
    name: string;
    givenName: string;
    surname: string;
  };
  device: {
    ipAddress: string;
    uhi?: string;
  };
  bankIdIssueDate?: string;
  stepUp?: {
    mrtd?: boolean;
  };
  signature?: string;
  ocspResponse?: string;
  risk?: "low" | "moderate" | "high";
}

export type FailedHintCode =
  | "expiredTransaction"
  | "certificateErr"
  | "userCancel"
  | "cancelled"
  | "startFailed"
  | "userDeclinedCall"
  | "notSupportedByUserApp"
  | "transactionRiskBlocked";

export type PendingHintCode =
  | "outstandingTransaction"
  | "noClient"
  | "started"
  | "userMrtd"
  | "userCallConfirm"
  | "userSign"
  | "processing";

//
// Type definitions for /cancel
//

export interface CancelRequest extends CollectRequest {}

export interface CancelResponse {}

//
// Type definitions for error responses
//

export interface ErrorResponse {
  errorCode: BankIdErrorCode;
  details: string;
}

export enum BankIdErrorCode {
  ALREADY_IN_PROGRESS = "alreadyInProgress",
  INVALID_PARAMETERS = "invalidParameters",
  UNAUTHORIZED = "unauthorized",
  NOT_FOUND = "notFound",
  METHOD_NOT_ALLOWED = "methodNotAllowed",
  REQUEST_TIMEOUT = "requestTimeout",
  UNSUPPORTED_MEDIA_TYPE = "unsupportedMediaType",
  INTERNAL_ERROR = "internalError",
  MAINTENANCE = "maintenance",
}

export const REQUEST_FAILED_ERROR = "BANKID_NO_RESPONSE";

//
// Collection of overarching types
//

export enum BankIdMethod {
  auth = "auth",
  sign = "sign",
  payment = "payment",
  phoneAuth = "phone/auth",
  phoneSign = "phone/sign",
  otherPayment = "other/payment",
  collect = "collect",
  cancel = "cancel",
}

export type BankIdRequest =
  | AuthRequestV5
  | SignRequest
  | PaymentRequest
  | PhoneAuthRequest
  | PhoneSignRequest
  | OtherPaymentRequest
  | CollectRequest
  | CancelRequest;

export type BankIdResponse =
  | CancelResponse
  | AuthResponse
  | SignResponse
  | PaymentResponse
  | PhoneAuthResponse
  | PhoneSignResponse
  | OtherPaymentResponse
  | CollectResponseV5
  | CollectResponseV6;

//
// Client settings
//

interface BankIdClientSettings {
  production: boolean;
  refreshInterval?: number;
  pfx?: string | Buffer;
  passphrase?: string;
  ca?: string | Buffer;
}

//
// Error types
//

export class BankIdError extends Error {
  readonly code: BankIdErrorCode;
  readonly details?: string;

  constructor(code: BankIdErrorCode, details?: string) {
    super(code);
    Error.captureStackTrace(this, this.constructor);

    this.name = "BankIdError";
    this.code = code;
    this.details = details;
  }
}

export class RequestError extends Error {
  readonly request?: any;

  constructor(request?: any) {
    super(REQUEST_FAILED_ERROR);
    Error.captureStackTrace(this, this.constructor);

    this.name = "RequestError";
    this.request = request;
  }
}

//
// Client implementation
//

export class BankIdClient {
  readonly options: Required<BankIdClientSettings>;
  axios: AxiosInstance;

  version = "v5.1";

  constructor(options?: BankIdClientSettings) {
    this.options = {
      production: false,
      refreshInterval: 2000,
      ...options,
    } as Required<BankIdClientSettings>;

    if (this.options.production) {
      if (!options?.pfx || !options?.passphrase) {
        throw new Error(
          "BankId requires the pfx and passphrase in production mode",
        );
      }
    } else {
      // Provide default PFX & passphrase in test
      if (this.options.pfx === undefined) {
        this.options.pfx = path.resolve(
          __dirname,
          "../cert/",
          "FPTestcert5_20240610.p12",
        );
      }

      if (this.options.passphrase === undefined) {
        this.options.passphrase = "qwerty123";
      }
    }

    // Provide certificate by default
    if (this.options.ca === undefined) {
      this.options.ca = this.options.production
        ? path.resolve(__dirname, "../cert/", "prod.ca")
        : path.resolve(__dirname, "../cert/", "test.ca");
    }

    this.axios = this.createAxiosInstance();
    return this;
  }

  authenticate(parameters: AuthRequestV5): Promise<AuthResponse> {
    if (!parameters.endUserIp) {
      throw new Error("Missing required argument endUserIp.");
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1" &&
      parameters.userVisibleDataFormat !== "plaintext"
    ) {
      throw new Error("userVisibleDataFormat can only be plaintext or simpleMarkdownV1.");
    }

    parameters = {
      ...parameters,
      userVisibleData: parameters.userVisibleData
        ? Buffer.from(parameters.userVisibleData).toString("base64")
        : undefined,
      userNonVisibleData: parameters.userNonVisibleData
        ? Buffer.from(parameters.userNonVisibleData).toString("base64")
        : undefined,
    };

    return this.#call<AuthRequestV5, AuthResponse>(
      BankIdMethod.auth,
      parameters,
    );
  }

  sign(parameters: SignRequest): Promise<SignResponse> {
    if (!parameters.endUserIp || !parameters.userVisibleData) {
      throw new Error(
        "Missing required arguments: endUserIp, userVisibleData.",
      );
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1" &&
      parameters.userVisibleDataFormat !== "plaintext"
    ) {
      throw new Error("userVisibleDataFormat can only be plaintext or simpleMarkdownV1.");
    }

    parameters = {
      ...parameters,
      userVisibleData: Buffer.from(parameters.userVisibleData).toString(
        "base64",
      ),
      userNonVisibleData: parameters.userNonVisibleData
        ? Buffer.from(parameters.userNonVisibleData).toString("base64")
        : undefined,
    };

    return this.#call<SignRequest, SignResponse>(BankIdMethod.sign, parameters);
  }

  collect(parameters: CollectRequest) {
    return this.#call<CollectRequest, CollectResponse>(
      BankIdMethod.collect,
      parameters,
    );
  }

  cancel(parameters: CollectRequest): Promise<CancelResponse> {
    return this.#call<CollectRequest, CancelResponse>(
      BankIdMethod.cancel,
      parameters,
    );
  }

  payment(parameters: PaymentRequest): Promise<PaymentResponse> {
    if (!parameters.endUserIp || !parameters.userVisibleTransaction) {
      throw new Error(
        "Missing required arguments: endUserIp, userVisibleTransaction.",
      );
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1" &&
      parameters.userVisibleDataFormat !== "plaintext"
    ) {
      throw new Error("userVisibleDataFormat can only be plaintext or simpleMarkdownV1.");
    }

    const payload = {
      ...parameters,
      userVisibleData: parameters.userVisibleData
        ? Buffer.from(parameters.userVisibleData).toString("base64")
        : undefined,
      userNonVisibleData: parameters.userNonVisibleData
        ? Buffer.from(parameters.userNonVisibleData).toString("base64")
        : undefined,
    };

    return this.#call<PaymentRequest, PaymentResponse>(
      BankIdMethod.payment,
      payload,
    );
  }

  phoneAuth(parameters: PhoneAuthRequest): Promise<PhoneAuthResponse> {
    if (!parameters.callInitiator) {
      throw new Error("Missing required argument: callInitiator.");
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1" &&
      parameters.userVisibleDataFormat !== "plaintext"
    ) {
      throw new Error("userVisibleDataFormat can only be plaintext or simpleMarkdownV1.");
    }

    const payload = {
      ...parameters,
      userVisibleData: parameters.userVisibleData
        ? Buffer.from(parameters.userVisibleData).toString("base64")
        : undefined,
      userNonVisibleData: parameters.userNonVisibleData
        ? Buffer.from(parameters.userNonVisibleData).toString("base64")
        : undefined,
    };

    return this.#call<PhoneAuthRequest, PhoneAuthResponse>(
      BankIdMethod.phoneAuth,
      payload,
    );
  }

  phoneSign(parameters: PhoneSignRequest): Promise<PhoneSignResponse> {
    if (!parameters.callInitiator || !parameters.userVisibleData) {
      throw new Error(
        "Missing required arguments: callInitiator, userVisibleData.",
      );
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1" &&
      parameters.userVisibleDataFormat !== "plaintext"
    ) {
      throw new Error("userVisibleDataFormat can only be plaintext or simpleMarkdownV1.");
    }

    const payload = {
      ...parameters,
      userVisibleData: Buffer.from(parameters.userVisibleData).toString("base64"),
      userNonVisibleData: parameters.userNonVisibleData
        ? Buffer.from(parameters.userNonVisibleData).toString("base64")
        : undefined,
    };

    return this.#call<PhoneSignRequest, PhoneSignResponse>(
      BankIdMethod.phoneSign,
      payload,
    );
  }

  otherPayment(parameters: OtherPaymentRequest): Promise<OtherPaymentResponse> {
    if (!parameters.personalNumber || !parameters.userVisibleTransaction) {
      throw new Error(
        "Missing required arguments: personalNumber, userVisibleTransaction.",
      );
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1" &&
      parameters.userVisibleDataFormat !== "plaintext"
    ) {
      throw new Error("userVisibleDataFormat can only be plaintext or simpleMarkdownV1.");
    }

    const payload = {
      ...parameters,
      userVisibleData: parameters.userVisibleData
        ? Buffer.from(parameters.userVisibleData).toString("base64")
        : undefined,
      userNonVisibleData: parameters.userNonVisibleData
        ? Buffer.from(parameters.userNonVisibleData).toString("base64")
        : undefined,
    };

    return this.#call<OtherPaymentRequest, OtherPaymentResponse>(
      BankIdMethod.otherPayment,
      payload,
    );
  }

  _awaitPendingCollect(orderRef: string) {
    console.warn("This method has been renamed to 'awaitPendingCollect");
    return this.awaitPendingCollect(orderRef);
  }

  async authenticateAndCollect(
    parameters: AuthRequestV5,
  ): Promise<CollectResponse> {
    const authResponse = await this.authenticate(parameters);
    return this.awaitPendingCollect(authResponse.orderRef);
  }

  async signAndCollect(parameters: SignRequest): Promise<CollectResponse> {
    const signResponse = await this.sign(parameters);

    return this.awaitPendingCollect(signResponse.orderRef);
  }

  awaitPendingCollect(orderRef: string): Promise<CollectResponse> {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        this.collect({ orderRef })
          .then(response => {
            if (response.status === "complete") {
              clearInterval(timer);
              resolve(response);
            } else if (response.status === "failed") {
              clearInterval(timer);
              reject(response);
            }
          })
          .catch(error => {
            clearInterval(timer);
            reject(error);
          });
      }, this.options.refreshInterval);
    });
  }

  #call<Req extends BankIdRequest, Res extends BankIdResponse>(
    method: BankIdMethod,
    payload: Req,
  ): Promise<Res> {
    return new Promise((resolve, reject) => {
      this.axios
        .post<Res>(method, payload)
        .then(response => {
          resolve(response.data);
        })
        .catch((error: unknown) => {
          let thrownError = error;

          if (axios.isAxiosError(error)) {
            if (error.response) {
              thrownError = new BankIdError(
                error.response.data.errorCode,
                error.response.data.details,
              );
            } else if (error.request) {
              thrownError = new RequestError(error.request);
            }
          }

          reject(thrownError);
        });
    });
  }

  createAxiosInstance(): AxiosInstance {
    const baseURL = this.options.production
      ? `https://appapi2.bankid.com/rp/${this.version}/`
      : `https://appapi2.test.bankid.com/rp/${this.version}/`;

    const ca = Buffer.isBuffer(this.options.ca)
      ? this.options.ca
      : fs.readFileSync(this.options.ca, "utf-8");
    const pfx = Buffer.isBuffer(this.options.pfx)
      ? this.options.pfx
      : fs.readFileSync(this.options.pfx);
    const passphrase = this.options.passphrase;

    return axios.create({
      baseURL,
      httpsAgent: new https.Agent({ pfx, passphrase, ca }),
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}

interface AuthOptionalRequirementsV6 {
  pinCode: boolean;
  cardReader?: "class1" | "class2";
  mrtd: boolean;
  certificatePolicies?: string[];
  personalNumber: string;
}

export interface AuthRequestV6 {
  endUserIp: string;
  requirement?: AuthOptionalRequirementsV6;
}

interface AuthResponseV6 extends AuthResponse {
  qr?: QrGenerator;
}

interface SignResponseV6 extends SignResponse {
  qr?: QrGenerator;
}

export interface CompletionDataV6 {
  user: {
    personalNumber: string;
    name: string;
    givenName: string;
    surname: string;
  };
  device: {
    ipAddress: string;
    uhi?: string;
  };
  /** ISO 8601 date format YYYY-MM-DD with a UTC time zone offset. */
  bankIdIssueDate: string;
  stepUp: boolean;
  signature: string;
  ocspResponse: string;
}

export interface CollectResponseV6
  extends Omit<CollectResponseV5, "completionData"> {
  completionData?: CompletionDataV6;
}

interface BankIdClientSettingsV6 extends BankIdClientSettings {
  /** Controls whether to attach an instance of {@link QrGenerator} to BankID responses  */
  qrEnabled?: boolean;
  qrOptions?: QrGeneratorOptions;
}

/**
 * A class for creating a BankId Client based on v6.0 api, extending from BankIdClient
 * @see https://www.bankid.com/en/utvecklare/guider/teknisk-integrationsguide/webbservice-api
 */
export class BankIdClientV6 extends BankIdClient {
  version = "v6.0";
  options: Required<BankIdClientSettingsV6>;

  constructor(options: BankIdClientSettingsV6) {
    super(options);
    this.axios = this.createAxiosInstance();
    this.options = {
      // @ts-expect-error this.options not typed after super() call.
      ...(this.options as Required<BankIdClientSettings>),
      qrEnabled: options.qrEnabled ?? true,
      qrOptions: options.qrOptions ?? QrGenerator.defaultOptions,
    };
  }

  async authenticate(parameters: AuthRequestV6): Promise<AuthResponseV6> {
    const resp = await super.authenticate(parameters);
    const qr = this.options.qrEnabled
      ? new QrGenerator(resp, this.options.qrOptions)
      : undefined;
    return { ...resp, qr };
  }

  async sign(parameters: SignRequest): Promise<SignResponseV6> {
    const resp = await super.sign(parameters);
    const qr = this.options.qrEnabled
      ? new QrGenerator(resp, this.options.qrOptions)
      : undefined;
    return { ...resp, qr };
  }

  async collect(parameters: CollectRequest) {
    return super.collect(parameters) as Promise<CollectResponseV6>;
  }
}
