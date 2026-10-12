# Control UI

Admin dashboard for the control plane. A Next.js (App Router) React app that manages agents, connectors, plugins, files, the marketplace, users/teams, cost, and secrets through `control-api`.

## How It Works

- The browser only talks to same-origin paths: all API calls go to `/control-api/*` (base overridable via `NEXT_PUBLIC_CONTROL_API_BASE_URL`).
- A Next.js route handler (`app/control-api/[...path]/route.ts`) proxies those requests server-side to `CONTROL_API_INTERNAL_URL` (default `http://127.0.0.1:8090`), stripping hop-by-hop headers, with a 30 s upstream timeout.
- Dashboard pages redirect unauthenticated visitors to the login page — most via `<AuthGate>` (`components/AuthGate`), either directly or through a section shell (e.g. `/cost/*` via `CostShell`); the rest use an equivalent `useAuth` redirect.

## Authentication

Control UI requires an admin login — it is not an open dashboard.

- The root page (`app/page.tsx`) is a username/password login form with a forgot-password flow.
- Login posts to control-api `POST /api/v1/admin/auth/login`; the session is a signed admin JWT stored in an HttpOnly cookie set by control-api (`components/AuthContext.tsx`, `lib/api.ts`).
- control-api seeds a bootstrap admin from `CONTROL_API_ADMIN_BOOTSTRAP_USERNAME` / `CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH` and locks an account after repeated failed logins (`CONTROL_API_ADMIN_AUTH_MAX_FAILURES`, default 5, for `CONTROL_API_ADMIN_AUTH_LOCK_MINUTES`, default 15).
- The only unauthenticated routes are the public token flows — admin invitations, password resets, and email confirmations (`/admin-invitations/[token]`, `/admin-password-resets/[token]`, `/admin-email-confirmations/[token]`); the invitation and password-reset form posts are CSRF-protected with an HMAC token (`lib/controlAdminCsrf.ts`) — email confirmation has no form post.

## Sections

Sidebar destinations map to the public routes in `app/constants/routes.ts` (`components/Sidebar/constants.tsx`). Several public routes are rewrites onto older physical `app/` folders (for example `/agents` → `app/hosts`, `/connectors` → `app/mcp-servers`, `/agent-files` → `app/shared-filesystems`); see `next.config.js`.

| Sidebar label         | Public route                                                                           | Contents                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Users & Teams         | `/users-and-teams/users`                                                               | Users, teams (admin / inviter / member roles), and control admins                                  |
| Agents                | `/agents`                                                                              | Agent (Host) list, detail tabs, guided creation wizard; creates a private Context per agent        |
| Marketplace           | `/marketplace`                                                                         | Catalog plus the org tab `/marketplace/org` (entries, credentials, connection), formerly Publisher |
| Installed Connectors  | `/connectors`                                                                          | MCP servers: list, create (incl. remote/OAuth), edit, credentials, egress policy                   |
| Installed Plugins     | `/plugins`                                                                             | Installed plugins by namespace/name: editor, secrets, integrations, runs                           |
| Installed Guardrails  | `/guardrails`                                                                          | Installed guardrail hooks (`LlmHook`) and their install editor                                     |
| Files                 | `/agent-files`                                                                         | Shared filesystem resources                                                                        |
| Files › EvenDrive     | `/global-file-system`                                                                  | Global File System browser and grant delegation                                                    |
| Files › Agent Outputs | `/agent-outputs/recipe-artifacts`                                                      | Generated outputs                                                                                  |
| External Channels     | `/external-channels`                                                                   | Communication channel resources                                                                    |
| LLM Models            | `/llm-models`                                                                          | Model allowlist catalog and discovery review                                                       |
| Secrets               | `/secrets/llm`                                                                         | Secrets by scope, LLM subscriptions, recipe secrets (values are write-only from the UI)            |
| Cost & Usage          | `/cost-and-usage/usage`, `/cost-and-usage/llm-prices`, `/cost-and-usage/token-budgets` | Token usage dashboard, model prices, token budgets                                                 |
| Settings              | `/settings/ui`                                                                         | Control settings panel                                                                             |

Routes not in the sidebar: `/users-and-teams/admins/new` (invite a control admin; `/control-admins/new` redirects there), `/plugins/sdk` (SDK grants and invocation search), `/traces/*` (hidden Traces section), and the public token flows listed above. Legacy paths such as `/cost/*`, `/registry`, `/publisher/*`, `/mcp-servers`, `/hosts` and `/contexts` redirect to their current locations (`next.config.js`, `components/LegacyContextRedirect`).

## Notable Features

- **UsageDashboard** (`components/UsageDashboard`) — recharts stacked-area chart of input/output tokens over time, with breakdowns including team, model, agent (host), and desktop user (8 group-by dimensions in all — also recipe, provider, LLM secret, and source kind).
- **LlmPriceTable / TokenBudgetTable** — per-1M-token model prices (input, output, cache read/write) and token budgets with scope and progress. Budgets are cost control, not a security boundary.
- **RegistryCatalog** (`components/RegistryCatalog.tsx`) — marketplace entries with trust levels (high/mid/low), a guided install flow, and org-scoped publish API keys (create/reveal/revoke) under `/registry/keys`.
- **HostApprovalSection** (`components/HostApprovalSection`) — per-tool approval editor (Default/Required/Skip) for a host's native tools, with risk hints whenever a setting loosens a required-by-default approval.
- **EgressEditor** (`components/EgressEditor.tsx`) — egress policy editor with closed-by-default, exact-host, exact-CIDR/IP, and public-web modes; private, metadata, link-local, and reserved IPv4 ranges are rejected (`lib/egressModel.ts`).

## Configuration

| Variable                                    | Explanation                                                                       | Canonical example                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `CONTROL_API_INTERNAL_URL`                  | Server-side proxy target for `/control-api/*` requests.                           | `http://control-api.control-plane.svc.cluster.local:8090` |
| `CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET`       | HMAC secret for CSRF tokens on public token pages (invitations, password resets). | random string (set via `control-ui-secrets`)              |
| `NEXT_PUBLIC_CONTROL_API_BASE_URL`          | Browser-side API base path; defaults to the same-origin `/control-api` proxy.     | `/control-api`                                            |
| `NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES` | Shows local recipe templates in the recipe editor.                                | `true`                                                    |
| `PORT`                                      | Inert — the Docker `CMD` runs `next start -p 3000`, and `-p` overrides `PORT`.    | `3000`                                                    |

## Ports

- `3000` — Next.js HTTP server (`npm run start` binds `-p 3000`; the in-cluster Service exposes the same port).

## Local Development

```bash
cd control-ui
npm install
npm run dev          # needs CONTROL_API_INTERNAL_URL pointing at a control-api
```

Or from the repository root, `npm run web` (→ `make local-web`) port-forwards `control-api` to `localhost:8090`, waits for it to become healthy, then starts the UI with `CONTROL_API_INTERNAL_URL=http://localhost:8090`.

### npm scripts

| Script       | Command                                       |
| ------------ | --------------------------------------------- |
| `dev`        | `NEXT_IGNORE_INCORRECT_LOCKFILE=1 next dev`   |
| `build`      | `NEXT_IGNORE_INCORRECT_LOCKFILE=1 next build` |
| `start`      | `next start -p 3000`                          |
| `test`       | `vitest run`                                  |
| `test:watch` | `vitest`                                      |

## Testing

- **Unit/component tests**: 77 Vitest files (jsdom + Testing Library) — 54 under `components/__tests__/`, 21 under `lib/__tests__/`, 2 under `lib/hooks/__tests__/` — `npm test`.
- **End-to-end tests**: 25 Playwright specs under `e2e/` (`npx playwright test`), covering operator journeys such as registry install, approval flows, GFS, and workflow runs against a running cluster (`CONTROL_UI_URL` sets the base URL).

## Deploy

```bash
cd control-ui
make docker-push     # build + push the image
```

Kubernetes manifests live in `deploy/base/control-plane/control-ui.yaml` (namespace `control-plane`); in-cluster service URL: `http://control-ui.control-plane.svc.cluster.local:3000`.
