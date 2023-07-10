import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BankIdClientV6 } from "../lib/bankid.js";
import { cwd } from "node:process";

const execPromise = promisify(exec);

const bankid = new BankIdClientV6({ production: false });

const tryOpenQRCodeInBrowser = async code => {
  // console.log(code);
  // Strange apple way of opening files with params
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
    console.log({ orderRef, resp });
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
