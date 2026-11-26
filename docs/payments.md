# Payments

A payment order asks the user to approve one or more transactions in the BankID app. The app shows the recipient, the amount and any warning you send. The user approves with their security code, and the order completes with a signature, the same as a `sign` order.

Payment orders need BankID app 7.46 or newer, or BankID for computer or card 7.17 or newer. Have a plan for users on older versions. See BankID's [API overview](https://developers.bankid.com/api-references/auth--sign/overview) and [warnings guide](https://developers.bankid.com/how-to-guides/warnings).

In the samples, `bankid` is the client from [Create a client](../README.md#create-a-client), imported from `./bankid.js`.

## Endpoints

| Method                      | Approves                                       | Started with                      | Response                   |
| --------------------------- | ---------------------------------------------- | --------------------------------- | -------------------------- |
| `bankid.payment`            | One transaction                                | Autostart or QR code              | `OrderResponse`, as `auth` |
| `bankid.payment.bulk`       | 1 to 40 transfers                              | Autostart or QR code              | `OrderResponse`, as `auth` |
| `bankid.phone.payment`      | One transaction                                | A phone call                      | `{ orderRef }`             |
| `bankid.phone.payment.bulk` | 1 to 40 transfers                              | A phone call                      | `{ orderRef }`             |
| `bankid.other.payment`      | A card payment or a non-payment authentication | The user opens the app themselves | `{ orderRef }`             |

Start the app and collect the order as for `auth` and `sign`: [same device](../README.md#bankid-on-the-same-device), [another device](../README.md#bankid-on-another-device) or a [phone call](../README.md#bankid-in-a-phone-call). Collect every 2 seconds until the order is final.

BankID prefers `payment` to `other.payment`. Use `other.payment` only when neither autostart nor a QR code is possible and you are not on a call with the user.

## Transaction types

`userVisibleTransaction` is a union on `transactionType`. TypeScript tells you which fields each type needs.

| `transactionType`                                                 | `recipient`                                                         | `money`   | `date` (`YYYY-MM-DD`) | Allowed on                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | --------- | --------------------- | ---------------------------------------------- |
| `card`                                                            | `{ name }`, the merchant                                            | optional  | optional              | `payment`, `phone.payment`, `other.payment`    |
| `npa` (non-payment authentication)                                | `{ name }`                                                          | forbidden | optional              | `payment`, `phone.payment`, `other.payment`    |
| `bankgiro`, `plusgiro`, `samebank`, `domesticbank`, `foreignbank` | `{ accountNumber, name? }`                                          | required  | required              | `payment`, `phone.payment` and both bulk kinds |
| `direct`                                                          | at least one of `name`, `legalName`, `accountNumber`, `phoneNumber` | required  | optional              | `payment`, `phone.payment`                     |

Every type also takes `riskWarning`, `recurring` (not in bulk) and `thirdPartyInitiator`.

- `money` is `{ amount, currency }`. `amount` is digits with at most one comma as the decimal separator, such as `"249,00"`. `currency` is an ISO 4217 alphabetic code such as `"SEK"`. The library checks only that it is three capital letters; whether the code exists in ISO 4217 is checked by BankID.
- Names are plain text of at most 40 characters. The library sends them base64-encoded under the spec's `nameB64`, `legalNameB64` and `thirdPartyInitiatorB64`. Passing a `...B64` field yourself is refused.
- `riskWarning` is one warning the app shows the user, such as `"newRecipient"` or `"largeAmount"`.
- `riskFlags` is a list of flags for BankID's risk assessment, never shown to the user, such as `["newCard"]`. It goes on the request on `payment`, `phone.payment` and `other.payment`, and on each payment in a bulk order. BankID documents the flags as not yet used.

## Checks before sending

The client checks each payment request against BankID's spec before it sends it. A request BankID would refuse rejects with a `TypeError` and nothing is sent. The message names the field and the rule, never the value, since values are names, account numbers and amounts:

```text
payment: userVisibleTransaction.money is required for transactionType bankgiro
payment.bulk: userVisibleTransactionBulk.payments must be an array of 1 to 40 payments
```

These are all the checks, from BankID's spec and payment guides:

- The fields each endpoint requires: `endUserIp`, an IPv4 or IPv6 address, on `payment` and `payment.bulk`; `callInitiator`, `"user"` or `"RP"`, and `personalNumber`, 12 digits, on the phone endpoints; `personalNumber` on `other.payment`.
- `userVisibleData` and `userNonVisibleData`: strings, not empty, at most 1000 characters once base64-encoded.
- `returnUrl` on `payment`, `payment.bulk` and `other.payment`: 1 to 512 characters.
- `userVisibleTransaction`: an object whose `transactionType` the endpoint allows, with the `recipient`, `money` and `date` the type requires or forbids, as in the table above.
- Recipients: `name` and `legalName` at most 40 characters, never under their `...B64` names; `accountNumber` 1 to 42 characters of `A`-`Z`, `0`-`9`, space or `. , ( ) -`; `phoneNumber` 1 to 25 characters of digits, space or `( ) + -`; a direct recipient with at least one of its four fields.
- `money`: `amount` digits with at most one `,`, at most 48 characters; `currency` three capital letters.
- `date`: a real date written `YYYY-MM-DD`.
- `riskWarning` one of the spec's warnings, `riskFlags` a list of the spec's flags, `recurring` a boolean, `thirdPartyInitiator` at most 40 characters.
- Bulk orders: 1 to 40 payments, each a bankgiro, plusgiro or bank transfer with an account recipient, `money` and a `date`, without `recurring`, and with any `fromAccount` that has `name` or `accountNumber` but not both; 1 to 4 `sums`; no `userVisibleDataFormat`.
- Text fields that are not strings.

Everything else, such as `requirement`, `app`, `web`, `returnRisk`, `userVisibleDataFormat` on a single payment, whether bulk `sums` add up and whether a currency code exists, is left to BankID, which answers a bad value with `invalidParameters`. The fake in `bankid/testing` runs the same checks, and the other checks of the spec's request schemas on top.

## A bank transfer

```ts
import { bankid } from "./bankid.js";

export async function payInvoice(endUserIp: string) {
  const { orderRef, autoStartToken } = await bankid.payment({
    endUserIp,
    userVisibleData: "Invoice 2026-118 from Example Utility",
    userVisibleTransaction: {
      transactionType: "bankgiro",
      recipient: { name: "Example Utility", accountNumber: "5050-1055" },
      money: { amount: "1250,00", currency: "SEK" },
      date: "2026-12-01",
    },
    riskFlags: ["newRecipient"],
  });
  return { orderRef, autoStartToken };
}
```

## Several transfers at once

`payment.bulk` takes 1 to 40 payments and 1 to 4 sums to show, such as one per currency. Bulk orders support plain text only, so there is no `userVisibleDataFormat`.

```ts
import type { BulkPayment, Money } from "bankid";
import { bankid } from "./bankid.js";

export async function payAll(
  endUserIp: string,
  payments: BulkPayment[],
  total: Money,
) {
  return bankid.payment.bulk({
    endUserIp,
    userVisibleTransactionBulk: { payments, sums: [total] },
  });
}

export const rent: BulkPayment = {
  transactionType: "bankgiro",
  recipient: { name: "Example Housing", accountNumber: "5050-1055" },
  money: { amount: "9800,00", currency: "SEK" },
  date: "2026-12-27",
  fromAccount: { name: "Household" },
};
```

A `fromAccount` takes a `name` or an `accountNumber`. BankID rejects one with both. Adjacent payments from the same `fromAccount` are grouped together in the app.

## In a phone call

`phone.payment` takes `callInitiator` and `personalNumber` instead of `endUserIp`, as `phone.auth` does.

```ts
import { bankid } from "./bankid.js";

export async function approveTransfer(personalNumber: string) {
  return bankid.phone.payment({
    callInitiator: "RP", // you called the user
    personalNumber,
    userVisibleTransaction: {
      transactionType: "direct",
      recipient: { phoneNumber: "+46 70 123 45 67" },
      money: { amount: "500,00", currency: "SEK" },
    },
  });
}
```

## Without autostart, QR code or call

```ts
import { bankid } from "./bankid.js";

export async function approveCardPayment(personalNumber: string) {
  return bankid.other.payment({
    personalNumber,
    userVisibleTransaction: {
      transactionType: "card",
      recipient: { name: "Example Shop" },
      money: { amount: "99,00", currency: "SEK" },
    },
  });
}
```

The user opens the BankID app themselves. Pass `{ start: "other" }` to [`describe`](../README.md#user-messages) for this order's messages.

## Completion

A payment order completes like any other order. The spec has one collect response for every order type, so `completionData` has the same fields as for `sign`. There are no payment-specific hint codes.
