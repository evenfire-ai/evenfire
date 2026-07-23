# Contributing to evenfire

Thanks for your interest! evenfire is **open source** under the
[Mozilla Public License 2.0](LICENSE) (MPL-2.0) and requires a signed CLA.

## Dev loop (per service)
Each service is a standalone Node/TypeScript package:
```bash
cd <service>            # e.g. mcp-host, channel-reader, control-api
npm install
npm run build
npm test
npx tsc --noEmit
```
Many services run without Kubernetes via `CLERUM_DEV_MODE=true` (see each
service README and the root README quickstart).

## Tests are required
PRs must include tests for new behavior and keep `npm test` + `npx tsc --noEmit`
green for every changed service. PRs without tests may be closed.

## What we accept
- Bug fixes and improvements to the platform services and core CRDs.
- New first-class capabilities — please open an issue to discuss first.

## What we do NOT accept as PRs
- New third-party MCP servers or WorkflowRecipes. Publish these to the registry
  (see docs) — they are not merged into this repo. This keeps the core lean and
  maintainable (the same model LangChain and n8n use).

## CLA
This project requires a signed Contributor License Agreement. The CLA-assistant
bot will prompt you on your first PR. Contributions may be used in the project's
commercial / managed editions.

See [CLA.md](CLA.md) for the full agreement (draft, pending legal review).
