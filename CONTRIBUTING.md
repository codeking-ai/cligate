# Contributing

Thanks for contributing to CliGate.

## Before You Start

- Read [README.md](./README.md) for the project overview.
- Read [docs/README.md](./docs/README.md) for the documentation map.
- If your change affects product behavior or UI flow, update the relevant docs in the same PR.

## Local Setup

```bash
npm install
npm start
```

Useful commands:

```bash
npm test
npm run test:unit
npm run test:all
```

## Pull Request Expectations

Please keep each PR focused and include:

- what problem is being solved
- what changed for users or operators
- screenshots or short recordings for UI changes
- test coverage or manual verification notes
- linked issue or discussion when available

## Documentation Rule

If you change any of the following, update documentation in the same PR:

- dashboard navigation or labels
- setup flow
- supported providers or CLI tools
- route behavior
- screenshots used in `README.md` or `README_CN.md`
- product guidance used by `docs/product-manual.*.md`

## Recommended Workflow

1. Open an issue or discussion for non-trivial changes.
2. Branch from the latest default branch.
3. Make a focused change.
4. Run the relevant tests.
5. Update docs if the product surface changed.
6. Open a PR using the repository template.

## Coding Notes

- Prefer small, reviewable changes over broad refactors.
- Do not revert unrelated work from other contributors.
- Keep behavior changes explicit in the PR description.
- If a feature is incomplete, guard it clearly instead of leaving ambiguous partial behavior.

## UI and Docs

This project has both a dashboard UI and repository-facing documentation.

When the UI changes, keep these aligned:

- `README.md`
- `README_CN.md`
- `docs/README.md`
- `docs/SCREENSHOTS.md`
- `docs/product-manual.en.md`
- `docs/product-manual.zh-CN.md`
- screenshots under `images/`

## Security

Please do not open a public issue for credential leaks, token exposure, or other sensitive security problems. Follow [SECURITY.md](./SECURITY.md).
