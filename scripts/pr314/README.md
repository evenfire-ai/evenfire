# PR #314 registry egress migration helpers

These helpers prepare the registry/template migration for PR #314 runtime egress hardening.

## Audit only

Seed catalog only:

```bash
node scripts/pr314/audit-registry-egress.mjs
```

Seed catalog plus live `example-dev` resources:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH \
  node scripts/pr314/audit-registry-egress.mjs \
  --live \
  --context gke_${GCP_PROJECT}_us-central1-a_example-dev
```

The audit is read-only. It reports:

- registry MCP entries missing `egressSummary`;
- `wideCidr: true` entries that must install as explicit `public-web`;
- stale web-search fixtures outside seeds;
- live `McpServer` objects that look external but have no `spec.egressBindings`;
- live `WorkflowRecipe` transport workloads that have no `workloads[].egressBindings`;
- legacy WRC `*-mcp-servers-egress-internet` NetworkPolicies that PR #314 should prune.

If the registry DB may differ from the repo seeds, point the auditor at the live registry API too:

```bash
node scripts/pr314/audit-registry-egress.mjs \
  --registry-url http://127.0.0.1:8085
```

`--registry-url` accepts either the registry root URL or an `/api/v1` URL. It
paginates with `GET /entries?limit=200&offset=...`, matching the Registry API
maximum page size.

## Prepare live registry DB metadata migration

Seed changes do not update already-published registry rows because the seed
loader skips existing entries. Use the DB metadata helper after the new code is
deployed and before reinstalling affected catalog entries from the live
registry.

Existing installed `McpServer` resources are separate from registry DB rows. The
safe migration order is:

1. Patch live registry DB metadata with this DB helper so future installs and
   upgrades translate to the intended exact-host or public-web CRD shape.
2. Patch existing K8s resources with `prepare-registry-egress-migration.mjs`
   because already-installed `McpServer` and `WorkflowRecipe` objects do not
   automatically reread registry metadata.
3. Run `audit-registry-egress.mjs --registry-url ... --live ...` and verify no
   stale registry rows, missing live bindings, or legacy broad policies remain.

Dry-run:

```bash
node scripts/pr314/prepare-registry-db-egress-migration.mjs \
  --registry-url http://127.0.0.1:8085 \
  --snapshot-file /tmp/registry-egress-before.json \
  --sql-file /tmp/registry-egress.sql
```

Apply requires explicit approval and a database URL:

```bash
node scripts/pr314/prepare-registry-db-egress-migration.mjs \
  --registry-url http://127.0.0.1:8085 \
  --snapshot-file /tmp/registry-egress-before.json \
  --sql-file /tmp/registry-egress.sql \
  --database-url "$REGISTRY_DATABASE_URL" \
  --apply
```

The script paginates the registry catalog with `limit=200&offset=...` before
building patches. It is allowlist-based. The first allowlisted entry is
`mcp-web-research`, which keeps `wideCidr:true` as the compatibility trigger for
PR #314 `public-web` until the immediate cleanup PR replaces authoring metadata
with explicit `egressClass`.

`wideCidr` sunset: after this migration PR is deployed and the live registry DB
audit shows no unexpected `wideCidr:true` rows, run the immediate cleanup PR
described in the registry egress migration plan. That follow-up removes
`wideCidr` from seed authoring, adds explicit
`egressClass: "exact-host" | "public-web"` registry metadata, and keeps
`wideCidr:true` only as temporary read compatibility for already-published rows.

## Prepare migration patches

Dry-run live patch plan:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH \
  node scripts/pr314/prepare-registry-egress-migration.mjs \
  --live \
  --context gke_${GCP_PROJECT}_us-central1-a_example-dev
```

Apply exact-host patches only:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH \
  node scripts/pr314/prepare-registry-egress-migration.mjs \
  --live \
  --context gke_${GCP_PROJECT}_us-central1-a_example-dev \
  --apply
```

Apply explicit `public-web` patches too:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH \
  node scripts/pr314/prepare-registry-egress-migration.mjs \
  --live \
  --context gke_${GCP_PROJECT}_us-central1-a_example-dev \
  --allow-public-web \
  --apply
```

`--allow-public-web` is intentionally separate. It should be used only after operator approval because it grants public TCP 80/443 egress with private/internal/special ranges blocked by NetworkPolicy.

Apply mode should be run after the PR #314 CRDs are installed when any patch uses `egressClass: public-web`. Exact-host patches can be reviewed earlier, but the final migration should be validated against the post-CRD schema.

## Current built-in patch rules

- `mcp-etherscan` -> exact host `api.etherscan.io:443`.
- `evm-safe-scanner` -> explicit `egressClass: public-web`, because it supports arbitrary EVM explorer endpoints and cannot be made complete with a static exact-host list without operator-provided explorer configuration.
- `mcp-web-research` seed/DB metadata -> `wideCidr:true` with public web ports `80,443`; Control API installs this as explicit `egressClass: public-web`.
- WorkflowRecipe `web-search` transport workloads -> DuckDuckGo exact-host egress plus default engine environment:
  - `duckduckgo.com:443`
  - `html.duckduckgo.com:443`
  - `lite.duckduckgo.com:443`
  - `DEFAULT_SEARCH_ENGINE=duckduckgo`
  - `ALLOWED_SEARCH_ENGINES=duckduckgo`

The helper does not rewrite step `allowedTools` automatically. If an existing workflow still references non-search tools such as fetch/page tools, it reports the workflow under `manualReview`.
