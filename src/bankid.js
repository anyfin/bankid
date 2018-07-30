"use strict";

const path = require("path");
const fs = require("fs");
const https = require("https");
const axios = require("axios");

class BankId {
  constructor(options = {}) {
    this.options = Object.assign(
      {},
      {
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
        ca: undefined
      },
      options
    );

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
  }

  authenticate(endUserIp, personalNumber, requirement) {
    if (!endUserIp) {
      throw Error("Missing required argument endUserIp.");
    }
    return this._call("auth", {
      endUserIp,
      personalNumber,
      requirement
    });
  }

  sign(
    endUserIp,
    personalNumber,
    userVisibleData,
    userNonVisibleData,
    requirement
  ) {
    if (!endUserIp || !userVisibleData) {
      throw Error("Missing required arguments: endUserIp, userVisibleData.");
    }
    return this._call("sign", {
      endUserIp,
      personalNumber,
      userVisibleData: new Buffer(userVisibleData).toString("base64"),
      userNonVisibleData: userNonVisibleData
        ? new Buffer(userNonVisibleData).toString("base64")
        : undefined,
      requirement
    });
  }

  collect(orderRef) {
    return this._call("collect", { orderRef });
  }

  cancel(orderRef) {
    return this._call("cancel", { orderRef });
  }

  authenticateAndCollect(...args) {
    return this._methodAndCollect(this.authenticate.bind(this), ...args);
  }

  signAndCollect(...args) {
    return this._methodAndCollect(this.sign.bind(this), ...args);
  }

  _methodAndCollect(method, ...args) {
    return new Promise((resolve, reject) => {
      method(...args).then(
        ({ orderRef }) => {
          const timer = setInterval(() => {
            this.collect(orderRef)
              .then(res => {
                if (res.status === "complete") {
                  clearInterval(timer);
                  resolve(res);
                } else if (res.status === "failed") {
                  clearInterval(timer);
                  reject(new Error(res.hintCode));
                }
              })
              .catch(err => {
                clearInterval(timer);
                reject(err);
              });
          }, this.options.refreshInterval);
        },
        err => reject(err)
      );
    });
  }

  _call(action, payload) {
    const baseUrl = this.options.production
      ? "https://appapi2.bankid.com/rp/v5/"
      : "https://appapi2.test.bankid.com/rp/v5/";
    return this.axios
      .post(baseUrl + action, payload)
      .then(res => res.data)
      .catch(err => {
        const error = new Error(err.response.data.errorCode);
        error.details = err.response.data.details;
        throw error;
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

module.exports = BankId;
