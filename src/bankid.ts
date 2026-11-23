import * as fs from "fs";
import * as https from "https";
import * as path from "path";

import { QrGenerator, QrGeneratorOptions } from "./qrgenerator";

//
// Type definitions for /auth
//

export type UserVisibleDataFormat = "plaintext" | "simpleMarkdownV1";

export interface AuthRequestV5 {
  endUserIp: string;
  personalNumber?: string;
  requirement?: AuthOptionalRequirements;
  userVisibleData?: string;
  userVisibleDataFormat?: UserVisibleDataFormat;
  userNonVisibleData?: string;
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
  issuerCn?: string[];
  autoStartTokenRequired?: boolean;
  allowFingerprint?: boolean;
}

//
// Type definitions for /sign
//

export interface SignRequest extends AuthRequestV5 {
  userVisibleData: string;
}

export interface SignResponse extends AuthResponse {}

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
  | "startFailed"
  | "userDeclinedCall"
  | "notSupportedByUserApp"
  | "mrtdVerificationFailed"
  | "facialRecognitionFailed"
  | "nfcNotSupportedByDevice"
  | "multipleBankIdsOnDevice"
  | "stepUpFailed";

export type PendingHintCode =
  | "outstandingTransaction"
  | "noClient"
  | "started"
  | "userMrtd"
  | "userCallConfirm"
  | "userSign"
  | "processing"
  | "userStepUp"
  | "userFace";

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
  | AuthRequestV5
  | SignRequest
  | CollectRequest
  | CancelRequest;

export type BankIdResponse =
  | CancelResponse
  | AuthResponse
  | SignResponse
  | CollectResponseV5
  | CollectResponseV6;

//
// Client settings
//

interface BankIdClientSettings {
  production: boolean;
  refreshInterval?: number;
  requestTimeout?: number;
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
  readonly request?: unknown;

  constructor(request?: unknown) {
    super(REQUEST_FAILED_ERROR);
    Error.captureStackTrace(this, this.constructor);

    this.name = "RequestError";
    this.request = request;
  }
}

//
// HTTP helper
//

interface HttpResponse<T> {
  statusCode: number;
  data: T;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

function httpsPost<T>(
  url: string,
  body: unknown,
  agent: https.Agent,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search } = new URL(url);
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname,
        path: pathname + search,
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(
              new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("close", () => {
          if (!res.complete) reject(new Error("Response closed before end"));
        });
        res.on("end", () => {
          clearTimeout(deadline);
          try {
            const data = JSON.parse(
              Buffer.concat(chunks).toString("utf-8"),
            ) as T;
            resolve({ statusCode: res.statusCode ?? 0, data });
          } catch {
            reject(
              new Error(
                `Failed to parse response with status ${res.statusCode}`,
              ),
            );
          }
        });
      },
    );

    const deadline = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.write(payload);
    req.end();
  });
}

//
// Client implementation
//

/**
 * @deprecated Targets RP API v5.1, which BankID shut down on 2025-09-30. Use {@link BankIdClientV6}.
 */
export class BankIdClient {
  readonly options: Required<BankIdClientSettings>;
  protected baseURL: string;
  protected httpsAgent: https.Agent;

  version = "v5.1";

  constructor(options?: BankIdClientSettings) {
    this.options = {
      production: false,
      refreshInterval: 2000,
      requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
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

    this.baseURL = "";
    this.httpsAgent = undefined!;
    this.initializeHttpClient();
    return this;
  }

  authenticate(parameters: AuthRequestV5): Promise<AuthResponse> {
    if (!parameters.endUserIp) {
      throw new Error("Missing required argument endUserIp.");
    }
    if (
      parameters.userVisibleDataFormat != null &&
      parameters.userVisibleDataFormat !== "plaintext" &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1"
    ) {
      throw new Error(
        "userVisibleDataFormat must be plaintext or simpleMarkdownV1.",
      );
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
      parameters.userVisibleDataFormat !== "plaintext" &&
      parameters.userVisibleDataFormat !== "simpleMarkdownV1"
    ) {
      throw new Error(
        "userVisibleDataFormat must be plaintext or simpleMarkdownV1.",
      );
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
    parameters: AuthRequestV5,
  ): Promise<CollectResponse> {
    const authResponse = await this.authenticate(parameters);
    return this.awaitPendingCollect(authResponse.orderRef);
  }

  async signAndCollect(parameters: SignRequest): Promise<CollectResponse> {
    const signResponse = await this.sign(parameters);

    return this.awaitPendingCollect(signResponse.orderRef);
  }

  async awaitPendingCollect(orderRef: string): Promise<CollectResponse> {
    for (;;) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.refreshInterval),
      );
      const response = await this.collect({ orderRef });
      if (response.status === "complete") return response;
      if (response.status !== "pending") throw response;
    }
  }

  async #call<Req extends BankIdRequest, Res extends BankIdResponse>(
    method: BankIdMethod,
    payload: Req,
  ): Promise<Res> {
    let response: HttpResponse<Res & ErrorResponse>;

    try {
      response = await httpsPost<Res & ErrorResponse>(
        `${this.baseURL}${method}`,
        payload,
        this.httpsAgent,
        this.options.requestTimeout,
      );
    } catch (error) {
      throw new RequestError(error);
    }

    if (response.statusCode >= 400) {
      throw new BankIdError(response.data.errorCode, response.data.details);
    }

    return response.data as Res;
  }

  protected initializeHttpClient(): void {
    this.baseURL = this.options.production
      ? `https://appapi2.bankid.com/rp/${this.version}/`
      : `https://appapi2.test.bankid.com/rp/${this.version}/`;

    const ca = Buffer.isBuffer(this.options.ca)
      ? this.options.ca
      : fs.readFileSync(this.options.ca, "utf-8");
    const pfx = Buffer.isBuffer(this.options.pfx)
      ? this.options.pfx
      : fs.readFileSync(this.options.pfx);
    const passphrase = this.options.passphrase;

    this.httpsAgent = new https.Agent({
      pfx,
      passphrase,
      ca,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    });
  }
}

interface AuthOptionalRequirementsV6 {
  pinCode?: boolean;
  cardReader?: "class1" | "class2";
  /** Cannot be combined with `stepUp`. */
  mrtd?: boolean;
  /** `face` alone is not allowed. Cannot be combined with `mrtd`. */
  stepUp?: ("mrtd" | "face")[];
  certificatePolicies?: string[];
  personalNumber?: string;
}

export interface WebDeviceData {
  referringDomain?: string;
  userAgent?: string;
  /** Must not be the session cookie. */
  deviceIdentifier?: string;
}

export interface AppDeviceData {
  appIdentifier?: string;
  deviceOS?: string;
  deviceModelName?: string;
  deviceIdentifier?: string;
}

export interface AuthRequestV6 {
  /** The end user's IP address as seen by your service, not a proxy's. */
  endUserIp: string;
  requirement?: AuthOptionalRequirementsV6;
  userVisibleData?: string;
  userVisibleDataFormat?: UserVisibleDataFormat;
  userNonVisibleData?: string;
  /** Put a session nonce in the URL fragment and check it on return. */
  returnUrl?: string;
  returnRisk?: boolean;
  /** Send `web` or `app`, not both. */
  web?: WebDeviceData;
  app?: AppDeviceData;
}

export interface SignRequestV6 extends AuthRequestV6 {
  userVisibleData: string;
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
  stepUp?: {
    mrtd?: boolean;
    face?: boolean;
  };
  signature: string;
  ocspResponse: string;
  /** Returned only when `returnRisk` is set, and may be absent. Block `high`. */
  risk?: "low" | "moderate" | "high";
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
 * @see https://developers.bankid.com/api-references/auth--sign/overview
 */
export class BankIdClientV6 extends BankIdClient {
  version = "v6.0";
  options: Required<BankIdClientSettingsV6>;

  constructor(options: BankIdClientSettingsV6) {
    super(options);
    this.initializeHttpClient();
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

  async sign(parameters: SignRequestV6): Promise<SignResponseV6> {
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
