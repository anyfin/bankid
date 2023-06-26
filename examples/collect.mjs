import { BankIdClient } from "../lib/bankid.js";

const personalNumber = process.argv[2];
const bankid = new BankIdClient({ production: false });

bankid
  .sign({
    endUserIp: "127.0.0.1",
    personalNumber,
    userVisibleData: "visible",
    userNonVisibleData: "invisible",
  })
  .then(res => {
    const timer = setInterval(() => {
      const done = () => clearInterval(timer);

      bankid
        .collect({ orderRef: res.orderRef })
        .then(res => {
          console.log(res.status);

          if (res.status === "complete") {
            console.log(res.completionData.user);
            done();
          } else if (res.status === "failed") {
            throw new Error(res.hintCode);
          }
        })
        .catch(err => {
          console.error(err);
          done();
        });
    }, 1000);
  })
  .catch(console.error);
