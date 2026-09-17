# Grok subscription transport contract

Starting freeze: `grok-subscription-transport.v1`.

This is the Phase 0 architecture freeze for provider `grok-subscription`.

## Probe gate

The following facts are a starting freeze taken from Grok Build docs and
third-party probes. No live SuperGrok probe has confirmed them yet:

- the catalog origin,
- the CLI identity headers,
- the numeric limits,
- the public CLI `client_id`,
- the OAuth scope list,
- whether the upstream accepts `temperature`.

Rule: before the production flag flip, commit a redacted probe record beside
this document. Regenerate the sanitized fixture
(`tests/e2e/fixtures/grok-subscription/sanitized-upstream-contract.json`) from
that record. The freeze test must assert that the fixture matches the enforced
origin-policy constants. A recorded `GROK_REAL_UPSTREAM_CONFIRM=1` run must also
exist.

A live probe may tighten this allowlist but must never widen it. If the probe
finds a different catalog endpoint, or no list API at all, the origin may be
replaced once. After that, it cannot be widened. Until the probe record exists,
the fixture's `approvedTestAccountFingerprint` stays
`redacted:grok-subscription-pending-live-confirm`.

## Ownership

- Control API is the only OAuth custodian.
- `mcp-host` authorizes each physical attempt and streams to `grok-llm-proxy`.
- `grok-llm-proxy` redeems a single-use ticket, holds the access token in
  operation memory only, and talks to the frozen HTTPS origins below.
- The LLM stream never transits Control API or its gateways.
- Traffic never enters `codex-llm-proxy` or `https://api.x.ai`.

## Origins

Exact HTTPS origins (no caller-supplied URL):

- Device authorization: `https://auth.x.ai/oauth2/device/code`
- Token: `https://auth.x.ai/oauth2/token`
- Revoke: `https://auth.x.ai/oauth2/revoke`
- Completions: `https://cli-chat-proxy.grok.com/v1/responses`
- Catalog (starting candidate): `https://cli-chat-proxy.grok.com/v1/models`

Forbidden: `https://api.x.ai`, HTTP, loopback, link-local, metadata.

Redirects: at most one, HTTPS, same origin and same path and same query.
OAuth `device/code`, `token` and `revoke` use `redirect: 'manual'`; any 3xx is
an error.

## OAuth

- `client_id`: `b1a00492-073a-47ea-816f-4c329264a828`. This is the public
  Grok CLI registration, not a secret. `CONTROL_API_GROK_OAUTH_CLIENT_ID` may
  override it, but only to pin a documented registration.
- Grant: `urn:ietf:params:oauth:grant-type:device_code`.
- Scopes (`GROK_OAUTH_SCOPES` in
  `control-api/src/services/grokSubscriptionOAuth.ts`): `openid`, `profile`,
  `email`, `offline_access`, `grok-cli:access`, `api:access`,
  `conversations:read`, `conversations:write`.
  - This list is **pending the live probe trim**. `api:access` and
    `conversations:read/write` are broader than inference needs: a leaked
    access token could read or write Grok conversations. The probe must record
    the minimum set the CLI proxy accepts, and the list must shrink to that
    set before the production flag flip.
- The refresh token rotates on every refresh. The new ciphertext is persisted
  before any fallible post-processing.
- Revoke revokes the refresh token upstream. Access tokens that were already
  issued stay valid until they expire (at most one access-token lifetime).

## Connection lifecycle

- **Grok connection keys are terminal after revoke (migration 0113).**
  - A revoked key cannot be reconnected. Create a new connection key instead.
  - A device flow that started before the revoke cannot revive the key: it
    fails with `revoked grant cannot be reused`.
  - 0113 archives superseded revoked rows for the same key as
    `<key>~revoked~<id>`. It also cancels pending OAuth states for revoked
    keys and replaces the partial active-key index with a unique index on
    `connection_key`.
  - Archived `~revoked~` rows fall outside the key grammar. Admin list and GET
    hide them. The key's own terminal tombstone stays listed as `revoked`.
- **Attempt integrity (migration 0114).** A constraint trigger on
  `llm_provider_attempts` INSERT, and on UPDATE of `provider` or
  `connection_id`, requires a non-null `connection_id` to exist in the
  provider's own connection table:
  - `grok-subscription` → `grok_subscription_connections`
  - `codex-subscription` → `codex_subscription_connections`

  This replaces the FK that 0112 dropped, so it covers Codex too. It does not
  revalidate historic rows: the migration logs only a count of dangling rows.
- Catalog sync stores at most 256 discovered models, each with an id of at most
  128 characters. Extra entries are dropped with a structured count-only
  warning. The catalog record, row mutations and union rebuild commit in one
  transaction.

## Ticket

- `typ`: `grok-execution-ticket`
- `aud`: `grok-llm-proxy`
- Admin permit `typ`/`aud`: `grok-admin-permit` / `grok-llm-proxy-admin`

## Request identity

- `mcp-host` hashes the request with `hashCanonicalGrokRequest(raw)` from
  `@clerum/grok-provider-attempt-contract`. This function parses the request
  first and then hashes the parsed canonical value, so empty `generation: {}`,
  `tools: []` or `transportHints: {}` hash the same on the client and the
  server. Codex uses the twin `hashCanonicalCodexRequest`.
- Contract trees are capped at a nesting depth of 64 (`fail('limit')`). The
  control-api authorizer rejects deeper bodies with `invalid_request` before it
  calls `JSON.stringify`.

## Limits

Owned by `@clerum/grok-provider-attempt-contract`. Independent of Codex
`LIMITS` (`maxToolCalls` is 64, not 32).

Proxy robustness (both proxies):

- Admin catalog and connection-test upstream calls have a 15 s deadline that
  covers headers and body, and a streamed body cap: 1 MiB for Grok, 8 MiB for
  Codex. Normalized models are capped at 256, and each id at 128 characters,
  matching control-api.
- The SSE writer respects `res.write` backpressure: it waits for `drain` and
  stops waiting if the client closes.
- Queued stream-gate waiters stop when the request aborts, and the proxy
  checks the abort signal before redeeming a ticket.
- The proxy fails at startup when `GROK_LLM_PROXY_CONTROL_API_URL` or
  `GROK_LLM_PROXY_CONTROL_API_TOKEN` is empty.
- An unrecognized finalize outcome maps to `unknown`, never `success`.
  `maxStreamDurationMs` must be greater than 0.

## Identity headers

Stamped in `grok-llm-proxy`, never taken from mcp-host or the hashed request:

- `user-agent: evenfire-grok-subscription`
- `accept: text/event-stream` on stream

CLI impersonation headers (`x-xai-token-auth`, `x-grok-client-identifier`) stay
off until a recorded SuperGrok probe requires them. Do not send `OpenAI-Beta`
or `service_tier`.

`max_output_tokens` is bindable on this wire and is sent.

`temperature` is **withheld upstream** while
`GROK_UPSTREAM_TEMPERATURE_PROBE_CONFIRMED` (in
`grok-llm-proxy/src/grokTransport.ts`) is `false`. The Codex Responses wire
rejects sampling fields, and no live probe has shown that Grok accepts them.
`generation.temperature` still counts toward the authorize hash. Set the
constant to `true` only with recorded live-probe evidence.

Tool payloads send `strict: false` so optional MCP fields stay optional on the
Responses-shaped Grok wire (sibling of Codex #648). Agent tool presentation
uses the same `CODEX_TOOL_PRESENTATION` knob as Codex and defaults to `direct`
when Grok is the primary or a fallback (sibling of Codex #644).

## Terminal outcomes

For both providers, a stream counts as a completion only when it ends with
`success`. `mcp-host` reports these outcomes as errors, never as a completion:

- `canceled`,
- `error`,
- `unknown` with partial text or tool calls.

## Feature flags

All flags default to off.

| Flag | Owner | Gates |
| --- | --- | --- |
| `CONTROL_API_GROK_SUBSCRIPTION_ENABLED` | control-api ConfigMap | Admin Grok routes, Host/recipe acceptance of `grok-subscription`, and the `clerum.io/grok-enabled` annotation that control-api publishes on `clerum-llm-allowed-models`. |
| `WRC_GROK_SUBSCRIPTION_ENABLED` | workflow-recipes Deployment | Folded into the recipe verdict. Gates the `llm:grok:execute` scope, the `<recipe>-mcp-host-to-grok-proxy` egress NetworkPolicy, the bootstrap binding, the pod env, and `grantRedeemable`. |
| `GROK_LLM_PROXY_EXECUTION_ENABLED` | grok-llm-proxy ConfigMap | Kill switch: while it is off, runtime and admin requests return 404 `disabled`, even with a valid JWT, ticket or permit. |
| `MCP_HOST_GROK_SUBSCRIPTION_ENABLED` | **injected, not a manual key** | HCC injects it on Host pods whose Grok projection mints `llm:grok:execute`. WRC injects it, with `GROK_LLM_PROXY_RUNTIME_URL`, on recipe pods that declare Grok when `WRC_GROK_SUBSCRIPTION_ENABLED` is on. Do not add it to `mcp-host-config`. |

HCC has no local Grok switch. Its Grok projection follows the
`clerum.io/grok-enabled` annotation together with the Host's own Grok
references.

## Recipe grant annotations

Annotation write shapes:

- Codex: `{codex-connection-ref: k, subscription-connection-ref: k}`
- Grok: `{codex-connection-ref: '', subscription-connection-ref: k}`

The server (`control-api/src/services/recipeGrantTransition.ts`) enforces
these transitions. None of them may return a 500:

| Case | Behavior |
| --- | --- |
| Explicit alias and canonical both non-empty and unequal (any spec) | 422 `subscriptionAnnotationsDisagree` |
| Create, or static → broker | Omitted annotations: 422 (grant required). Explicit: validate, then write the broker's shape. |
| Same broker, annotations omitted | Keep the stored annotations |
| Same broker, annotations explicit | Validate the key, then write that broker's shape |
| Codex → Grok | Omitted annotations: 422 `providerChangeRequiresGrant`. Non-empty alias: 422. Otherwise validate the canonical key and write the Grok shape. |
| Grok → Codex | Omitted annotations: 422 `providerChangeRequiresGrant`. Otherwise validate (canonical-only is allowed) and write the Codex shape. Never clear silently. |
| Broker → static | Without an SDK: clear both annotations. With an SDK: keep them (the SDK route owns them). |
| Static → static | Keep the stored annotations (the SDK route owns static-recipe identity) |

## Allowlist ConfigMap republish

control-api is `replicas: 1`. After rolling out a new control-api that writes
`clerum.io/grok-*` annotations, republish `clerum-llm-allowed-models` once the
new pod is Ready. Otherwise a mutation served by the old pod could strip the
Grok annotations. A new control-api also republishes on boot.

## Rollout order

1. **evenfire-infra first.** Pin the `grok-llm-proxy` image for `gcp-dev` and
   `gcp-prod`. Provision `grok-llm-proxy-secrets`
   (`GROK_LLM_PROXY_CONTROL_API_TOKEN`) with
   `deploy/scripts/apply-inter-service-tokens.sh`. Both must be in place before
   the merge to `dev` triggers the automatic deploy.
2. **control-api** with migrations 0109–0114. Wait until every control-api pod
   runs the new image. An old control-api rejects the whole workflow-control
   token issue when the request includes the unknown `llm:grok:execute` scope
   (`invalid_workflow_control_scopes`). HCC or WRC deployed first could
   therefore break token issuance for every pod they mint for, not only Grok
   pods (C-RP-016).
3. **HCC, WRC, mcp-host and grok-llm-proxy.** Grok flags stay off.
4. Republish `clerum-llm-allowed-models` (see above).
5. Turn on the flags only after the control-api rollout is complete:
   `CONTROL_API_GROK_SUBSCRIPTION_ENABLED`, `WRC_GROK_SUBSCRIPTION_ENABLED` and
   `GROK_LLM_PROXY_EXECUTION_ENABLED`. `MCP_HOST_GROK_SUBSCRIPTION_ENABLED`
   follows automatically through HCC and WRC.

## Rollback order

1. Turn the Grok flags off. control-api republishes
   `clerum.io/grok-enabled=false`.
2. Wait for HCC and WRC to reconcile, so that no Host or recipe pod still mints
   `llm:grok:execute` and the Grok proxy NetworkPolicies are gone. Only then
   roll back control-api. An old control-api rejects the entire token issue
   for the unknown scope (C-RP-016).
3. After a control-api rollback, the old control-api writes only
   `codex-connection-ref` when a Codex recipe grant is reassigned. The stale
   `subscription-connection-ref` then disagrees with it. The new WRC reads the
   recipe as `unassigned`, and authorize returns a mismatch (B-M5b).
   - Once a control-api that writes both keys is serving again, list the Codex
     recipes whose two annotations are both non-empty and unequal.
   - Re-assign each grant with explicit annotations, which write the Codex
     shape. In the UI, re-pick the connection.
   - A save that omits the annotations keeps the stored disagreeing pair, so
     it does not repair the grant.
4. Migrations 0113 (terminal Grok keys) and 0114 (attempt connection
   integrity) are forward-only. An older control-api still runs against them:
   - The 0114 trigger only rejects connection ids that do not exist.
   - Under 0113, a revoked Grok key can no longer be reconnected by the old
     code path. That attempt fails on the unique key index instead of reviving
     the key.

## SDK bootstrap

Binding slots are strict:

- Grok writers emit `subscriptionBinding`, and Grok readers (mcp-host
  `bootstrapIdentity`, WRC provisioner and bootstrap proof parsers) read only
  `subscriptionBinding`.
- Codex writes and reads only `codexBinding`. A proof in the other slot is
  ignored.

Missing-binding reasons:

- Grok: `execution_binding_missing`
- Codex: `codex_execution_binding_missing`
