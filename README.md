# bankid

A npm module to simplify integration with the Swedish [Bank ID](https://www.bankid.com/en/) service for user authentication and signing processes.

## Installation

```sh
# If you prefer npm
npm install --save bankid
# If you prefer yarn
yarn install bankid
```

## Usage V6

```javascript
import { BankIdClientV6 } from "bankid";

const client = new BankIdClientV6({
  production: false,
});

const { autoStartToken, orderRef } = await client.authenticate({
  endUserIp: "127.0.0.1",
});

// Generate deep link from autoStarttoken and try to open BankID app
// See ./examples

client
  .awaitPendingCollect(orderRef)
  .then(res => {
    console.log(res.completionData)
  })

```
Acting on a session is done trough opening the app or trough scanning a QR Code, both examples are documented in detail [in the examples directory](./examples)

## Usage V5

```javascript
import { BankIdClient } from "bankid";

const client = new BankIdClient();
const pno = "YYYYMMDDXXXX";

client
  .authenticateAndCollect({
    personalNumber: pno,
    endUserIp: "127.0.0.1",
  })
  .then(res => console.log(res.completionData))
  .catch(console.error);
```

As outlined in the [relying party guidelines](https://www.bankid.com/assets/bankid/rp/bankid-relying-party-guidelines-v3.5.pdf),
there' four main methods (arguments marked with `*` are required)

- `authenticate({endUserIp*, personalNumber, requirement})`
- `sign({endUserIp*, personalNumber, requirement, userVisibleData*, userNonVisibleData})`
- `collect({orderRef*})`
- `cancel({orderRef*})`

Additionally, `bankid` provides convenience methods to combine auth / sign with periodic collection of the status until the process either failed or succeeded (as shown in the example code above):

- `authenticateAndCollect(...)`
- `signAndCollect(...)`

Full example _not_ using the convenience methods:

```javascript
import { BankIdClient } from "bankid";

const client = new BankIdClient();
const pno = "YYYYMMDDXXXX";
const message = "some message displayed to the user to sign";

client
  .sign({
    endUserIp: "127.0.0.1",
    personalNumber: pno,
    userVisibleData: message,
  })
  .then(res => {
    const timer = setInterval(() => {
      const done = () => clearInterval(timer);
      client
        .collect({ orderRef: res.orderRef })
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

By default, `bankid` is instantiated with the following configuration pointing to the Bank ID Test Environment:

```javascript
settings = {
  refreshInterval: 1000, // how often to poll status changes for authenticateAndCollect and signAndCollect
  production: false, // use test environment
  pfx: "PATH_TO_TEST_ENV_PFX", // test environment
  passphrase: "TEST_ENV_PASSPHRASE", // test environment
  ca: "CERTIFICATE", // dynamically set depending on the "production" setting unless explicitely provided
};
```

For production, you'll want to pass in your own pfx and passphrase instead:

```javascript
import { BankIdClient } from "bankid";

const client = new BankIdClient({
  production: true,
  pfx: "PATH_TO_YOUR_PFX", // alternatively also accepts buffer
  passphrase: "YOUR_PASSPHRASE",
});
```

### PFX path

When providing a pfx path, it is expected to be based on the current working directory from where the script is run:

```
.
├── certs
│   └── bankid.pfx
├── src
│   └── main.js
```

From the current directory you would run the script with `node src/main.js` and provide the pfx path:

```javascript
import { BankIdClient } from "bankid";

const client = new BankIdClient({
  pfx: "certs/bankid.pfx",
});
```

## Deploy/Publish

In order to deploy new versions, bump the version in `package.json` and create a new GitHub release.

GitHub Actions should automagically release it to npm. ✨

## Ownership

Repo ownership: [Jeff Trinidad - @jefftrinidad29](https://github.com/jefftrinidad29) \
Last audit: 2023-04-27 by [@jefftrinidad29](https://github.com/jefftrinidad29)

# Audit Notes

> 27th April 2023 by @jefftrinidad29

- Upgraded all non-critical dependencies
- yarn audit fix
