# Contributing to evenfire

Thanks for your interest. evenfire is **open source** (MPL-2.0). A CLA is
planned but currently [paused pending legal review](#cla) — you do not need to
sign anything to contribute today.

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

> **Paused.** The CLA is undergoing legal review, so the signing gate is
> currently **disabled** — you do **not** need to sign anything to contribute
> today, and the bot will not prompt you.

This project intends to require a Contributor License Agreement once
[CLA.md](CLA.md) is final; contributions may then be used in commercial /
managed editions. Until counsel clears the text, no signature is requested and
no PR is blocked on one.

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Security

[SECURITY.md](SECURITY.md) — never file public issues for vulnerabilities.
