import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import axios, { AxiosError, AxiosInstance } from "axios";

//
// Type definitions for /auth
//

export interface AuthRequest {
  endUserIp: string;
  personalNumber?: string;
  requirement?: AuthOptionalRequirements;
}

export interface AuthResponse {
  autoStartToken: string;
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

export interface SignRequest extends AuthRequest {
  userVisibleData: string;
  userNonVisibleData?: string;
}

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
  "alreadyInProgress",
  "invalidParameters",
  "unauthorized",
  "notFound",
  "requestTimeout",
  "unsupportedMediaType",
  "internalError",
  "Maintenance"
}

export const REQUEST_FAILED_ERROR = "BANKID_NO_RESPONSE";

//
// Collection of overarching types
//

export enum BankIdMethod {
  auth = "auth",
  sign = "sign",
  collect = "collect",
  cancel = "cancel"
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
// Client implementation
//

export class BankIdClient {
  readonly options: BankIdClientSettings;
  readonly axios: AxiosInstance;
  readonly baseUrl: string;

  constructor(options?: BankIdClientSettings) {
    this.options = {
      refreshInterval: 2000,
      production: false,
      // defaults for test environment
      pfx: path.resolve(
        __dirname,
        "../cert/",
        "FPTestcert3_20200618.p12"
      ),
      passphrase: "qwerty123",
      // certificate is provided by package by default
      ca: undefined,
      ...options
    };

    if (this.options.production) {
      if (!options.pfx || !options.passphrase) {
        throw Error(
          "BankId requires the pfx and passphrase in production mode"
        );
      }
    }

    if (this.options.ca === undefined) {
      this.options.ca = this.options.production
        ? path.resolve(__dirname, "../cert/", "prod.ca")
        : path.resolve(__dirname, "../cert/", "test.ca");
    }

    this.axios = this._createAxiosInstance();

    this.baseUrl = this.options.production
      ? "https://appapi2.bankid.com/rp/v5/"
      : "https://appapi2.test.bankid.com/rp/v5/";
  }

  async authenticate(parameters: AuthRequest): Promise<AuthResponse> {
    if (!parameters.endUserIp) {
      throw Error("Missing required argument endUserIp.");
    }

    return this._call<AuthRequest, AuthResponse>(BankIdMethod.auth, parameters);
  }

  async sign(parameters: SignRequest): Promise<SignResponse> {
    if (!parameters.endUserIp || !parameters.userVisibleData) {
      throw Error("Missing required arguments: endUserIp, userVisibleData.");
    }

    parameters = {
      ...parameters,
      userVisibleData: Buffer.from(parameters.userVisibleData).toString(
        "base64"
      ),
      userNonVisibleData: parameters.userNonVisibleData
        ? Buffer.from(parameters.userNonVisibleData).toString("base64")
        : undefined
    };

    return this._call<SignRequest, SignResponse>(BankIdMethod.sign, parameters);
  }

  async collect(parameters: CollectRequest) {
    return this._call<CollectRequest, CollectResponse>(
      BankIdMethod.collect,
      parameters
    );
  }

  async cancel(parameters: CollectRequest): Promise<CancelResponse> {
    return this._call<CollectRequest, CancelResponse>(
      BankIdMethod.cancel,
      parameters
    );
  }

  async authenticateAndCollect(
    parameters: AuthRequest
  ): Promise<CollectResponse> {
    const authResponse = await this.authenticate(parameters);

    return this._awaitPendingCollect(authResponse.orderRef);
  }

  async signAndCollect(parameters: SignRequest): Promise<CollectResponse> {
    const signResponse = await this.sign(parameters);

    return this._awaitPendingCollect(signResponse.orderRef);
  }

  async _awaitPendingCollect(orderRef: string): Promise<CollectResponse> {
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

  async _call<req extends BankIdRequest, res extends BankIdResponse>(
    method: BankIdMethod,
    payload: req
  ): Promise<res> {
    return await new Promise((resolve, reject) => {
      this.axios
        .post<res>(this.baseUrl + method, payload)
        .then(response => {
          resolve(response.data);
        })
        .catch((error: AxiosError) => {
          let thrownError;

          if (error.response) {
            thrownError = new Error(error.response.data.errorCode);
            thrownError.details = error.response.data.details;
          } else if (error.request) {
            thrownError = new Error(REQUEST_FAILED_ERROR);
            thrownError.request = error.request;
          } else {
            thrownError = error;
          }

          reject(thrownError);
        });
    });
  }

  _createAxiosInstance() {
    const opts = this.options,
      ca = Buffer.isBuffer(opts.ca)
        ? opts.ca
        : fs.readFileSync(opts.ca, "utf-8"),
      pfx = Buffer.isBuffer(opts.pfx) ? opts.pfx : fs.readFileSync(opts.pfx),
      passphrase = opts.passphrase;

    return axios.create({
      httpsAgent: new https.Agent({ pfx, passphrase, ca }),
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
}
