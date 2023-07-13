/**
 * This script uses the BankId API to authenticate. Results are logged to the console.
 * The script will keep generating new QR codes for authentification for a
 * maximum of 20 seconds, while continuously checking the order status.
 * In case the order status still has not turned "complete" after 20 seconds,
 * the script will timeout
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BankIdClientV6 } from "../lib/bankid.js";
import { cwd } from "node:process";

const execPromise = promisify(exec);

const customCache = {
  cache: {},
  get(key) {
    console.log("get called! ", key);
    return this.cache[key];
  },
  set(key, value) {
    console.log("set called!");
    this.cache[key] = value;
  },
};

const bankid = new BankIdClientV6({
  production: false,
  qrOptions: { customCache },
});

const tryOpenQRCodeInBrowser = async code => {
  // Apple way of opening html files with GET params
  await execPromise(
    `osascript -e 'tell application "Google Chrome" to open location "file://${cwd()}/index.html?code=${encodeURIComponent(
      code,
    )}"'`,
  );
};

const main = async () => {
  const { orderRef, qr } = await bankid.authenticate({
    endUserIp: "127.0.0.1",
  });

  let success = false;
  // Generate new QR code for 20 seconds, check status of the order on each cycle
  for (const newQrCode of qr.nextQr(orderRef, { timeout: 20 })) {
    tryOpenQRCodeInBrowser(newQrCode);
    const resp = await bankid.collect({ orderRef });
    console.log({ orderRef, newQrCode });
    if (resp.status === "complete") {
      // Check for success ?
      success = true;
      console.log("Succes!", resp);
      return;
    } else if (resp.status === "failed") {
      throw new Error(resp);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
  if (!success) {
    console.log("Timeout! Nothing happened");
  }
};

main().catch(err => console.error(err));
