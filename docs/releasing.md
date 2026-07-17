# Releasing

This repository contains one public npm package and uses Changesets for versioning and publishing. Publishing runs from `.github/workflows/publish.yml` when a version tag is pushed. The workflow authenticates to npm with GitHub Actions OIDC, so it does not use a long-lived npm token. Use Bun for installation, validation, and package scripts.

## Trusted Publisher Setup

Configure the `opencode-drive` package on npm with this GitHub Actions trusted publisher before pushing a release tag:

- Organization: `anomalyco`
- Repository: `opencode-drive`
- Workflow filename: `publish.yml`
- Environment: leave blank

The workflow requires a GitHub-hosted runner, grants only `contents: read` and `id-token: write`, verifies that the tag exactly matches the package version, and publishes through the configured Changesets command.

## Release 0.5.0

The manifest is already versioned at `0.5.0`, while npm's `latest` version is `0.4.0`. Pending Changesets describe work after `0.5.0`; do not consume them before publishing this release candidate, or the manifest will advance past `0.5.0`.

To publish the current release candidate:

1. Confirm `bun pm view opencode-drive version` still reports `0.4.0`.
2. Run `bun install --frozen-lockfile`.
3. Run `bun run release:validate` and inspect the dry-run package file list and metadata.
4. Push tag `v0.5.0` from the exact validated commit.
5. Watch the publish workflow, then verify npm and install the published artifact in a clean consumer.

Do not run `bun run release:version` for this initial Changesets-managed release.

## Future Releases

1. Run `bun run changeset` for each user-facing change and commit the generated `.changeset/*.md` file with that change.
2. When releasing, run `bun run release:version`. This consumes pending changesets, updates `package.json` and `CHANGELOG.md`, and selects the next version relative to the current manifest version.
3. Run `bun install`, then `bun run release:validate` and inspect the dry-run package contents.
4. Commit the version, changelog, and lockfile updates.
5. Run `bun run release` from that commit. Do not publish with `npm publish` directly.
