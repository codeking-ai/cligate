# Releasing

This document describes the expected release shape for CliGate.

## Release Outputs

A normal tagged release is expected to produce:

- a GitHub Release
- desktop artifacts for supported platforms
- a published npm package

## Source of Truth

During development, the local repository is the source of truth for current work.

For shipped artifacts:

- Git tags define intended release versions
- GitHub Releases define published desktop artifacts
- npm defines published package availability

These three surfaces should not drift for long.

## Release Checklist

Before creating a release tag:

1. confirm `package.json` version is correct
2. confirm `README.md` and `README_CN.md` still match the product
3. confirm `docs/product-manual.en.md` and `docs/product-manual.zh-CN.md` still match the product
4. confirm release-facing screenshots are still current or note that they are deferred
5. update `CHANGELOG.md`
6. run release readiness checks

## Workflow

The current release workflow lives in:

- `.github/workflows/build-desktop.yml`

It is expected to:

- verify tag and `package.json` version alignment
- run release readiness checks
- publish npm
- build desktop artifacts
- create a GitHub Release

## npm Authentication

Two publish paths are supported:

1. trusted publishing from GitHub Actions
2. `NPM_TOKEN`-based publishing

Trusted publishing is the preferred path for GitHub-hosted runners.

If you still use `NPM_TOKEN`, make sure it is a current publish-capable token for npm. Token and npm account configuration problems are a common cause of release failures.

## Version Drift

If users report version drift, check these first:

1. `package.json`
2. the latest Git tag
3. the latest GitHub Release
4. the npm package page
5. whether the release workflow completed successfully

## Common Failure Cases

- tag version does not match `package.json`
- `NPM_TOKEN` is missing or no longer valid
- npm token permissions are insufficient for publishing
- npm package ownership is missing for the publishing account
- release docs were not updated and `release-check` fails

## Documentation Rule

If a release changes onboarding, supported tools, routing behavior, or navigation, release-facing docs must be updated in the same release cycle.
