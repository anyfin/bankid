import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import { AxiosInstance } from "axios";

const axios = require("axios").default;

export interface BankIdSettings {
  production: boolean;
  refreshInterval: number;
  pfx?: string;
  passphrase?: string;
  ca?: string;
}

export interface BankIdRequirement {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  issuerCn?: string[];
  autoStarkTokenRequired?: boolean;
  allowFingerprint?: boolean;
}

export interface AuthArguments {
  endUserIp: string;
  personalNumber?: string;
  requirement?: BankIdRequirement;
}

export interface SignArguments {
  endUserIp: string;
  userVisibleData: string;
  personalNumber?: string;
  userNonVisibleData?: string;
  requirement?: BankIdRequirement;
}

export interface SignAndAuthResponse {
  autoStartToken: string;
  orderRef: string;
}

export interface CollectOrCancelArguments {
  orderRef: string;
}

export interface CollectResponse {
  orderRef: string;
  status: "pending" | "failed" | "complete";
  hintCode?: FailedHintCode | PendingHintCode;
  completionData?: CompletionData;
}

export type CancelResponse = {};

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

export type BankIdMethod = "auth" | "sign" | "collect" | "cancel";
export type BankIdPayload =
  | AuthArguments
  | SignArguments
  | CollectOrCancelArguments;

export class BankIdClient {
  readonly options: BankIdSettings;
  readonly axios: AxiosInstance;
  readonly baseUrl: string;

  constructor(options?: BankIdSettings) {
    this.options = {
      refreshInterval: 2000,
      production: false,
      // defaults for test environment
      pfx: path.resolve(
        __dirname,
        "../cert/",
        "FPTestcert2_20150818_102329.pfx"
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

  async authenticate(parameters: AuthArguments): Promise<SignAndAuthResponse> {
    if (!parameters.endUserIp) {
      throw Error("Missing required argument endUserIp.");
    }

    return await this._call<AuthArguments, SignAndAuthResponse>(
      "auth",
      parameters
    );
  }

  async sign(parameters: SignArguments): Promise<SignAndAuthResponse> {
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

    return await this._call<SignArguments, SignAndAuthResponse>(
      "sign",
      parameters
    );
  }

  async collect(parameters: CollectOrCancelArguments) {
    return await this._call<CollectOrCancelArguments, CollectResponse>(
      "collect",
      parameters
    );
  }

  async cancel(parameters: CollectOrCancelArguments): Promise<CancelResponse> {
    return await this._call<CollectOrCancelArguments, CancelResponse>(
      "cancel",
      parameters
    );
  }

  async authenticateAndCollect(
    parameters: AuthArguments
  ): Promise<CollectResponse> {
    try {
      const authResponse = await this.authenticate(parameters);

      return await this._awaitPendingCollect(authResponse.orderRef);
    } catch (e) {
      throw e;
    }
  }

  async signAndCollect(parameters: SignArguments): Promise<CollectResponse> {
    try {
      const signResponse = await this.sign(parameters);

      return await this._awaitPendingCollect(signResponse.orderRef);
    } catch (e) {
      throw e;
    }
  }

  async _awaitPendingCollect(orderRef: string): Promise<CollectResponse> {
    return await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        this.collect({ orderRef })
          .then(response => {
            if (response.status === "complete") {
              resolve(response);
            } else if (response.status === "failed") {
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

  async _call<req, res>(method: BankIdMethod, payload: req): Promise<res> {
    return await new Promise((resolve, reject) => {
      this.axios
        .post<res>(this.baseUrl + method, payload)
        .then(response => {
          resolve(response.data);
        })
        .catch(error => {
          reject(error.response.data);
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
