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

## The pre-commit hook may edit your commit

`core.hooksPath` is `.githooks`, so committing runs `npm run version:staged`
then `npm run format:staged`. Two behaviours surprise people:

- **Your commit can gain files you did not stage.** Changing source under
  `external-rest-api/` or `rpc-proxy/` bumps that package's `package.json`
  patch version, and because `external-rest-api/src/releaseManifest.ts`
  declares those versions, the manifest is regenerated and staged to match.
  That is intended: CI rejects a manifest that disagrees with the packages.
  `desktop-app` is deliberately exempt — its version is the release version,
  set only by `scripts/release/prepare-release.mjs`.
- **A commit can be refused while `releaseManifest.ts` has unstaged changes**,
  even if your commit is unrelated to it. The hook will not regenerate a file
  you are mid-edit on. Stage or discard that file and commit again.

Every refusal names the file and the fix. If you need to bypass the hook to
get unstuck, say so in the PR rather than leaving it silent. The two release
validators run in CI and will catch what the hook would have.

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
