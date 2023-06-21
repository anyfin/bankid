import {BankIdClient} from "../lib/bankid.js";

const personalNumber = process.argv[2];
const bankid = new BankIdClient({production: false});

bankid
  .authenticateAndCollect({endUserIp: "127.0.0.1", personalNumber})
  .then(res => console.log(res.completionData.user))
  .catch(err => console.error(err));
