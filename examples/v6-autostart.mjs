import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BankIdClientV6 } from "../lib/bankid.js";

const execPromise = promisify(exec);

const bankid = new BankIdClientV6({
  production: false,
  qrEnabled: false,
});

const tryOpenBankIDDesktop = async (autoStartToken, redirectUrl) => {
  const deepLink = `bankid:///?autostarttoken=${autoStartToken}&redirect=${redirectUrl}`;
  await execPromise(`open "${deepLink}"`);
};

const main = async () => {
  const { autoStartToken, orderRef } = await bankid.authenticate({
    endUserIp: "127.0.0.1",
  });
  const redirectUrl = `https://www.google.com`;
  console.log(`Trying to trigger bankid on your current device..`);
  await tryOpenBankIDDesktop(autoStartToken, redirectUrl);
  console.log("Awaiting sign..");
  const resp = await bankid.awaitPendingCollect(orderRef);
  console.log("Succes!", resp);
};

main().catch(err => console.error(err));
