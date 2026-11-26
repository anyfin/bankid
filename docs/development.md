# Development and releasing

## Development

The repository has a Nix flake that provides Node.js and pnpm. With direnv, `cd` into the repository; otherwise prefix commands with `nix develop --command`.

```sh
pnpm install
pnpm lint
pnpm check:generated
pnpm typecheck
pnpm build
pnpm test
pnpm check:package
```

`pnpm check:package` packs the build and checks it as a consumer would see it. It ends with `pnpm check:docs`.

`pnpm build && node scripts/live-check.mjs` checks the build against BankID's test environment, as the nightly workflow does. It starts, collects and cancels an `auth` order and checks certificate expiry. The `phone.auth` step runs only when `LIVE_CHECK_PERSONAL_NUMBER` holds a test personal number, such as one from the Swedish Tax Agency's list of test numbers that you have checked yourself; otherwise it is skipped with a note. The nightly workflow reads it from the Actions secret of the same name; set it under the repository's Actions secrets, not as a variable. The script redacts the number from everything it prints. On failure the workflow opens a public issue, built only from the structured result the script writes with `--result`: per step a fixed step id, the outcome, the HTTP status and a code from a fixed list of BankID error codes, hint codes and transport reasons, with anything else shown as `other`. The script's own output stays in the run log.

## The type generator

`src/generated/auth-sign.ts` is generated from BankID's spec in `spec/` by `pnpm generate`, which runs [openapi-typescript](https://github.com/openapi-ts/openapi-typescript).

- openapi-typescript is unmaintained: its maintainer put it in maintenance mode on 2026-09-19 with no further updates ([openapi-ts/openapi-typescript#2874](https://github.com/openapi-ts/openapi-typescript/issues/2874)). `package.json` pins it to an exact version.
- It cannot run under TypeScript 7, which no longer ships the TypeScript 5 compiler API it uses. That is why `.pnpmfile.cjs` gives it its own TypeScript 5.9.
- It is a development tool only. Its output is checked in, and CI regenerates it with `pnpm check:generated` and fails if the result differs, so a spec change it cannot handle fails visibly rather than slipping through.
- Replace it when a maintained generator runs under TypeScript 7.

## Documentation

`pnpm check:docs` keeps the documentation true to the code. It needs a build first.

- Every fenced `ts` block in `README.md` and `docs/*.md` is type-checked against the built package, imported as `bankid`, `bankid/client` and `bankid/testing`.
- Blocks fenced `ts v3` are type-checked against bankid 3.2.1, for the "before" half of the migration guide.
- A broken sample in `test/fixtures/docs/broken.md` must fail, so a check that lets everything through is caught.
- `docs/migrating-from-v3.md` must name every export of bankid 3.2.1, every member of its classes and every client option.
- Every export of the three entry points must have a doc comment in the built declarations.

When you write a sample:

- Each block is its own module. Write it so it compiles as it stands, with its imports.
- To share setup, name a block with `ts file=<name>.ts`. Other blocks of the same kind import it as `./<name>.js`. The README's `bankid.ts` creates the client the other samples use.
- Use `sh`, `text`, `json` or `js` for blocks that should not be checked.

## Releasing

Set the version in `package.json`, add the release to `CHANGELOG.md`, then publish a GitHub release whose tag is that version (`v4.0.0` or `4.0.0`). Mark the release as a prerelease exactly when the version has a prerelease part, such as `4.0.0-beta.1`. A release version cannot have build metadata (`+...`).

The release workflow has two jobs:

1. **Check and pack** has read access only. It checks the tag, version and repository, installs, runs every check, keeps the tarball that `scripts/check-package.mjs` packed and checked, runs `npm publish --dry-run` on it and uploads that same file as an artifact. A pull request that changes the release workflow or the release scripts, or running the workflow by hand, runs only this job.
2. **Publish** runs only for a published release in `anyfin/bankid`, after the first job passes. It is the only job that can get an npm token, through trusted publishing (OIDC), and it runs in the GitHub environment `npm`. It does not check out or install the repository: it downloads the tarball, checks it again against the repository and the release tag, with the same version rule as `scripts/check-release.mjs`, and publishes that exact file with provenance and with lifecycle scripts disabled. A prerelease version goes under the `next` dist-tag, any other under `latest`.

To require an approval before anything is published, add protection rules to the `npm` environment in the repository settings. In the npm package's trusted publisher settings, name this workflow, `release.yml`, and optionally the `npm` environment.
