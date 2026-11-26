# A sample that must not compile

`scripts/check-docs.mjs` type-checks this file and expects it to fail. If it
passes, the docs check would let a stale sample through.

```ts
import { createBankIdClient } from "bankid";
import { createFakeBankId } from "bankid/testing";

const fake = createFakeBankId();
const bankid = createBankIdClient({
  environment: "test",
  transport: fake.transport,
});

// 3.x took an object; 4.0 takes the order reference itself.
await bankid.collect({ orderRef: "131daac9-16c6-4618-beb0-365768f37288" });
```
