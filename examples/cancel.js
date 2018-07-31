const BankId = require("../src/bankid");

const pno = process.argv[2];
const bankid = new BankId();

async function testCancelation() {
  const { orderRef } = await bankid.authenticate("127.0.0.1", pno);
  await bankid
    .cancel(orderRef)
    .then(() => console.log("success"))
    .catch(console.error);
}

testCancelation();
