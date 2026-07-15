# CI/CD Proposal for Clerum

## Overview

This proposal introduces GitHub Actions CI/CD pipelines for the Clerum platform. The goal is to automate building, testing, versioning, and deploying all services to the DigitalOcean Container Registry and Kubernetes cluster.

## Current State

| Aspect | Current | Proposed |
|--------|---------|----------|
| **CI/CD** | None — manual `make docker-push` per service | Automated via GitHub Actions |
| **Versioning** | Hardcoded `0.2.0` in Makefiles & deployment YAMLs | Git tags (`v0.3.0`) drive image tags |
| **Registry** | `your-registry.example.com/evenfire/` | Same, automated push |
| **Testing** | Manual `npm run lint` / `npm run test` | Automated on every PR + push to main |
| **Deployment** | Manual `kubectl apply` | Automated deployment on release |

## Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           GitHub Actions                  │
                    │                                           │
  PR / push ───────▶  ci.yaml                                  │
  to main           │  ├─ Lint (all services)                  │
                    │  ├─ Unit tests (mcp-host)                │
                    │  └─ Docker build (verify, no push)       │
                    │                                           │
  git tag ─────────▶  release.yaml                             │
  v*                │  ├─ Build + tag Docker images             │
                    │  ├─ Push to DO Container Registry         │
                    │  └─ Update deployment manifests           │
                    │                                           │
  manual / ────────▶  deploy.yaml                              │
  post-release      │  └─ kubectl apply to DOKS cluster        │
                    └──────────────────────────────────────────┘
```

## Workflows

### 1. CI (`ci.yaml`) — Runs on every PR and push to `main`

**Triggers:** `pull_request` to `main`, `push` to `main`

**Jobs:**

| Job | Steps | Purpose |
|-----|-------|---------|
| **lint** | `npm ci` + `npm run lint` for each service | Catch code quality issues early |
| **test** | `npm ci` + `npm run test` in `mcp-host/` | Run unit tests |
| **build** | `npm ci` + `npm run build` for each service | Verify TypeScript compilation |
| **docker-build** | `docker build` for each service (no push) | Verify Docker images build successfully |

Uses a **matrix strategy** to run lint/build across all 3 services in parallel:
- `channel-reader`
- `mcp-host`
- `context-mapper`

### 2. Release (`release.yaml`) — Runs on version tags

**Trigger:** `push` tags matching `v*` (e.g., `v0.3.0`)

**Jobs:**

| Job | Steps | Purpose |
|-----|-------|---------|
| **build-and-push** | Build Docker images, tag with version + `latest`, push to DOCR | Publish versioned images |

**Image tagging strategy:**
- `your-registry.example.com/evenfire/<service>:<version>` (e.g., `:0.3.0`)
- `your-registry.example.com/evenfire/<service>:latest`
- `your-registry.example.com/evenfire/<service>:sha-<short-sha>` (for traceability)

### 3. Deploy (`deploy.yaml`) — Manual or post-release

**Trigger:** `workflow_dispatch` (manual) with environment selector, or called by `release.yaml`

**Jobs:**

| Job | Steps | Purpose |
|-----|-------|---------|
| **deploy** | `kubectl apply` for CRDs, then each service | Deploy to DOKS cluster |

Requires an **environment approval** gate for production.

## Versioning Strategy

**Monorepo single version:** All services share one version tracked by git tags.

```bash
# To release:
git tag v0.3.0
git push origin v0.3.0
# → Triggers release.yaml → builds all 3 images with tag 0.3.0
```

**Why single version?** The services are tightly coupled (shared CRD definitions, API contracts). Independent versioning would add complexity without benefit at this scale.

## Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean API token for container registry auth |
| `DOKS_KUBECONFIG` | Base64-encoded kubeconfig for the DOKS cluster (deploy only) |

## Workflow Files

Three workflow files are included in `.github/workflows/`:

- **`ci.yaml`** — Continuous integration (lint, test, build)
- **`release.yaml`** — Build, tag, and push images on version tags
- **`deploy.yaml`** — Deploy to Kubernetes (manual trigger or called by release)

## Rollback Strategy

Since images are tagged with both version and git SHA:
1. **Quick rollback:** Re-run deploy workflow with previous version tag
2. **Manual rollback:** `kubectl set image deployment/<svc> <svc>=your-registry.example.com/evenfire/<svc>:<prev-version>`

## Future Enhancements

- **E2E tests in CI**: Run `tests/e2e/` against a local kind/k3d cluster before release
- **Helm chart packaging**: Package and publish Helm charts to a chart repository
- **MCP server images**: Extend the pipeline to build `mcp-servers/airtable` (currently the only one with a custom Dockerfile)
- **Security scanning**: Add Trivy or Snyk container scanning
- **Dependabot**: Automated dependency updates
