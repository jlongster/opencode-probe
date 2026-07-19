# Releasing

This repository contains one public npm package and uses Changesets for versioning and publishing. Publishing runs from `.github/workflows/publish.yml` when a version tag is pushed. The workflow authenticates to npm with GitHub Actions OIDC, so it does not use a long-lived npm token. Use Bun for installation, validation, and package scripts.

## Trusted Publisher Setup

Configure the `opencode-drive` package on npm with this GitHub Actions trusted publisher before pushing a release tag:

- Organization: `anomalyco`
- Repository: `opencode-drive`
- Workflow filename: `publish.yml`
- Environment: leave blank

The workflow requires a GitHub-hosted runner, grants only `contents: read` and `id-token: write`, verifies that the tag exactly matches the package version, and publishes through the configured Changesets command.

## Release Process

1. Run `bun run changeset` for each user-facing change and commit the generated `.changeset/*.md` file with that change.
2. Confirm npm still reports the version in the current package manifest with `bun pm view opencode-drive version`.
3. Run `bun run release:version`. This consumes pending changesets, updates `package.json` and `CHANGELOG.md`, and selects the next version relative to the current manifest version.
4. Run `bun install`, then `bun run release:validate` and inspect the dry-run package contents.
5. Run `bun pm pack`, install the generated artifact in a clean consumer, and verify its public exports before publishing. Remove the local tarball after validation.
6. Commit and merge the version, changelog, lockfile, and consumed changesets.
7. Push tag `v<version>` from that exact merge commit. The publish workflow reruns release validation and publishes through Changesets with npm trusted publishing.
8. Watch the publish workflow, verify npm reports the new version, and install the published artifact in a clean consumer.

Do not publish with `npm publish` directly.
