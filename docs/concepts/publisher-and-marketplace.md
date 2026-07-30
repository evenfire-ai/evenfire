# Publisher & Marketplace — How It All Fits Together

A walk-through of the relationship between orgs, the marketplace, the publisher surface, plugins, and connectors.

## TL;DR

- **Org** = a tenancy boundary. Every deploy is either `curator` (the official `@clerum` catalog) or org-bound (its own namespace like `@acme`).
- **Connector** = an entry that becomes an MCP server (a tool the agent calls at runtime).
- **Plugin** = an entry that becomes a WorkflowRecipe (a multi-step workflow the agent runs).
- **Marketplace** = the catalog everyone browses (`/marketplace/*`).
- **Publisher** = the self-service UI for org owners (`/publisher/*`) to manage *their own* entries, share with other orgs, and mint docker push credentials.

## The Big Picture

```
┌─────────────────────────────────────────────────────────────┐
│  YOUR DEPLOY                                                │
│                                                             │
│  ┌──────────────────────┐    ┌──────────────────────────┐   │
│  │  control-ui (Next)   │    │  control-api (Express)   │   │
│  │                      │    │                          │   │
│  │  /publisher/*  ──────┼──► │  /api/v1/admin/registry  │   │
│  │  /marketplace/* ─────┼──► │   (publish, install,     │   │
│  │                      │    │    grants, keys, ...)    │   │
│  └──────────────────────┘    └──────────┬───────────────┘   │
│                                         │                   │
│  Holds:                                OAuth2 +             │
│  - admin session                       RS256 PoP            │
│  - (no secrets)                        voucher              │
└─────────────────────────────────────────┼───────────────────┘
                                          │
                                          ▼
                          ┌──────────────────────────────┐
                          │   EVENFIRE REGISTRY           │
                          │   (external service)          │
                          │                               │
                          │   • /entries     (catalog)    │
                          │   • /org/:o/keys (efrk_)      │
                          │   • /org/:o/grants            │
                          │   • /deployments/register     │
                          └──────────────────────────────┘
```

`control-api` is the **only trust boundary**. It holds the OAuth2 client secret and the RSA private key for the registry. The browser never sees them.

## The Five Concepts

### 1. Org

An **org** is a tenant — a namespace where entries live. Every deploy belongs to exactly one:

| Deploy kind       | Publish scope               | Example entry            |
|-------------------|-----------------------------|--------------------------|
| **curator**       | unscoped → resolves to `@clerum` | `@clerum/mcp-whois`   |
| **org-bound**     | must use `@<your-org>/...`  | `@acme/mcp-whois`        |

The deploy's org is decided when it's provisioned:

- **Managed deploy** → set by Evenfire directly.
- **Self-hosted deploy** → goes through the [connect flow](#self-hosted-connect-flow) to bind to an org.

At runtime, `GET /admin/registry/publish-scope` returns `{ curator, orgName, scope }` so the UI knows where new entries will land.

### 2. Connectors & Plugins (entries)

There are **two kinds of entry** you can publish:

| Type        | What it is                                                  | When it runs                  | Encoded as                |
|-------------|-------------------------------------------------------------|-------------------------------|---------------------------|
| **Connector**  | An MCP server — a process the agent calls as a tool         | At agent runtime              | K8s `McpServer` + optional `Secret` |
| **Plugin**     | A WorkflowRecipe — a multi-step workflow / prompt template   | At agent runtime via the recipe engine | K8s `WorkflowRecipe`       |

Both share the same publish flow, the same catalog entry shape, and the same metadata (name, version, author, description, category, tags, origin, visibility).

### 3. Marketplace

The **Marketplace** is the catalog surface — what every authenticated admin in your deploy sees.

- **Browse** — `/marketplace`. Search/filter by category, mode, transport. Shows public entries from every org.
- **Install** — `/marketplace/install`. Pick an entry, supply credentials if the entry has a credential schema, hit `POST /admin/registry/install` (or `/install-recipe` for plugins). control-api materializes the K8s resource and tags it with `clerum.io/catalog-id` annotations.
- **Detail** — `/marketplace/entries/[name]/[version]`. View metadata, version history, install instructions.
- **Manage API keys** — `/marketplace/keys`. Generate `efrk_...` keys for CI publishing.
- **Connect** — `/marketplace/connect`. Self-hosted deploys only — bind your deploy to an org.

### 4. Publisher

The **Publisher** is the *owner-only* surface. Once your deploy is org-bound, a "Publisher" entry appears in the sidebar with three tabs:

- **Published entries** (`/publisher/entries`) — your org's entries. Expand a row to share it with another org (cross-org grant).
- **Docker credentials** (`/publisher/credentials`) — mint a `efrk_` API key + docker config so CI can `docker push` images for local-mode connectors.
- **Shared with me** (`/publisher/shared-with-me`) — entries other orgs have granted to yours.

The whole surface is hidden in the sidebar if your deploy isn't org-bound, or if `CONTROL_API_PUBLISHER_UI_ENABLED=false`.

### 5. Grants

**Grants** are how a private entry from one org becomes installable in another org. They're not a separate UI surface — they live inside the Publisher:

- Outbound grants live on each row in `/publisher/entries` (Share access panel).
- Inbound grants live in `/publisher/shared-with-me`.

A grant does **not** copy the entry — it adds the grantee org to the entry's allowed-installer list at the registry.

## How the Pieces Connect

### Publish flow (org-bound admin publishing a new connector)

```
┌──────────────┐   1. Open /marketplace/publish
│ Admin (you)  │ ──────────────────────────────────┐
└──────────────┘                                   ▼
                                ┌────────────────────────────┐
                                │  PublishToRegistryForm     │
                                │  (4-step wizard)           │
                                │                            │
                                │  Step 0 — type + name      │
                                │  Step 1 — metadata         │
                                │  Step 2 — package          │
                                │  Step 3 — review           │
                                └─────────────┬──────────────┘
                                              │ 2. POST /admin/registry/entries
                                              ▼
                                ┌────────────────────────────┐
                                │  control-api               │
                                │  routes/admin/registry.ts  │
                                │                            │
                                │  • resolvePublishScope()   │
                                │  • applyPublishScope()     │
                                │    prefixes @<org>/...     │
                                │  • checkEvenfireImageRef() │
                                │  • validateRemoteUrl()     │
                                └─────────────┬──────────────┘
                                              │ 3. POST /entries (OAuth2)
                                              ▼
                                ┌────────────────────────────┐
                                │  Registry                  │
                                │  creates @org/entry v1.0.0 │
                                └────────────────────────────┘
```

The entry now appears in your `/publisher/entries` tab and (if visibility = `public`) in the public `/marketplace` catalog.

### Install flow (someone installing your entry)

```
Browse /marketplace
       │
       ▼
Click "Install" on @org/entry
       │
       ▼
RegistryInstallForm (or modal)
   • Enter credentials (if connector has a credential schema)
   • Configure server mode / transport / port / egress allowlist
       │
       ▼
POST /admin/registry/install
       │
       ▼
control-api installs in K8s:
   1. Secret (if credentials provided)
   2. McpServer (or WorkflowRecipe)
   3. HostContext allowlist update
   4. report-install → Registry (fire-and-forget)
       │
       ▼
MCP server is now available to agents.
```

### Cross-org grant flow (sharing a private entry)

```
Owner org                  Registry              Grantee org
   │                          │                       │
   │ POST /grants (slug)      │                       │
   ├─────────────────────────►│                       │
   │                          │                       │
   │                          │  entry visible in     │
   │                          │ ─────────────────────►│ /publisher/shared-with-me
   │                          │                       │
   │                          │  grantee installs     │
   │ ◄────────────────────────┼───────────────────────┤ POST /install
   │                          │                       │
```

Revoke = `DELETE /admin/registry/grants/:id`.

### Docker push credential flow (CI publishing images for local-mode connectors)

```
Owner clicks "Generate push credential" in /publisher/credentials
       │
       ▼
POST /admin/registry/keys
       │
       ▼
control-api:
  • require active admin + non-null orgName
  • mint RS256 identity voucher   (registryVoucher.ts)
  • exchange voucher for user token (orgApiKeyClient.ts)
  • POST /org/:org/keys to registry
       │
       ▼
Registry returns { key: "efrk_xxx", dockerconfigjson, registry }
       │
       ▼
Modal reveals key + docker snippets (shown ONCE):
   docker login registry.evenfire.ai -u <org> -p efrk_xxx
   docker push registry.evenfire.ai/<org>/<name>:<tag>
```

### Self-hosted connect flow

```
Admin → /marketplace/connect
   │ enter requested_org_name + contact_email
   ▼
POST /admin/registry/connect/request
   │ control-api:
   │   • generate RSA keypair (persisted in registry_connection table)
   │   • sign PoP with private key (registryPopSigner.ts)
   │   • POST /deployments/register to registry
   │   • store row as status='pending'
   ▼
Status: polls /admin/registry/connect until 'approved'
   │ operator at Evenfire approves
   ▼
Admin pastes claim token → POST /admin/registry/connect/claim
   │ control-api stores client_id + client_secret (AES-256-GCM)
   ▼
Status: 'connected'
   │ all subsequent registry calls use the stored OAuth2 creds
```

## Access Control Layers

The publisher feature has **5 stacked gates**. All must pass.

```
Layer 1: UI sidebar visibility
   isPublisherEnabled(scope)
   → requires org-bound, non-curator, publisherUiEnabled=true
                │
                ▼
Layer 2: control-ui session (JWT in HttpOnly cookie)
                │
                ▼
Layer 3: Registry org-ownership
   → registry returns 403 if caller isn't the org owner
   → surfaced as 403 to admin with the org name
                │
                ▼
Layer 4: Publish-scope apply
   → org-bound deploys MUST publish to @<org>/...
                │
                ▼
Layer 5: ImageRef == entryName parity
   → evenfire-hosted local connectors must have
     imageRef matching the entry name (else pull will fail)
```

A **curator deploy** never sees the Publisher surface because `isPublisherEnabled` returns false for curator scope. A **self-hosted deploy** without a successful `connect` flow has no org at all and also gets nothing.

## Naming Conventions

| Surface       | Path                                  | Who             | Purpose                            |
|---------------|---------------------------------------|-----------------|------------------------------------|
| Publisher     | `/publisher/*`                        | Org owner only  | Manage your org's entries          |
| Marketplace   | `/marketplace/*` (alias `/registry/*`)| All admins      | Browse, install, publish           |

| Entry type             | Prefix              | Example                |
|------------------------|---------------------|------------------------|
| Public catalog (curator) | `@clerum/...`     | `@clerum/mcp-whois`    |
| Your org               | `@<your-org>/...`   | `@acme/mcp-whois`      |

| Resource kind    | Where it lands                                |
|------------------|-----------------------------------------------|
| Connector        | K8s `McpServer` + optional `Secret`           |
| Plugin           | K8s `WorkflowRecipe`                          |

## Where the Code Lives

```
control-ui/                                          frontend
  app/publisher/                                     owner UI
  app/registry/   (= /marketplace)                   marketplace UI
  components/PublisherView/                          publisher panels
  components/PublishToRegistryForm.tsx               publish wizard
  components/RegistryCatalog.tsx                     marketplace browse
  components/RegistryInstallForm/                    install modal
  components/RegistryApiKeysPanel.tsx                efrk_ keys panel
  components/RegistryConnectPanel.tsx                self-host connect
  lib/hooks/usePublishScope.ts                       publisher UI gate

control-api/src/routes/admin/                        backend (BFF)
  registry.ts          (~2414 lines, all HTTP routes)
  registryConnect.ts   (self-hosted connect flow)

control-api/src/services/                            backend logic
  registryClient.ts            OAuth2 + scope + cache
  registryVoucher.ts           RS256 identity voucher minter
  registryPopSigner.ts         RS256 PoP signer for connect
  orgApiKeyClient.ts           voucher → user token + efrk_ keys
  registryConnectionDb.ts      self-host connect persistence
  registryConnectionSchema.ts  registry_connection migration
```

## Glossary

- **Org** — tenancy. Namespaces entries. Curator = `@clerum`; otherwise = `@<your-org>`.
- **Entry** — anything in the catalog. Either a Connector or a Plugin.
- **Connector** — entry that materializes as an `McpServer` (a tool process the agent calls).
- **Plugin** — entry that materializes as a `WorkflowRecipe` (a multi-step workflow).
- **Visibility** — `public` (anyone sees it in the catalog) or `private` (only your org + grantees).
- **Scope** — the resolved `{curator, orgName}` returned by the registry's `whoami`.
- **Voucher** — short-lived RS256 JWT proving this deploy's identity to the registry.
- **PoP** — Proof-of-Possession (RS256 signature on each request, bound to the key).
- **efrk_** — prefix on user-mintable API keys for CI publishing.
- **Curator deploy** — Evenfire's own managed deploy; publishes to `@clerum`.
- **Self-hosted deploy** — your own deployment; goes through the connect flow to bind to an org.
