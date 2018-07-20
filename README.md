# bankid

Npm module to simplify integration with the Swedish [Bank ID](https://www.bankid.com/en/) service for user authentication and signing processes.

## Installation

> npm install --save bankid

## Usage

```javascript
const BankId = require("bankid");

const bankid = new BankId();
const pno = "YYYYMMDD-XXXX";

bankid
  .authenticateAndCollect("127.0.0.1", pno)
  .then(res => console.log(res.completionData))
  .catch(console.error);
```

As outlined in the [relying party guidelines](https://www.bankid.com/assets/bankid/rp/bankid-relying-party-guidelines-v2.13.pdf) there's three main methods (arguments marked with `*` are required)

- `authenticate(endUserIp*, personalNumber, requirement)`
- `sign(endUserIp*, personalNumber, userVisibleData*, userNonVisibleData, requirement)`
- `collect(orderRef*)`

In addition _bankid_ provides convenience methods to combine auth / sign with periodic collection of the status until the process either failed or succeeded (as shown in the example code above)

- `authenticateAndCollect(...)`
- `signAndCollect(...)`

Full example _not_ using the convenience methods:

```javascript
const BankId = require("bankid");

const bankid = new BankId();
const pno = "YYYYMMDD-XXXX";
const message = "some message displayed to the user to sign";

bankid
  .sign("127.0.0.1", pno, message)
  .then(res => {
    const timer = setInterval(() => {
      const done = () => clearInterval(timer);

      bankid
        .collect(res.orderRef)
        .then(res => {
          if (res.status === "complete") {
            console.log(res.completionData);
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
```

## Configuration

By default bankid is instantiated with the following configuration pointing to the Bank ID Test Environment

```javascript
{
  refreshInterval: 1000, // how often to poll status changes for authenticateAndCollect and signAndCollect
	production: false, // use test environment
	pfx: "PATH_TO_TEST_ENV_PFX", // test environment
	passphrase: "TEST_ENV_PASSPHRASE", // test environment
	ca: "CERTIFICATE", // dynamically set depending on the "production" setting unless explicitely provided
}
```

For production you'll want to pass in your own pfx and passphrase instead:

```javascript
const bankid = new BankId({
  production: true,
  pfx: "PATH_TO_YOUR_PFX", // alternatively also accepts buffer
  passphrase: "YOUR_PASSPHRASE"
});
```
