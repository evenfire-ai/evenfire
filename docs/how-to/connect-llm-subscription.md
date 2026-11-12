# How to: use a ChatGPT (Codex) or Grok subscription instead of an API key

evenfire has two LLM providers that sign in with a subscription account rather
than an API key:

| Provider id          | Control UI label        | Sign-in                 |
| -------------------- | ----------------------- | ----------------------- |
| `codex-subscription` | "ChatGPT Subscription"  | ChatGPT account (Codex) |
| `grok-subscription`  | "xAI Grok Subscription" | xAI account (SuperGrok) |

An admin signs in once from Control UI. Agents (Hosts) and workflow recipes
then pick that sign-in, and the account's subscription entitlement pays for the
calls instead of metered API billing. Both providers are **off in
`deploy/base`** and switched on in the minikube overlay.

This page covers the operator workflow. For the wire format, limits and error
taxonomy, see the [Codex transport contract](../architecture/codex-subscription-transport-contract.md)
and the [Grok transport contract](../architecture/grok-subscription-transport-contract.md).

## How it works

1. **control-api holds the credential.** The OAuth tokens are stored
   encrypted in control-api's database. There is no Kubernetes Secret and no
   `secretRef` slot for these providers.
2. **A Host or recipe names a connection.** Each sign-in is a named
   _connection_ (also called a _grant_). A Host picks one with
   `spec.model.connectionRef`.
3. **Traffic goes through a broker in `control-plane`.** For every model call,
   `mcp-host` asks control-api to authorize the attempt and gets a single-use
   ticket. It then streams to `codex-llm-proxy` or `grok-llm-proxy`, which
   redeems the ticket, holds the access token only for that operation, and
   calls the vendor's subscription endpoint. The model stream never passes
   through control-api.
4. **Models come from the account.** Each connection has its own model
   catalog, read from the vendor at sign-in. There is no built-in default
   model, and nothing falls back to an API key.

## Enable on your cluster

Every switch below defaults to off. Set them in this order: proxies and
control-api first, then the Host and recipe switches.

| Key                                      | Where it lives                                                   | Codex    | Grok                      |
| ---------------------------------------- | ---------------------------------------------------------------- | -------- | ------------------------- |
| `CONTROL_API_CODEX_SUBSCRIPTION_ENABLED` | ConfigMap `control-api-config` (ns `control-plane`)              | `"true"` | —                         |
| `CONTROL_API_GROK_SUBSCRIPTION_ENABLED`  | ConfigMap `control-api-config` (ns `control-plane`)              | —        | `"true"`                  |
| `CODEX_LLM_PROXY_EXECUTION_ENABLED`      | ConfigMap `codex-llm-proxy-config` (ns `control-plane`)          | `"true"` | —                         |
| `GROK_LLM_PROXY_EXECUTION_ENABLED`       | ConfigMap `grok-llm-proxy-config` (ns `control-plane`)           | —        | `"true"`                  |
| `MCP_HOST_CODEX_SUBSCRIPTION_ENABLED`    | ConfigMap `mcp-host-config` (ns `mcp-host`)                      | `"true"` | —                         |
| `WRC_GROK_SUBSCRIPTION_ENABLED`          | `env` on the `workflow-recipes` Deployment (not a ConfigMap key) | —        | `"true"` for Grok recipes |
| `MCP_HOST_GROK_SUBSCRIPTION_ENABLED`     | **Do not set.** HCC injects it per Host                          | —        | automatic                 |

Notes:

- The control-api, proxy and mcp-host flags accept only the exact string
  `true`; `WRC_GROK_SUBSCRIPTION_ENABLED` also accepts `1` and any case of
  `true`. Any other value keeps the feature off.
- `deploy/base` does not ship an `mcp-host-config` ConfigMap. The Host
  controller (HCC) loads it into every Host's `mcp-host` container with
  `envFrom`, so your overlay must provide it. The minikube overlay does
  (`deploy/overlays/minikube/configmaps/mcp-host-config.yaml`).
- `MCP_HOST_GROK_SUBSCRIPTION_ENABLED` is added by HCC only to Hosts that are
  actually configured for Grok, once control-api has Grok on. Do not put it in
  `mcp-host-config`.
- Each proxy needs its inter-service token in `codex-llm-proxy-secrets` or
  `grok-llm-proxy-secrets`. `deploy/scripts/apply-inter-service-tokens.sh`
  creates both.
- Optional: `SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED` in `control-api-config`
  turns on periodic catalog refresh (see [Models and catalog sync](#models-and-catalog-sync)).
- The minikube overlay sets every row except `MCP_HOST_GROK_SUBSCRIPTION_ENABLED`
  (which HCC injects) under `deploy/overlays/minikube/` (`configmaps/*` and
  `patches/workflow-recipes-grok.yaml`).

Restart the affected Deployments after you change a ConfigMap. For upgrade
order on a live cluster, see the Grok contract's
[Rollout order](../architecture/grok-subscription-transport-contract.md#rollout-order).

To check what control-api thinks is on, call
`GET /api/v1/admin/llm/providers/capabilities`. It returns
`{ "providers": { "codex-subscription": { "enabled": … }, "grok-subscription": { "enabled": … } } }`.

## Connect a subscription

1. In Control UI, open **Secrets → LLM Subscriptions**
   (`/secrets/llm/subscriptions`).
2. Create a subscription. Pick the **Provider** (ChatGPT or Grok; only
   enabled providers are offered) and give it a **Name** of up to 64
   characters. Agents see this name when they pick a subscription.
3. Click **Sign in with ChatGPT** or **Sign in with Grok**. Control UI opens
   the vendor's verification page in a new tab and shows a one-time code.
   Sign in there with the subscription account and enter the code.
4. When the sign-in completes, control-api reads the account's model catalog.
   You see "Connected — catalog synced".
5. Under **Enabled models**, turn models on or off. Under **Primary model**,
   choose the default model. It must be one of the enabled models.

For Grok, the sign-in panel shows a notice about how evenfire authenticates to
xAI. Read it before you connect.

### Device code vs browser sign-in

Control UI always uses the **device-code** flow for both providers. It works
with the public CLI client ids that control-api ships as defaults.

control-api also has a **browser OAuth** flow for Codex only
(`POST /api/v1/admin/llm/providers/codex-subscription/connections/:key/browser/start`).
Control UI does not call it. It is refused with `browser_oauth_unregistered`
unless `CONTROL_API_CODEX_OAUTH_CLIENT_ID` is set to an OpenAI client that you
registered for this callback URL:

```text
<control-ui origin>/control-api/api/v1/auth/codex-subscription/callback
```

The origin comes from `CONTROL_API_CONTROL_UI_BASE_URL`. Grok has no browser
flow.

### Multiple named connections

You can create as many connections as you need, for example one per team
account. Each one has its own tokens, catalog and enabled models.

- Keys are generated as `codex-<hex>` or `grok-<hex>`. Through the API you
  can supply your own key instead: lowercase letters, digits and `-`, up to
  63 characters.
- One vendor account can back only one live connection per provider. A second
  sign-in with the same account fails with `fingerprint_in_use`.
- `unassigned` is reserved for both providers.

### The `deployment-default` connection

`deployment-default` is a reserved Codex key from the original single-grant
design. The un-keyed Codex admin routes (for example
`GET …/codex-subscription/connection`) act on it. If it exists, a Host uses it
only when its `connectionRef` names it explicitly. An empty `connectionRef` is
never treated as `deployment-default`.

Grok does not accept `deployment-default` at all. Every Grok connection uses
a named key.

## Assign a subscription to an agent

### In Control UI

1. Open the agent, then the **Models & creds** tab (`/agents/<name>/model`).
2. Edit the model configuration and choose provider **ChatGPT Subscription**
   or **xAI Grok Subscription**. The new-agent wizard offers the same options.
3. In **Credential**, choose one of the subscriptions created under Secrets.
   Agents only choose a subscription. Creating one happens under Secrets.
4. Pick a model from that connection's enabled models and save.

Saving without a subscription fails with "Choose a ChatGPT subscription
before saving." (or the Grok version).

### In the Host CRD

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
  namespace: mcp-host
spec:
  host: chatLLM
  contextRef: context1
  model:
    provider: codex-subscription # or grok-subscription
    name: <a model enabled on this connection>
    connectionRef: codex-0123456789abcdef
```

The CRD enforces these rules:

- `spec.secretRef` may be omitted only when the primary and every
  `llmPolicy.fallbacks[]` entry use the same subscription provider. With an
  API-key fallback you still need `secretRef`.
- `credentialSlot` is not allowed on a subscription fallback.
- A Host may use at most one subscription provider across `model`,
  `llmPolicy.fallbacks` and `allowedModels`. You cannot mix Codex and Grok.

See [Host CRD](../crds/host.md) for the full schema.

### What "unassigned" means

A subscription Host with no `connectionRef` is **unassigned**. It is never
given the execute permission, so it makes no model calls. It does not fall
back to `deployment-default` or to an API key. Model calls fail with
`unassigned_connection` ("Host has no coding-plan subscription assigned").

### Admin API

The admin API can also list Hosts and assign them without the agent page.
Every route is under `/api/v1/admin/llm/providers/<provider-id>/`:

| Route                                         | Purpose                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| `GET connections`                             | Connections with their assigned Hosts, plus `assignableHosts`   |
| `GET assignable-hosts`                        | Every Host with its provider, model and current `connectionRef` |
| `POST connections/:key/hosts/:hostRef/bind`   | Point a Host at this connection and seed a model                |
| `POST connections/:key/hosts/:hostRef/unbind` | Set the Host back to `unassigned`                               |

## Models and catalog sync

A connection's catalog is read at sign-in and **is not refreshed on its own**.
A model the vendor publishes later does not appear until you sync:

- In Control UI, open the subscription and click **Sync catalog**.
- Or call `POST /api/v1/admin/llm/providers/<provider-id>/connections/:key/catalog/sync`.
- `GET …/connections/:key/models` lists the catalog, and
  `PATCH …/connections/:key/models/:model` with `{ "enabled": true|false }`
  turns one model on or off.

For periodic sync, set `SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED: "true"` in
`control-api-config`. The interval is `SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS`:
6 hours by default, and control-api refuses to start below 15 minutes. It is
off by default on purpose. Each tick calls the vendor once per connection,
and a Grok token refresh during a tick rotates the refresh token.

## Use a subscription in a workflow recipe

Both providers are valid for `spec.agent.provider` and step agents in a
`WorkflowRecipe`, with these rules:

- A recipe may use at most one subscription provider.
- `spec.agent.secretRef` is not allowed for a subscription provider.
- The recipe picks a connection with an annotation, not a spec field. In the
  recipe editor's confirm step, choose a **ChatGPT grant** or **Grok grant**.
  Codex recipes store it in `clerum.io/codex-connection-ref` and
  `clerum.io/subscription-connection-ref`. Grok recipes store it in
  `clerum.io/subscription-connection-ref` only.
- Grok recipes also need `WRC_GROK_SUBSCRIPTION_ENABLED=true` on
  `workflow-recipes`. That switch controls the recipe's Grok permission,
  egress policy and pod environment.

## Refresh, reconnect and revoke

- **Access-token refresh is automatic.** control-api refreshes the access
  token when it authorizes a call. `POST …/connections/:key/refresh` forces
  a refresh.
- **Reconnect.** If the vendor rejects the saved refresh token, the
  connection moves to `reauth_required` and Control UI shows
  **Reconnect ChatGPT** / **Reconnect Grok**. This runs the same device-code
  sign-in.
- **Delete (revoke).** **Delete** in the subscription list revokes the
  connection. control-api marks it revoked, cancels pending sign-ins, and asks
  the vendor to revoke the refresh token. Agents assigned to it keep the reference but can no longer
  authorize. Reassign them to another subscription.
- **Grok revoke is permanent per key.** A revoked Grok key cannot be
  reconnected. Create a new subscription instead. Access tokens issued
  before the revoke stay valid until they expire.

## Limits to know

- **Output ceiling on Codex SDK grants.** A Plugin Workload SDK grant's
  per-grant output ceiling (`maxOutputTokens`) becomes `max_tokens` on API-key
  providers. The ChatGPT subscription endpoint cannot take that field, so for
  `codex-subscription` only the transport contract's fixed limit applies.
- **Image input.** Both providers accept PNG and JPEG image parts. The Grok
  image limits are based on xAI's public API documentation. They have not been
  measured against the Grok subscription endpoint. See
  [Visual requests](../architecture/grok-subscription-transport-contract.md#visual-requests-issue-784).
- **One subscription provider per Host or recipe** (see above).
- **Requests are capped.** Message, tool and body-size caps are listed under
  _Limits_ in each transport contract.

## Troubleshooting

| Symptom / error                                                                        | Cause                                                                | Fix                                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No **LLM Subscriptions** content, or API `404 {"error":"disabled"}`                    | `CONTROL_API_*_SUBSCRIPTION_ENABLED` is not `true`                   | Set the flag in `control-api-config` and restart control-api                              |
| Calls fail although sign-in worked; proxy answers `404 disabled`                       | `*_LLM_PROXY_EXECUTION_ENABLED` is off                               | Set it in the proxy's ConfigMap and restart the proxy                                     |
| Codex Host cannot build its provider                                                   | `MCP_HOST_CODEX_SUBSCRIPTION_ENABLED` missing from `mcp-host-config` | Add it, then let HCC roll the Host                                                        |
| Grok recipe is refused or cannot reach the proxy                                       | `WRC_GROK_SUBSCRIPTION_ENABLED` is off                               | Set it on the `workflow-recipes` Deployment                                               |
| `browser_oauth_unregistered`                                                           | Browser OAuth with the default public client                         | Use device code, or register an OpenAI client and set `CONTROL_API_CODEX_OAUTH_CLIENT_ID` |
| "… sign-in expired / denied / timed out"                                               | Device code was not confirmed in time                                | Click **Sign in** again                                                                   |
| `fingerprint_in_use`                                                                   | That account already backs a live connection                         | Use the existing connection                                                               |
| `connection_key_taken`                                                                 | Key already exists (for Grok, possibly a revoked key)                | Choose another key                                                                        |
| `reauth_required` / "Reconnect" shown                                                  | Vendor rejected the refresh token                                    | Click **Reconnect**, then **Sync catalog**                                                |
| New vendor model missing                                                               | Catalog is only read at sign-in                                      | **Sync catalog**, or enable the cron                                                      |
| `default_model_not_offered`                                                            | Default model is not an enabled model on that connection             | Enable the model first                                                                    |
| `unassigned_connection`                                                                | Host has no `connectionRef`                                          | Assign a subscription on **Models & creds**                                               |
| `spec.secretRef is required unless every LLM target is the same oauth-broker provider` | Mixed subscription + API-key chain without a Secret                  | Add `secretRef` for the API-key targets                                                   |
| `a Host may declare at most one oauth-broker provider`                                 | Codex and Grok on one Host                                           | Use one subscription provider per Host                                                    |
| `hosts_unavailable` (503)                                                              | control-api cannot read Host objects                                 | Check control-api's Kubernetes access                                                     |

## Related

- [LLM providers](../llm-providers/README.md) (Group D: subscription sign-in)
- [Codex subscription transport contract](../architecture/codex-subscription-transport-contract.md)
- [Grok subscription transport contract](../architecture/grok-subscription-transport-contract.md)
- [Grok subscription validation](../testing/grok-subscription-validation.md)
- [Host CRD](../crds/host.md)
- [Control UI](../surfaces/control-ui.md)
- [Track usage and set token budgets](token-budgets-and-usage.md)
