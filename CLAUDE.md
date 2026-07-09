# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript npm module that simplifies integration with the Swedish BankID service for authentication and signing. It provides a wrapper around the BankID Web Service API with support for both v5.1 and v6.0 API versions.

## Commands

### Development
- `yarn dev` - Watch mode compilation with TypeScript
- `yarn build` - Compile TypeScript to CommonJS in `lib/` directory
- `yarn format` - Format code with Prettier

### Publishing
- The package uses `prepublishOnly` hook to automatically build before publishing
- Releases are automated via GitHub Actions when a new GitHub release is created

## Architecture

### Client Classes

**BankIdClient (v5.1)**: Base client class in `src/bankid.ts`
- Handles authentication, signing, collecting, and canceling BankID operations
- Uses native `https.request` with mTLS (mutual TLS) certificates (zero runtime dependencies)
- Provides convenience methods `authenticateAndCollect()` and `signAndCollect()` that poll until completion
- The `awaitPendingCollect()` method polls the collect endpoint at configurable intervals (default 2000ms)

**BankIdClientV6 (v6.0)**: Extended client in `src/bankid.ts:756`
- Extends BankIdClient with v6.0 API support
- Adds new endpoints: `payment()`, `phoneAuth()`, `phoneSign()`, `otherPayment()`
- Integrates QR code generation via `QrGenerator` class (enabled by default)
- Returns slightly different response types with `CompletionDataV6`

### QR Code Generation

**QrGenerator**: Separate class in `src/qrgenerator.ts`
- Generates animated QR codes for BankID authentication
- Uses HMAC-SHA256 to create time-based QR codes that cycle every second
- Supports custom caching strategies or uses default in-memory Map
- Provides async generator `nextQr()` for cycling through QR values with timeout/maxCycles limits
- Auto-cleans cache entries after TTL (default 60 seconds)

### Certificate Handling

The library handles mTLS certificates for BankID API communication:
- **Test environment**: Includes default test certificate (`FPTestcert5_20240610.p12`) with passphrase `qwerty123`
- **Production**: Requires user to provide their own PFX certificate and passphrase
- Certificate paths are resolved relative to the `__dirname` of the compiled code in `lib/`
- Certificates can be provided as file paths (string) or Buffers

### API Communication Pattern

All BankID API calls follow this pattern:
1. Method-specific request validation (e.g., `authenticate()`, `sign()`)
2. Base64 encoding of `userVisibleData` and `userNonVisibleData`
3. HTTP POST to BankID API via native `https.request` with mTLS
4. Error handling: HTTP 4xx/5xx responses become `BankIdError`, network errors become `RequestError`

### Type System

Strong TypeScript typing throughout:
- Request/response types for each API method (Auth, Sign, Collect, Cancel)
- `CollectResponse` has discriminated union of status: "pending" | "failed" | "complete"
- Different `CompletionData` structures for V5 vs V6
- `BankIdError` class with error codes matching BankID API

## Key Implementation Details

### Polling Logic
The `awaitPendingCollect()` method implements a polling loop using `setInterval` that:
- Calls `collect()` repeatedly until status is "complete" or "failed"
- Clears interval and resolves/rejects promise based on final status
- Uses `refreshInterval` option (default 2000ms) between polls

### Base64 Encoding
User-visible and non-visible data are automatically base64-encoded before sending to BankID API. This is handled in `authenticate()`, `sign()`, `payment()`, `phoneAuth()`, `phoneSign()`, and `otherPayment()` methods.

### Node.js v17+ Compatibility
BankID certificates use legacy algorithms. For Node.js v17+:
- Recommended: Modernize certificates using OpenSSL v3 commands (see README)
- Alternative: Run Node.js with `--openssl-legacy-provider` flag

## Testing

No automated test suite is present. Manual testing is available in `test/manual/` directory. Examples for common usage patterns are in `examples/` directory including:
- Simple authentication (`auth-simple.mjs`)
- QR code flows (`v6-qrcode.mjs`, `v6-qrcode-customcache.mjs`)
- Autostart token usage (`v6-autostart.mjs`)
- Payment flow (`v6-payment.mjs`)
- Phone authentication (`v6-phone-auth.mjs`)
- Collect and cancel operations

## Module Structure

- Entry point: `src/index.ts` (exports from bankid.ts and qrgenerator.ts)
- Compiled output: `lib/` directory (CommonJS with declaration files)
- Target: ES2018, CommonJS modules
- The library is designed for Node.js backend usage (requires fs, https, crypto modules)
