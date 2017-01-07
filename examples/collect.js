const BankId = require('../src/bankid');

const pno = process.argv[2];
const bankid = new BankId();

bankid.sign(pno, 'foo bar message').then(res => {
 const timer = setInterval(() => {
   const done = () => clearInterval(timer);

   bankid.collect(res.orderRef)
   .then(res => {
     console.log(res.progressStatus);

     if (res.progressStatus === 'COMPLETE') {
       console.log(res.userInfo);
       done();
     }
   })
   .catch(err => {
     console.log(err.toString());
     done();
   })
 }, 1000);
});