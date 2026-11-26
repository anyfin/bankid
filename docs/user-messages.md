# User messages

BankID publishes a [recommended message](https://developers.bankid.com/ui-resources/user-messages) for each situation, in Swedish and English, each with a short name such as RFA9. `describe` returns the short name. You show the text, in your own words if you like, and in your own design.

BankID writes the two variants of RFA15 and RFA17 as "RFA15 (A)" and "RFA15 (B)". `describe` returns them as `RFA15A`, `RFA15B`, `RFA17A` and `RFA17B`.

```ts
import { describe, type CollectResponse, type UserMessage } from "bankid";

// Every message, in BankID's English wording. describe never returns RFA2,
// RFA19 or RFA20; they are for your own interface, as the end of this page says.
const english: Record<UserMessage, string> = {
  RFA1: "Start your BankID app.",
  RFA2: "You don't seem to have the BankID app. Install the app and get a BankID.",
  RFA3: "The action was cancelled. Please try again.",
  RFA4: "An identification or signature is already in progress for your personal identity number. Please try again.",
  RFA5: "Something went wrong. Please try again.",
  RFA6: "The action was cancelled.",
  RFA8: "The BankID app is not responding. Please check that it's started and that you have internet access. Try again.",
  RFA9: "Enter your security code in the BankID app and select Identify or Sign.",
  RFA13: "Trying to start your BankID app.",
  RFA15A:
    "Searching for BankID. Make sure you have a valid BankID on this computer. If you have a BankID on card, please insert the card into your card reader.",
  RFA15B:
    "Searching for BankID. Make sure you have a valid BankID on this device.",
  RFA16:
    "Your BankID is blocked or too old. Please use another BankID or get a new one from your bank.",
  RFA17A:
    "You don't seem to have the BankID app/program. Please install it and get a BankID from your bank.",
  RFA17B:
    "Failed to scan the QR code. Start the BankID app and scan the QR code.",
  RFA19: "Would you like to use BankID on this computer, or a Mobile BankID?",
  RFA20: "Do you want to use BankID on this device or another device?",
  RFA21: "An identification or signing is in progress.",
  RFA22: "Something went wrong. Please try again.",
  RFA23: "Take a photo of, and scan, your ID document with the BankID app.",
  RFA24: "Perform facial recognition in your BankID app.",
  RFA25: "Select how to confirm your identity in your BankID app.",
  RFA26: "The verification of your ID document failed. Please try again.",
  RFA27: "The facial recognition failed. Please try again.",
  RFA28: "Your device doesn't have the reader needed to verify ID documents.",
  RFA29:
    "You have several BankID on your device. You need to delete all but one BankID to be able to complete the identification. This is done under Menu - Settings in your BankID app.",
  RFA30: "The verification of your identity failed. Please try again.",
};

// BankID names no message for this hint code but asks you to tell the user to
// update the BankID app, so it gets its own text instead of RFA22's.
const updateApp =
  "Your BankID app needs to be updated. Update it and try again.";

export function messageFor(result: CollectResponse): string | undefined {
  if (result.status === "failed" && result.hintCode === "notSupportedByUserApp")
    return updateApp;
  const name = describe(result, { start: "qrCode" });
  return name === undefined ? undefined : english[name];
}
```

The table's type, `Record<UserMessage, string>`, makes TypeScript check that it has a text for every message, so no hint code falls back to another message's text. The Swedish texts are on BankID's [user messages](https://developers.bankid.com/ui-resources/user-messages) page.

`describe` takes anything with a `status` and an optional `hintCode`: a collect result on the server, or a `RelayedStatus` from `bankid/client` on the front end.

## How the order started

Some hint codes get a different message depending on how the user reached the BankID app. Pass that as the second argument:

| Context                                     | The order was                                              |
| ------------------------------------------- | ---------------------------------------------------------- |
| `{ start: "autoStart", device: "phone" }`   | Opened with `startUrl` on a phone or tablet                |
| `{ start: "autoStart", device: "desktop" }` | Opened with `startUrl` on a computer                       |
| `{ start: "qrCode" }`                       | Shown as a QR code                                         |
| `{ start: "phoneCall" }`                    | Started with `phone.auth`, `phone.sign` or `phone.payment` |
| `{ start: "other" }`                        | Started with `other.payment`                               |

## Pending orders

| Hint code                | Message                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `outstandingTransaction` | RFA13 when started with autostart, otherwise RFA1                  |
| `noClient`               | RFA1                                                               |
| `started`                | RFA15A when started with autostart on a computer, otherwise RFA15B |
| `userSign`               | RFA9                                                               |
| `userMrtd`               | RFA23                                                              |
| `userFace`               | RFA24                                                              |
| `userStepUp`             | RFA25                                                              |
| `processing`             | RFA21                                                              |
| `userCallConfirm`        | RFA21                                                              |
| any other code, or none  | RFA21                                                              |

## Failed orders

| Hint code                 | Message                                          |
| ------------------------- | ------------------------------------------------ |
| `userCancel`              | RFA6                                             |
| `cancelled`               | RFA3                                             |
| `expiredTransaction`      | RFA8                                             |
| `certificateErr`          | RFA16                                            |
| `startFailed`             | RFA17B when shown as a QR code, otherwise RFA17A |
| `mrtdVerificationFailed`  | RFA26                                            |
| `facialRecognitionFailed` | RFA27                                            |
| `nfcNotSupportedByDevice` | RFA28                                            |
| `multipleBankIdsOnDevice` | RFA29                                            |
| `stepUpFailed`            | RFA30                                            |
| `userDeclinedCall`        | RFA22                                            |
| `notSupportedByUserApp`   | RFA22                                            |
| any other code, or none   | RFA22                                            |

BankID names no message for `userCallConfirm`, `userDeclinedCall` and `notSupportedByUserApp`, so they get the message for an unknown code. So does a result without a hint code, which BankID's spec allows. For `notSupportedByUserApp`, BankID asks you to tell the user to update the BankID app: check for it before you call `describe` and show your own text, as the example at the top of this page does. `describe` does not invent a message name for it.

## Errors

`describe(error)` takes a `BankIdApiError`, or anything with an `errorCode`. It needs no context.

| Error code                                                                                  | Message                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `alreadyInProgress`                                                                         | RFA4                               |
| `requestTimeout`                                                                            | RFA5                               |
| `internalError`                                                                             | RFA5                               |
| `maintenance`                                                                               | RFA5, once retrying has not helped |
| `invalidParameters`, `unauthorized`, `notFound`, `methodNotAllowed`, `unsupportedMediaType` | RFA22                              |
| any other code                                                                              | RFA22                              |

BankID's [errors guide](https://developers.bankid.com/api-references/errors) says the RFA22 group points to a fault in your own system and should not be shown as a BankID error. Log it and fix the cause.

## Messages `describe` never returns

RFA2, RFA19 and RFA20 belong to your own interface. RFA19 and RFA20 ask whether the user wants BankID on this device or another one. RFA2 tells a user who has no BankID app to install it, for example when a native app cannot open the start URL.
