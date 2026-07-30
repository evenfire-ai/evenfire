# MCP Connectors — Tracker

> Inventory of all 71 `McpServer` resources currently deployed in the `dev` Minikube
> profile (`kubectl --context=dev get mcpserver -A`). Goal: **50 polished, client-ready
> connectors**. All 71 already exist in dev (`Created: ✅`) — the remaining work is
> polishing them to client-ready quality and verifying them (`Tested`).

## How to read this

| Column      | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| **Created** | Connector exists and is deployed — McpServer CRD live in the dev cluster         |
| **Tested**  | Automated tests pass + manual MCP-tool smoke test confirmed end-to-end           |

## Categories

- **A. Public MCP endpoint wrappers** — point `spec.remote.baseUrl` at a vendor-hosted
  MCP; cluster runs `nginx-egress-proxy` only. Cheapest to add.
- **B. First-party custom image builds** — image is built by Clerum/Evenfire or lives
  in `mcp-servers/`. Needs Dockerfile, secret template, network policy, and tests.
- **C. Upstream image wrappers** — vendor publishes a Docker image; we just deploy it
  with a CRD. No build needed.

---

## A. Public MCP endpoint wrappers (43)

Tunnel through `clerum/nginx-egress-proxy` to a vendor-hosted MCP endpoint. No image
build, just CRD + auth headers + egress binding.

### A.1 Keyless / public docs MCPs (31)

| Connector         | Description                    | Created | Tested | Notes |
| ----------------- | ------------------------------ | ------- | ------ | ----- |
| `apollo-docs`     | Apollo GraphOS docs            | ✅      | ❌     |       |
| `astro-docs`      | Astro framework docs           | ✅      | ❌     |       |
| `aws-knowledge`   | AWS docs & API refs            | ✅      | ❌     |       |
| `bun-docs`        | Bun runtime docs               | ✅      | ❌     |       |
| `clerk-docs`      | Clerk auth SDK docs            | ✅      | ❌     |       |
| `cloudflare-blog` | Cloudflare blog search         | ✅      | ❌     |       |
| `cloudflare-docs` | Cloudflare documentation       | ✅      | ❌     |       |
| `context7`        | Library docs & code snippets   | ✅      | ❌     |       |
| `convex-docs`     | Convex backend guidance        | ✅      | ❌     |       |
| `deepwiki`        | GitHub repo docs & Q&A         | ✅      | ❌     |       |
| `gitmcp`          | Any GitHub repo's docs/code    | ✅      | ❌     |       |
| `hackernews`      | HN feeds, threads, search      | ✅      | ❌     |       |
| `hono-docs`       | Hono framework docs            | ✅      | ❌     |       |
| `huggingface`     | Hugging Face hub (anon)        | ✅      | ❌     |       |
| `langchain-docs`  | LangChain docs                 | ✅      | ❌     |       |
| `llamaindex-docs` | LlamaIndex docs                | ✅      | ❌     |       |
| `manifold`        | Prediction markets             | ✅      | ❌     |       |
| `mdn-docs`        | MDN Web Docs                   | ✅      | ❌     |       |
| `ms-learn`        | Microsoft/Azure docs           | ✅      | ❌     |       |
| `nuxt-docs`       | Nuxt framework docs            | ✅      | ❌     |       |
| `openzeppelin`    | Solidity contracts             | ✅      | ❌     |       |
| `pinecone-docs`   | Pinecone vector DB docs        | ✅      | ❌     |       |
| `resend-docs`     | Resend email docs              | ✅      | ❌     |       |
| `roundtable`      | AI council (niche)             | ✅      | ❌     |       |
| `semgrep`         | Static analysis / security     | ✅      | ❌     |       |
| `svelte-docs`     | Svelte/SvelteKit docs          | ✅      | ❌     |       |
| `trigger-docs`    | Trigger.dev docs               | ✅      | ❌     |       |
| `twilio-docs`     | Twilio API docs                | ✅      | ❌     |       |
| `useful-ai`       | AI utilities (niche)           | ✅      | ❌     |       |
| `wolfram`         | Wolfram computational          | ✅      | ❌     |       |
| `zod-docs`        | Zod v4 docs                    | ✅      | ❌     |       |

### A.2 Authenticated remote MCPs (12)

| Connector                 | Description                           | Auth     | Created | Tested | Notes                           |
| ------------------------- | ------------------------------------- | -------- | ------- | ------ | ------------------------------- |
| `exa`                     | Neural web search                     | API key  | ✅      | ❌     |                                 |
| `firecrawl`               | Scrape/crawl/search                   | Bearer   | ✅      | ❌     |                                 |
| `github`                  | GitHub official remote MCP            | PAT      | ✅      | ❌     |                                 |
| `mcp-alphavantage-remote` | Stock market data                     | API key  | ✅      | ❌     |                                 |
| `mcp-brain-remote`        | Evenfire Brain shared knowledge graph | —        | ✅      | ❌     |                                 |
| `mcp-coingecko-remote`    | Crypto prices & market data           | —        | ✅      | ❌     |                                 |
| `mcp-defillama-remote`    | DeFi analytics (TVL, yields)          | —        | ✅      | ❌     |                                 |
| `mcp-glassnode-remote`    | On-chain metrics                      | —        | ✅      | ❌     |                                 |
| `mcp-stripe-remote`       | Payments & customers                  | —        | ✅      | ❌     |                                 |
| `mcp-tavily-remote`       | AI web search/extract                 | Bearer   | ✅      | ❌     |                                 |
| `postman`                 | Workspaces, collections, APIs         | Bearer   | ✅      | ❌     |                                 |
| `tavily`                  | AI web search                         | Bearer   | ✅      | ❌     | Duplicate of `mcp-tavily-remote`|

---

## B. First-party custom image builds (22)

Image is owned by us (Clerum/Evenfire-built) or lives in `mcp-servers/`. Each needs
Dockerfile, secret template, network policy, and ideally a `__tests__/` suite.

### B.1 In `mcp-servers/` repo (1) — canonical template

| Connector         | Description                     | Image                               | Created | Tested | Notes                                                                             |
| ----------------- | ------------------------------- | ----------------------------------- | ------- | ------ | --------------------------------------------------------------------------------- |
| `airtable-server` | Airtable bases, tables, records | `clerum/airtable-mcp-server:latest` | ✅      | ✅     | Reference template: `mcp-servers/airtable/` — Dockerfile, runtime-bootstrap, `__tests__/` suite |

### B.2 Clerum-built product MCPs (13)

| Connector                 | Description              | Image                                         | Created | Tested | Notes                    |
| ------------------------- | ------------------------ | --------------------------------------------- | ------- | ------ | ------------------------ |
| `evenbill-evenbill-mcp`   | Evenbill workflow MCP    | `clerum/evenbill-mcp:0.3.1`                   | ✅      | ❌     |                          |
| `evenfire-mcp-whois`      | WHOIS lookups            | `registry.evenfire.ai/evenfire/mcp-whois:1.0.0` | ✅    | ❌     |                          |
| `evensign-sign-mcp`       | Document signing         | `clerum/sign-mcp:0.1.0`                       | ✅      | ❌     |                          |
| `evm-safe-scanner`        | Gnosis Safe scanner      | `clerum/evm-safe-scanner-mcp:1.0.5`           | ✅      | ❌     |                          |
| `github-mcp`              | GitHub tools             | `clerum/github-mcp:1.0.1`                     | ✅      | ❌     |                          |
| `helpdesk-v2-admin-mcp`   | Helpdesk admin tools     | `clerum/helpdesk-admin-mcp:0.2.0`             | ✅      | ❌     |                          |
| `helpdesk-v2-context-mcp` | Helpdesk context tools   | `clerum/helpdesk-context-mcp:0.2.0`           | ✅      | ❌     |                          |
| `mcp-contact-finder`      | People/company discovery | `clerum/contact-finder-mcp:v0.2.2`            | ✅      | ❌     |                          |
| `mcp-etherscan`           | Etherscan on-chain reads | `clerum/etherscan-mcp:1.0.0`                  | ✅      | ❌     |                          |
| `mcp-web-research`        | Web search + fetch       | `clerum/web-research-mcp:test`                | ✅      | ❌     |                          |
| `mcp-whois`               | WHOIS lookups            | `clerum/whois-mcp:1.0.0`                      | ✅      | ❌     |                          |
| `web-research`            | Brave search + browser   | `clerum/web-research-mcp:2.0.0`               | ✅      | ❌     |                          |
| `whois`                   | WHOIS lookups            | `clerum/whois-mcp:1.0.0`                      | ✅      | ❌     | Duplicate of `mcp-whois` |

### B.3 Recipe-managed MCPs (8)

Auto-created by the `workflow-recipes` reconciler from a `WorkflowRecipe` CRD.
Treat them as second-class until promoted — the recipe is the source of truth and
deleting it garbage-collects these.

| Connector                                                      | Description        | Image                                       | Created | Tested | Notes |
| -------------------------------------------------------------- | ------------------ | ------------------------------------------- | ------- | ------ | ----- |
| `recipe-agentic-task-board-v2-0-0-a1bc407b-atb-mcp`            | Task board         | `clerum/worktracker-mcp:2.1.5`              | ✅      | ❌     |       |
| `recipe-digest-v1-0-0-6cfaa275-digest-mcp`                     | Content digest     | `apavia/digest-mcp:1.0.0`                   | ✅      | ❌     |       |
| `recipe-evenfire-dev-brain-plugin-v0-1-5-185c2682-brain-mcp`   | Brain plugin       | `clerum/brain-mcp:0.1.5`                    | ✅      | ❌     |       |
| `recipe-evenfire-dev-leadforge-v1-2-0-75cbb-lf-research-18c952c3` | Leadforge research | `clerum/leadforge-web-research:2.0.2`    | ✅      | ❌     |       |
| `recipe-evenfire-dev-leadforge-v1-2-0-75cbb8e-lf-finder-5c3f98c7`  | Leadforge finder   | `clerum/leadforge-finder:0.2.4`          | ✅      | ❌     |       |
| `recipe-evenfire-dev-leadforge-v1-2-0-75cbb8e8-lf-query-c28908fd`  | Leadforge query    | `clerum/leadforge-query:0.1.1`           | ✅      | ❌     |       |
| `recipe-evenfire-worktracker-v1-1-0-66ce9c41-wt-mcp-9e07456d`  | Worktracker        | `registry.evenfire.ai/evenfire/worktracker-mcp:2.2.3` | ✅ | ❌ |       |
| `recipe-sqlite-mcp-stack-v1-0-0-f0ea309a-sqlite-mcp`           | SQLite             | `clerum/sqlite-mcp:test`                    | ✅      | ❌     |       |

---

## C. Upstream image wrappers (6)

Vendor publishes a Docker image; we just deploy it. No build, just CRD + (optional)
secret.

| Connector                                       | Description             | Image                                         | Created | Tested | Notes |
| ----------------------------------------------- | ----------------------- | --------------------------------------------- | ------- | ------ | ----- |
| `mcp-github`                                    | GitHub (official image) | `mcp/github@sha256:89fd...`                   | ✅      | ❌     |       |
| `mcp-fred`                                      | FRED economic data      | `stefanoamorelli/fred-mcp-server:latest`      | ✅      | ❌     |       |
| `mcp-sec-edgar`                                 | SEC filings             | `stefanoamorelli/sec-edgar-mcp:latest`        | ✅      | ❌     |       |
| `research-summary-workflow-web-search-f43d0396` | Open web search         | `ghcr.io/aas-ee/open-web-search:latest`       | ✅      | ❌     |       |
| `recipe-helpdesk-v1-0-0-4549198b-admin-mcp`     | Helpdesk admin          | `docker.io/apavia/helpdesk-admin-mcp:0.1.5`   | ✅      | ❌     |       |
| `recipe-helpdesk-v1-0-0-4549198b-context-mcp`   | Helpdesk context        | `docker.io/apavia/helpdesk-context-mcp:0.1.3` | ✅      | ❌     |       |

---

## Quick triage notes

- **Duplicates to consolidate:** `whois` vs `mcp-whois`, `tavily` vs `mcp-tavily-remote`.
- **Recipe-managed (B.3) probably shouldn't count** toward the 50 — they're tied to a
  recipe lifecycle and disappear if the recipe does.
- **Auth-required proxies (A.2)** all need real secrets wired up before they can be
  marked Tested.
- **Sample connectors in `mcp-servers/` but NOT in dev:** `mongodb`, `playwright`,
  `web-search`, `doc-generator`, `alphavantage`. Not counted in the 71 but still part
  of the candidate pool for the 50.

## Tally

| Category                        | Items |
| ------------------------------- | ----- |
| A. Public MCP endpoint wrappers | 43    |
| B. First-party custom builds    | 22    |
| C. Upstream image wrappers      | 6     |
| **Total deployed in dev**       | **71**|
| **Target for client-ready**     | **50**|

Generated from `kubectl --context=dev get mcpserver -A` on the current dev profile.

---

## Candidates (45)

Net-new connectors to build — popular enterprise MCP servers. **Source** reflects
best-known availability (verify per vendor before committing): *Official remote* =
vendor-hosted MCP endpoint (Category A build), *Official* = vendor ships a server or
image (Category B/C build), *Community* = third-party server to vet and package,
*Reference* = MCP-org reference server.

### Collaboration & project management (10)

| Connector          | Description                        | Source          | Created | Tested | Notes                          |
| ------------------ | ---------------------------------- | --------------- | ------- | ------ | ------------------------------ |
| `atlassian`        | Jira & Confluence (Rovo MCP)       | Official remote | ✅      | ❌     | Deployed in dev (Batch 1); needs real `ATLASSIAN_API_KEY` + smoke test |
| `slack`            | Channels, messages, search         | Official        | ❌      | ❌     |                                |
| `notion`           | Pages, databases, wikis            | Official        | ❌      | ❌     |                                |
| `linear`           | Issues, projects, cycles           | Official remote | ✅      | ❌     | Deployed in dev (Batch 1); needs real `LINEAR_API_KEY` + smoke test    |
| `asana`            | Tasks, projects, portfolios        | Official remote | ✅      | ❌     | Deployed in dev (Batch 1); needs real token (verify PAT vs OAuth) + smoke test |
| `monday`           | Boards, items, workflows           | Official        | ❌      | ❌     |                                |
| `clickup`          | Tasks, docs, spaces                | Community       | ❌      | ❌     |                                |
| `google-workspace` | Drive, Docs, Sheets, Gmail         | Community       | ❌      | ❌     |                                |
| `microsoft-365`    | SharePoint, OneDrive, Teams        | Community       | ❌      | ❌     |                                |
| `box`              | Files, folders, metadata           | Official        | ❌      | ❌     |                                |

### CRM, sales & support (6)

| Connector    | Description                   | Source    | Created | Tested | Notes |
| ------------ | ----------------------------- | --------- | ------- | ------ | ----- |
| `salesforce` | CRM objects, queries, reports | Community | ❌      | ❌     |       |
| `hubspot`    | Contacts, deals, tickets      | Official  | ❌      | ❌     |       |
| `zendesk`    | Tickets, help center          | Community | ❌      | ❌     |       |
| `intercom`   | Conversations, contacts       | Official  | ❌      | ❌     |       |
| `amplitude`  | Product analytics             | Official  | ❌      | ❌     | Remote endpoint verified (`mcp.amplitude.com/mcp`) but OAuth-only |
| `posthog`    | Product analytics, flags      | Official  | ✅      | ❌     | Deployed in dev (Batch 2); needs real `POSTHOG_API_KEY` (phx_) + smoke test |

### Dev & CI/CD (8)

| Connector      | Description                  | Source          | Created | Tested | Notes |
| -------------- | ---------------------------- | --------------- | ------- | ------ | ----- |
| `gitlab`       | Repos, MRs, pipelines        | Community       | ❌      | ❌     | Endpoint verified (`gitlab.com/api/v4/mcp`, official Beta) but OAuth-only |
| `sentry`       | Errors, issues, releases     | Official remote | ✅      | ❌     | Deployed in dev (Batch 1); needs real `SENTRY_ACCESS_TOKEN` + smoke test |
| `pagerduty`    | Incidents, on-call, services | Official        | ✅      | ❌     | Deployed in dev (Batch 2); needs real `PAGERDUTY_API_KEY` + smoke test |
| `circleci`     | Pipelines, jobs, insights    | Official        | ✅      | ❌     | Deployed in dev (Batch 2); needs real `CIRCLECI_TOKEN` + smoke test    |
| `buildkite`    | Builds, pipelines, agents    | Official        | ✅      | ❌     | Deployed in dev (Batch 2); needs real `BUILDKITE_API_TOKEN` + smoke test |
| `snyk`         | Vuln scanning, SAST          | Official        | ❌      | ❌     | No remote endpoint (verified) — local CLI only; Category B build needed |
| `vercel`       | Deployments, projects, logs  | Official        | ❌      | ❌     | Remote endpoint verified (`mcp.vercel.com`) but OAuth-only; public doc tools work unauthenticated |
| `launchdarkly` | Feature flags                | Official        | ❌      | ❌     | Remote endpoint verified (`mcp.launchdarkly.com/mcp/launchdarkly`) but OAuth-only |

### Cloud, infra & data (10)

| Connector       | Description                   | Source    | Created | Tested | Notes                      |
| --------------- | ----------------------------- | --------- | ------- | ------ | -------------------------- |
| `docker`        | Hub, images, containers       | Official  | ❌      | ❌     | No remote endpoint — local MCP Toolkit only; Category B/C build needed |
| `kubernetes`    | Pods, deployments, logs       | Community | ❌      | ❌     | No remote endpoint — `containers/kubernetes-mcp-server` image wrap (Category C) |
| `terraform`     | State, plans, registry        | Community | ❌      | ❌     | No remote endpoint — official `hashicorp/terraform-mcp-server` image wrap (Category C) |
| `postgresql`    | SQL queries, schema inspect   | Reference | ❌      | ❌     | No vendor remote — needs DB instance; Category B/C with connection-string secret |
| `redis`         | Keys, streams, pub/sub        | Official  | ❌      | ❌     | No remote endpoint — official `redis/mcp-redis` image wrap + Redis instance (Category C) |
| `elasticsearch` | Search, indices, aggregations | Official  | ❌      | ❌     | Endpoint is per-Kibana deployment (`{KIBANA_URL}/api/agent_builder/mcp`) — needs client tenant |
| `neo4j`         | Graph queries (Cypher)        | Official  | ❌      | ❌     | No remote endpoint — official `neo4j/mcp` self-host + Neo4j instance (Category C) |
| `supabase`      | Postgres, auth, storage       | Official  | ✅      | ❌     | Deployed in dev (Batch 2); needs real `SUPABASE_ACCESS_TOKEN` + smoke test |
| `snowflake`     | Warehouses, queries, Cortex   | Official  | ❌      | ❌     | Endpoint is per-account (`<account_url>/api/v2/...`) — needs client tenant |
| `databricks`    | Notebooks, clusters, SQL      | Community | ❌      | ❌     | Endpoint is per-workspace — needs client tenant URL + PAT           |

### Security & identity (3)

| Connector     | Description                 | Source    | Created | Tested | Notes              |
| ------------- | --------------------------- | --------- | ------- | ------ | ------------------ |
| `onepassword` | Vault items, secrets lookup | Community | ❌      | ❌     | No remote endpoint — local stdio only (desktop app unlock); not proxy-able |
| `okta`        | Users, groups, apps         | Community | ❌      | ❌     | No remote endpoint — official self-hosted `okta-mcp-server` (Category B/C) |
| `auth0`       | Tenants, apps, users        | Community | ❌      | ❌     | No remote endpoint — official local `@auth0/auth0-mcp-server` (Category B/C) |

### Finance & commerce (4)

| Connector    | Description                  | Source    | Created | Tested | Notes |
| ------------ | ---------------------------- | --------- | ------- | ------ | ----- |
| `paypal`     | Payments, invoices, disputes | Official  | ✅      | ❌     | Deployed in dev (Batch 2); needs real `PAYPAL_ACCESS_TOKEN` + smoke test |
| `square`     | Payments, orders, catalog    | Official  | ❌      | ❌     | Remote endpoint verified (`mcp.squareup.com/sse`) but SSE+OAuth-only |
| `shopify`    | Products, orders, storefront | Official  | ❌      | ❌     | Endpoint is per-shop (`{shop}.myshopify.com/api/mcp`) — needs client shop domain |
| `quickbooks` | Accounting, invoices         | Community | ❌      | ❌     | No remote endpoint — official local stdio only (Category B/C)       |

### Design & content (4)

| Connector    | Description                 | Source    | Created | Tested | Notes |
| ------------ | --------------------------- | --------- | ------- | ------ | ----- |
| `figma`      | Files, components, Dev Mode | Official  | ❌      | ❌     | Remote endpoint verified (`mcp.figma.com/mcp`) but OAuth-only (catalog clients) |
| `canva`      | Designs, brand kits         | Official  | ❌      | ❌     | Remote endpoint verified (`mcp.canva.com/mcp`) but OAuth-only       |
| `webflow`    | Sites, CMS collections      | Official  | ❌      | ❌     | Remote endpoint verified (`mcp.webflow.com/mcp`) but OAuth-only     |
| `contentful` | Content models, entries     | Official  | ❌      | ❌     | No remote endpoint — official `@contentful/mcp-server` self-host (Category B/C) |

---

## Beyond the 45 — added during Batch 2 (deployed in dev)

Additional vendors with verified official remote endpoints, deployed alongside
Batch 2. YAMLs in `mcp-servers/_new/`.

| Connector   | Description                     | Endpoint                                          | Auth                | Created | Tested | Notes                                              |
| ----------- | ------------------------------- | ------------------------------------------------- | ------------------- | ------- | ------ | -------------------------------------------------- |
| `neon`      | Serverless Postgres             | `https://mcp.neon.tech/mcp`                       | Bearer API key      | ✅      | ❌     | Needs real `NEON_API_KEY` + smoke test             |
| `gitbook`   | Docs sites & content            | `https://mcp.gitbook.com/mcp`                     | Bearer PAT          | ✅      | ❌     | Needs real `GITBOOK_TOKEN` + smoke test            |
| `sanity`    | Content lake CMS                | `https://mcp.sanity.io`                           | Bearer API token    | ✅      | ❌     | Needs real `SANITY_API_TOKEN` + smoke test         |
| `xata`      | Serverless Postgres branches    | `https://api.xata.tech/mcp`                       | Bearer API key      | ✅      | ❌     | Needs real `XATA_API_KEY` + smoke test             |
| `datadog`   | Observability                   | `https://mcp.datadoghq.com/api/unstable/mcp-server/mcp` | Bearer PAT/SAT | ✅      | ❌     | Needs real `DATADOG_ACCESS_TOKEN` + smoke test     |
| `newrelic`  | Observability (NRQL, entities)  | `https://mcp.newrelic.com/mcp/`                   | `Api-Key` header    | ✅      | ❌     | Needs real `NEW_RELIC_API_KEY` + smoke test        |
| `dbt`       | dbt Cloud semantic layer        | `https://cloud.getdbt.com/api/ai/v1/mcp/`         | `Token` + env-id hdr| ✅      | ❌     | Needs real `DBT_TOKEN` + `DBT_PROD_ENVIRONMENT_ID` |

Also deployed from the repo pool: `playwright-server` (Category C upstream image,
from `mcp-servers/playwright/`).

## Beyond the 45 — verified endpoints, pending deploy (OAuth-only)

These have confirmed official remote endpoints but only accept interactive OAuth —
they can be deployed keyless (vendor will 401 until a token strategy exists), or
wait for an OAuth/token-broker solution:

| Vendor       | Endpoint                                            |
| ------------ | --------------------------------------------------- |
| Netlify      | `https://netlify-mcp.netlify.app/mcp`               |
| Miro         | `https://mcp.miro.com/`                             |
| Turso        | `https://mcp.turso.ai/mcp`                          |
| PlanetScale  | `https://mcp.pscale.dev/mcp/planetscale`            |
| ClickHouse   | `https://mcp.clickhouse.cloud/mcp`                  |
| Grafana Cloud| `https://mcp.grafana.com/mcp`                       |
| Wix          | `https://mcp.wix.com/mcp`                           |
| Builder.io   | `https://mcp.builder.io/mcp/publish`                |

No remote endpoint (Category B/C builds): ElevenLabs (local stdio only).

---

## Work log — session status of every connector touched

Status column meanings:

| Column        | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| **Created**   | YAML artifact exists in this repo (`mcp-servers/_new/` or `mcp-servers/<name>/`)     |
| **Uploaded**  | Applied to the dev cluster, `Ready=True`, visible in the `/connectors` UI            |
| **Tested**    | Real credentials wired + MCP handshake (`initialize`/`tools.list`) verified          |

### Uploaded + Created (18)

All deployed with **placeholder secrets** — swapping in a real API key + smoke test
flips Tested to ✅. YAMLs live in `mcp-servers/_new/` (except playwright).

| Connector          | Created | Uploaded | Tested | Notes                                            |
| ------------------ | ------- | -------- | ------ | ------------------------------------------------ |
| `atlassian`        | ✅      | ✅       | ❌     | Needs real `ATLASSIAN_API_KEY`                   |
| `linear`           | ✅      | ✅       | ❌     | Needs real `LINEAR_API_KEY`; proxy path verified end-to-end |
| `asana`            | ✅      | ✅       | ❌     | Needs real token; verify PAT vs OAuth            |
| `sentry`           | ✅      | ✅       | ❌     | Needs real `SENTRY_ACCESS_TOKEN`                 |
| `pagerduty`        | ✅      | ✅       | ❌     | Needs real `PAGERDUTY_API_KEY`                   |
| `circleci`         | ✅      | ✅       | ❌     | Needs real `CIRCLECI_TOKEN`                      |
| `buildkite`        | ✅      | ✅       | ❌     | Needs real `BUILDKITE_API_TOKEN`                 |
| `posthog`          | ✅      | ✅       | ❌     | Needs real `POSTHOG_API_KEY` (phx_)              |
| `supabase`         | ✅      | ✅       | ❌     | Needs real `SUPABASE_ACCESS_TOKEN`               |
| `neon`             | ✅      | ✅       | ❌     | Needs real `NEON_API_KEY`                        |
| `gitbook`          | ✅      | ✅       | ❌     | Needs real `GITBOOK_TOKEN`                       |
| `sanity`           | ✅      | ✅       | ❌     | Needs real `SANITY_API_TOKEN`                    |
| `xata`             | ✅      | ✅       | ❌     | Needs real `XATA_API_KEY`                        |
| `datadog`          | ✅      | ✅       | ❌     | Needs real `DATADOG_ACCESS_TOKEN`                |
| `newrelic`         | ✅      | ✅       | ❌     | Needs real `NEW_RELIC_API_KEY`                   |
| `dbt`              | ✅      | ✅       | ❌     | Needs real `DBT_TOKEN` + `DBT_PROD_ENVIRONMENT_ID` |
| `paypal`           | ✅      | ✅       | ❌     | Needs real `PAYPAL_ACCESS_TOKEN`                 |
| `playwright-server`| ✅      | ✅       | ❌     | No secret needed; pre-existing YAML at `mcp-servers/playwright/` |

### Created but not uploaded (0)

None — every YAML written this session was applied to the cluster.

### Not created — verified remote endpoint, OAuth-only (16)

Endpoints confirmed against official docs, but vendors only accept interactive
OAuth. Can be deployed keyless (shows in UI, vendor 401s until a token strategy
exists) or held until OAuth/token-broker support lands.

| Connector      | Endpoint                                              |
| -------------- | ----------------------------------------------------- |
| `gitlab`       | `https://gitlab.com/api/v4/mcp`                       |
| `vercel`       | `https://mcp.vercel.com`                              |
| `launchdarkly` | `https://mcp.launchdarkly.com/mcp/launchdarkly`       |
| `amplitude`    | `https://mcp.amplitude.com/mcp`                       |
| `square`       | `https://mcp.squareup.com/sse` (SSE only)             |
| `figma`        | `https://mcp.figma.com/mcp`                           |
| `canva`        | `https://mcp.canva.com/mcp`                           |
| `webflow`      | `https://mcp.webflow.com/mcp`                         |
| `netlify`      | `https://netlify-mcp.netlify.app/mcp`                 |
| `miro`         | `https://mcp.miro.com/`                               |
| `turso`        | `https://mcp.turso.ai/mcp`                            |
| `planetscale`  | `https://mcp.pscale.dev/mcp/planetscale`              |
| `clickhouse`   | `https://mcp.clickhouse.cloud/mcp`                    |
| `grafana`      | `https://mcp.grafana.com/mcp`                         |
| `wix`          | `https://mcp.wix.com/mcp`                             |
| `builder-io`   | `https://mcp.builder.io/mcp/publish`                  |

### Not created — no remote endpoint, Category B/C build required (13)

| Connector       | Path forward                                                        |
| --------------- | ------------------------------------------------------------------- |
| `snyk`          | Local CLI only — custom build                                        |
| `docker`        | Local MCP Toolkit only — custom build                                |
| `kubernetes`    | Image wrap: `containers/kubernetes-mcp-server` (community)           |
| `terraform`     | Image wrap: `hashicorp/terraform-mcp-server` (official)              |
| `postgresql`    | Needs DB instance + image wrap                                       |
| `redis`         | Image wrap: `redis/mcp-redis` (official) + Redis instance            |
| `neo4j`         | Image wrap: `neo4j/mcp` (official) + Neo4j instance                  |
| `onepassword`   | Local stdio only (desktop app unlock) — not proxy-able               |
| `okta`          | Self-host: official `okta-mcp-server`                                |
| `auth0`         | Self-host: official `@auth0/auth0-mcp-server`                        |
| `quickbooks`    | Self-host: official Intuit local server                              |
| `contentful`    | Self-host: official `@contentful/mcp-server`                         |
| `elevenlabs`    | Self-host: official `elevenlabs-mcp` (local stdio)                   |

### Not created — per-tenant endpoint, needs a client account (4)

| Connector       | Endpoint pattern                                             |
| --------------- | ------------------------------------------------------------ |
| `elasticsearch` | `{KIBANA_URL}/api/agent_builder/mcp`                         |
| `snowflake`     | `<account_url>/api/v2/databases/{db}/schemas/{s}/mcp-servers/{name}` |
| `databricks`    | `https://<workspace>/api/2.0/mcp/...`                        |
| `shopify`       | `https://{shop}.myshopify.com/api/mcp`                       |

### Not researched yet — collab/CRM batch (11)

Research agent was cancelled twice; endpoints unverified. Run next.

| Connector          | Connector   |
| ------------------ | ----------- |
| `slack`            | `box`       |
| `notion`           | `salesforce`|
| `monday`           | `hubspot`   |
| `clickup`          | `zendesk`   |
| `google-workspace` | `intercom`  |
| `microsoft-365`    |             |