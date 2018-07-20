const BankId = require("../src/bankid");

const pno = process.argv[2];
const bankid = new BankId();

bankid
  .authenticateAndCollect("127.0.0.1", pno)
  .then(res => console.log(res.completionData.user))
  .catch(err => console.error(err));
