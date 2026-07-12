# Contributing to evenfire

Thanks for your interest. evenfire is **source-available** (Apache-2.0 + a
no-compete addendum) and requires a signed CLA.

## Before you start

1. Read the product framing: [docs/concepts/why-evenfire.md](docs/concepts/why-evenfire.md)
2. Learn the code name split: [docs/concepts/code-names.md](docs/concepts/code-names.md)
3. Prefer a small, tested change. Open an issue before large features.

## Dev loop (per service)

Each service is a standalone Node/TypeScript package (no single root workspace
for app code):

```bash
cd <service>            # e.g. mcp-host, channel-reader, control-api
npm install
npm run build
npm test
npx tsc --noEmit
```

Many services run without Kubernetes via `CLERUM_DEV_MODE=true` — see the root
[quickstart](docs/get-started/quickstart.md) and each service README.

Git hooks: root `npm install` configures [`.githooks/`](.githooks), or run
`npm run install-git-hooks`.

## Tests are required

PRs must include tests for new behavior and keep `npm test` + `npx tsc --noEmit`
green for every changed service. PRs without tests may be closed.

Cluster-level changes: see [docs/testing/e2e-guide.md](docs/testing/e2e-guide.md).

## What we accept

- Bug fixes and improvements to platform services and core CRDs
- Documentation improvements (especially get-started / how-to / FAQ)
- New first-class capabilities — **open an issue first**

## What we do not accept as PRs

- New third-party MCP servers or WorkflowRecipes merged into this monorepo.
  Publish those to the **registry** (see docs) — same lean-core model as many
  extension ecosystems.

## Documentation

User-facing docs live under [`docs/`](docs/README.md). Prefer:

- Tutorials / quickstarts for newcomers
- How-to guides for concrete jobs
- CRD and env reference for facts

Avoid landing internal phase plans or PR-numbered notes on the main docs index.

## CLA

This project requires a signed Contributor License Agreement. The CLA-assistant
bot will prompt you on your first PR. Contributions may be used in commercial /
managed editions.

See [CLA.md](CLA.md) for the agreement text.

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Security

[SECURITY.md](SECURITY.md) — never file public issues for vulnerabilities.
