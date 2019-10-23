import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import { AxiosInstance } from "axios";

const axios = require("axios").default;

interface BankIdSettings {
  production: boolean;
  refreshInterval: number;
  pfx?: string;
  passphrase?: string;
  ca?: string;
}

interface BankIdRequirement {
  cardReader?: "class1" | "class2";
  certificatePolicies?: string[];
  issuerCn?: string[];
  autoStarkTokenRequired?: boolean;
  allowFingerprint?: boolean;
}

interface AuthArguments {
  endUserIp: string;
  personalNumber?: string;
  requirement?: BankIdRequirement;
}

interface SignArguments {
  endUserIp: string;
  userVisibleData: string;
  personalNumber?: string;
  userNonVisibleData?: string;
  requirement?: BankIdRequirement;
}

interface SignAndAuthResponse {
  autoStartToken: string;
  orderRef: string;
}

interface CollectOrCancelArguments {
  orderRef: string;
}

interface CollectResponse {
  orderRef: string;
  status: "pending" | "failed" | "complete";
  hintCode?: FailedHintCode | PendingHintCode;
  completionData?: CompletionData;
}

type FailedHintCode =
  | "expiredTransaction"
  | "certificateErr"
  | "userCancel"
  | "cancelled"
  | "startFailed";

type PendingHintCode =
  | "outstandingTransaction"
  | "noClient"
  | "started"
  | "userSign";

interface CompletionData {
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

export class BankId {
  readonly options: BankIdSettings;
  readonly axios: AxiosInstance;
  readonly baseUrl: string;

  constructor(options?: BankIdSettings) {
    this.options = {
      refreshInterval: 1000,
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

  async authenticate(parameters: AuthArguments) {
    if (!parameters.endUserIp) {
      throw Error("Missing required argument endUserIp.");
    }

    return this.axios.post<SignAndAuthResponse>(
      this.baseUrl + "auth",
      parameters
    );
  }

  async sign(parameters: SignArguments) {
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

    return this.axios.post<SignAndAuthResponse>(
      this.baseUrl + "sign",
      parameters
    );
  }

  async collect(parameters: CollectOrCancelArguments) {
    return this.axios.post<CollectResponse>(
      this.baseUrl + "collect",
      parameters
    );
  }

  async cancel(parameters: CollectOrCancelArguments) {
    return this.axios.post<{}>(this.baseUrl + "cancel", parameters);
  }

  async authenticateAndCollect(
    parameters: AuthArguments
  ): Promise<CollectResponse> {
    const authResponse = await this.authenticate(parameters);

    return await this._awaitPendingCollect(authResponse.data.orderRef);
  }

  async signAndCollect(parameters: SignArguments): Promise<CollectResponse> {
    const signResponse = await this.sign(parameters);

    return await this._awaitPendingCollect(signResponse.data.orderRef);
  }

  _awaitPendingCollect(orderRef: string): Promise<CollectResponse> {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        this.collect({ orderRef })
          .then(res => {
            if (res.data.status === "complete") {
              resolve(res.data);
            } else if (res.data.status === "failed") {
              reject(new Error(res.data.hintCode));
            }
          })
          .catch(err => {
            reject(err);
          })
          .finally(() => {
            clearInterval(timer);
          });
      }, this.options.refreshInterval);
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
