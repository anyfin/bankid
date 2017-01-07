const BankId = require('../src/bankid');

const pno = process.argv[2];
const bankid = new BankId();

bankid.authenticateAndCollect(pno)
.then(console.log)
.catch(console.error);