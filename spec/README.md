# BankID API specification

`openapi-auth-sign.yaml` is BankID's OpenAPI file for the auth and sign API (Relying Party API), checked in unchanged. It is the source of `src/generated/`, which `pnpm generate` rebuilds.

|               |                                                                            |
| ------------- | -------------------------------------------------------------------------- |
| Source        | https://developers.bankid.com/assets/openapi/openapi-auth-sign-6.1.11.yaml |
| Spec revision | 6.1.11 (`info.version`; BankID also puts it in the file name)              |
| Downloaded    | 2026-11-26                                                                 |

BankID lists the current file on https://developers.bankid.com/llms-full.txt. `pnpm check:spec` compares this copy with that file. A weekly workflow runs it and opens an issue on a difference.

To update, download the new file over `openapi-auth-sign.yaml`, edit the table above, run `pnpm generate` and commit the result.
