import { BankIdClient } from "../lib/bankid.js";

const personalNumber = process.argv[2];
const bankid = new BankIdClient({ production: false });

async function testCancelation() {
  const { orderRef } = await bankid.authenticate({
    endUserIp: "127.0.0.1",
    personalNumber,
  });
  await bankid
    .cancel({ orderRef })
    .then(() => console.log("success"))
    .catch(console.error);
}

testCancelation();
