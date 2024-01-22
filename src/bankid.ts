import * as fs from "fs";
import * as https from "https";
import * as path from "path";

import type { AxiosInstance } from "axios";
import axios from "axios";

//
// Type definitions for /auth
//

export interface AuthRequest {
  endUserIp: string;
  personalNumber?: string;
  requirement?: AuthOptionalRequirements;
  userVisibleData: string;
  userVisibleDataFormat?: "simpleMarkdownV1";
  userNonVisibleData?: string;
}

export interface AuthResponse {
  autoStartToken: string;
  qrStartSecret: string;
  qrStartToken: string;
  orderRef: string;
}

interface AuthOptionalRequirements {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  issuerCn?: string[];
  autoStartTokenRequired?: boolean;
  allowFingerprint?: boolean;
}

//
// Type definitions for /sign
//

export interface SignRequest extends AuthRequest {}

export interface SignResponse extends AuthResponse {}

//
// Type definitions for /collect
//

export interface CollectRequest {
  orderRef: string;
}

export interface CollectResponse {
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
  };
  cert: {
    notBefore: string;
    notAfter: string;
  };
  signature: string;
  ocspResponse: string;
}

export type FailedHintCode =
  | "expiredTransaction"
  | "certificateErr"
  | "userCancel"
  | "cancelled"
  | "startFailed";

export type PendingHintCode =
  | "outstandingTransaction"
  | "noClient"
  | "started"
  | "userSign";

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
  collect = "collect",
  cancel = "cancel",
}

export type BankIdRequest =
  | AuthRequest
  | SignRequest
  | CollectRequest
  | CancelRequest;

export type BankIdResponse =
  | CancelResponse
  | AuthResponse
  | SignResponse
  | CollectResponse;

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
  readonly axios: AxiosInstance;
  readonly baseUrl: string;

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
          "FPTestcert4_20230629.p12",
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

    this.axios = this.#createAxiosInstance();

    this.baseUrl = this.options.production
      ? "https://appapi2.bankid.com/rp/v5.1/"
      : "https://appapi2.test.bankid.com/rp/v5.1/";
  }

  authenticate(parameters: AuthRequest): Promise<AuthResponse> {
    if (!parameters.endUserIp) {
      throw new Error("Missing required argument endUserIp.");
    }

    return this.#call<AuthRequest, AuthResponse>(BankIdMethod.auth, parameters);
  }

  sign(parameters: SignRequest): Promise<SignResponse> {
    if (!parameters.endUserIp || !parameters.userVisibleData) {
      throw new Error(
        "Missing required arguments: endUserIp, userVisibleData.",
      );
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1"
    ) {
      throw new Error("userVisibleDataFormat can only be simpleMarkdownV1.");
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

  _awaitPendingCollect(orderRef: string) {
    console.warn("This method has been renamed to 'awaitPendingCollect");
    return this.awaitPendingCollect(orderRef);
  }

  async authenticateAndCollect(
    parameters: AuthRequest,
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
        .post<Res>(this.baseUrl + method, payload)
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

  #createAxiosInstance(): AxiosInstance {
    const ca = Buffer.isBuffer(this.options.ca)
      ? this.options.ca
      : fs.readFileSync(this.options.ca, "utf-8");
    const pfx = Buffer.isBuffer(this.options.pfx)
      ? this.options.pfx
      : fs.readFileSync(this.options.pfx);
    const passphrase = this.options.passphrase;

    return axios.create({
      httpsAgent: new https.Agent({ pfx, passphrase, ca }),
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
