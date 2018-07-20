const BankId = require("../src/bankid");

const pno = process.argv[2];
const bankid = new BankId();

bankid
  .sign("127.0.0.1", pno, "visible", "invisible")
  .then(res => {
    const timer = setInterval(() => {
      const done = () => clearInterval(timer);

      bankid
        .collect(res.orderRef)
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
