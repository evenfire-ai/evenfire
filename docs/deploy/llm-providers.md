# LLM providers, credentials, and the model allowlist (operator guide)

This guide is for cluster operators. It covers how to configure LLM provider
credentials (including the multi-slot providers **Google Vertex AI** and
**Amazon Bedrock**), how to manage the operator-declared model allowlist, and how
the per-session model selector behaves in the desktop app.

The canonical provider set — **24 providers**, from `openai`, `claude`
(Anthropic), `zai` and `bailian` through the own-SDK `vertex` / `bedrock` to the
OpenAI-compatible additions, `azure`, and the two sign-in subscription providers
(`codex-subscription`, `grok-subscription`, off by default in `deploy/base`) — and their credential slots live in the
shared `@clerum/llm-providers` package, which the Control UI, control-api,
mcp-host, and the workflow runtime all consume. See the
[providers overview](../llm-providers/README.md) for the full list and the
per-surface support matrix (`bedrock` and `azure` are host-only). A Host is bound
to **one** provider (`spec.model.provider`); the allowlist and selector operate
within that provider.

## 1. Where credentials and non-secret config live

Provider credentials are stored in the per-Host **LLM Secret** (`chatllm-api-keys`
family, labelled `clerum.io/host-secret: "true"`, referenced by the Host CRD
`spec.secretRef`). Manage it in Control UI under **Secrets → LLM**.

Some providers also need **non-secret** configuration (a GCP project, an AWS
region). Those are **not** credentials and never go in the Secret — they are
per-Host environment variables managed under **Host → Environment**
(`host-<ref>-env`, the `HostEnvTable` editor on the Host detail page). The
secrets form only shows a hint linking there; it does not duplicate the editor.

| Provider                    | Secret slots (in the LLM Secret)              | Non-secret env (Host → Environment)                            |
| --------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| OpenAI                      | `openai-api-key`                              | —                                                              |
| Anthropic (`claude`)        | `claude-api-key`                              | —                                                              |
| Z.AI (`zai`)                | `zai-api-key`                                 | —                                                              |
| Bailian                     | `bailian-api-key`                             | —                                                              |
| Google Vertex AI (`vertex`) | `vertex-service-account-json`                 | `VERTEX_PROJECT_ID` (required), `VERTEX_LOCATION`              |
| Amazon Bedrock (`bedrock`)  | `aws-access-key-id` + `aws-secret-access-key` | `AWS_REGION` (required)                                        |
| Azure OpenAI (`azure`)      | `azure-openai-api-key`                        | `AZURE_OPENAI_ENDPOINT` (required), `AZURE_OPENAI_API_VERSION` |

Every other provider (the OpenAI-compatible additions — `openrouter`, `gemini`,
`deepseek`, `groq`, `together`, `fireworks`, `mistral`, `xai`, `cerebras`,
`deepinfra`, `perplexity`, `moonshot`, `nebius`, `novita`, `minimax`) uses a single
`<id>-api-key` slot and needs no non-secret env.

The secrets form is **write-only**: existing values are never displayed (the API
returns key names only). To rotate a key, re-enter it.

## 2. Configuring Google Vertex AI

1. Create a GCP **service account** with access to the Vertex AI API and
   generate a **JSON key**.
2. In Control UI, open **Secrets → LLM** (create or edit the Host's LLM Secret),
   expand the **Google Vertex AI** group, and paste the entire service-account
   JSON into the `vertex-service-account-json` field.
   - The form validates the JSON shape before saving: it must parse and contain
     `client_email` and `private_key`. control-api enforces the same check on
     write (a malformed or incomplete JSON is rejected with `400`).
   - The driver builds GCP credentials **from the JSON in memory** — it never
     writes a key file and does not use `GOOGLE_APPLICATION_CREDENTIALS`.
3. On the Host, open **Host → Environment** and set:
   - `VERTEX_PROJECT_ID` — the GCP project id. Set it explicitly: when it is
     unset, the driver silently falls back to the service-account JSON's
     `project_id`, and fails only if both are missing.
   - `VERTEX_LOCATION` — the region, e.g. `us-central1` (optional; provider
     default applies if unset).
4. Set the Host `spec.model.provider: vertex` and pick a Vertex model from the
   allowlist (e.g. `gemini-2.5-pro`).

## 3. Configuring Amazon Bedrock

1. Create an AWS IAM principal with permission to call the Bedrock Runtime
   **Converse** API and obtain an **access key id / secret access key** pair.
2. In Control UI, open **Secrets → LLM**, expand the **Amazon Bedrock** group,
   and enter **both** `aws-access-key-id` and `aws-secret-access-key`.
   - The pair must be written **together in a single save**. Saving only one of
     the two is rejected (client-side and by control-api with `400`) so a Host is
     never left half-configured — this would otherwise surface only at runtime.
3. On the Host, open **Host → Environment** and set `AWS_REGION` (required), e.g.
   `us-east-1`.
4. Set the Host `spec.model.provider: bedrock` and pick a Bedrock model from the
   allowlist. Bedrock model ids are runtime-qualified, e.g.
   `anthropic.claude-sonnet-4-6-v1:0`.

## 3a. Configuring Azure OpenAI

1. In Control UI, open **Secrets → LLM**, expand the **Azure OpenAI** group,
   and enter `azure-openai-api-key`.
2. On the Host, open **Host → Environment** and set `AZURE_OPENAI_ENDPOINT`
   (required, must be `https://`; the driver fails closed otherwise) and optionally
   `AZURE_OPENAI_API_VERSION`.
3. Set the Host `spec.model.provider: azure`. The model name is your **Azure
   deployment name**, not a catalog id, so allowlist the deployment name.

### Bedrock and Azure in workflows

`bedrock` and `azure` are **not admissible in WorkflowRecipe steps**: they are
deliberately absent from the recipe CRD's provider enum, so a recipe pinning
either is rejected at admission. The workflow `configure` transport carries a
single credential string, which can deliver neither Bedrock's key pair nor
Azure's required endpoint. Both remain fully supported for interactive Hosts;
the other 22 providers are admissible in recipes — see the
[providers overview](../llm-providers/README.md) for the per-surface matrix and
the `clerum-model-secret-mapping` caveat.

> **Dev-mode note.** Single-service dev mode (`CLERUM_DEV_MODE=true`, no
> Kubernetes) reads credentials from env vars. If `CLERUM_MODEL_PROVIDER` is
> unset, mcp-host auto-detects the first provider whose keys are present.
> Because Bedrock's env vars are the standard `AWS_ACCESS_KEY_ID` /
> `AWS_SECRET_ACCESS_KEY`, a shell that already exports AWS credentials can
> auto-select `bedrock`; set `CLERUM_MODEL_PROVIDER` explicitly to avoid that.
> Selection needs only the two keys, but Bedrock still needs `AWS_REGION` to
> run; without it the provider fails to construct and mcp-host runs degraded. See
> [Local development](../llm-providers/README.md#46-local-development-no-kubernetes).

## 4. Extra credential slots (for provider fallback, R5)

Each provider group in the secrets form has an **Add credential slot** action.
It creates an additional key in the **same** LLM Secret with a suggested name
like `openai-api-key-fb1` (editable, validated as a Kubernetes data key). These
extra keys are how a Host's fallback policy (`spec.llmPolicy.fallbacks[]` with a
pinned `credentialSlot`) references a second credential of the same provider
(e.g. a backup Anthropic key). Because the listing enumerates the
Secret's real key names, extra slots simply appear with their own present/absent
status — there is no parallel registry to maintain.

## 5. The model allowlist

**The set of usable models is operator-declared, not a static catalog.** It lives
in the control-api Postgres table `llm_allowed_models` and is managed in Control
UI under **LLM Models** (`/llm-models`), backed by
`GET/POST/PUT/DELETE /admin/llm-models`. Every mutation is audited
(`llm_allowed_models_audit`) and re-materializes the delivery ConfigMap.

Fail-closed semantics: a model is usable only if a row exists for
`(provider, model)` with `enabled = true`. A provider with no enabled rows is
unusable and is flagged in the wizard.

**Discovery review.** `/llm-models` (Catalog) and `/llm-models/discovery`
(Discovery Review) are two tabs of the same screen. Models that disappear from
the latest live catalog stay in Catalog with a **Stale** marker and a
per-provider stale count.

**Auto-enable on insert.** A models.dev catalog sync inserts the models it has
not seen before, except two kinds it leaves for a later run: those over the
per-run caps, and every new model of a provider whose policy is ON when the run
cannot decide (see "Offline installations"). Whether an inserted row starts
**enabled** depends on:

- **The provider's catalog policy.** Direct vendors (`openai`, `claude`,
  `gemini`, `deepseek`, `mistral`, `xai`, `moonshot`, `minimax`, `zai`,
  `perplexity`) are ON by default; aggregators and clouds (`openrouter`,
  `bedrock`, `vertex`, `azure`, `together`, `fireworks`, `deepinfra`, `nebius`,
  `novita`, `groq`, `cerebras`, `bailian`) are OFF. An operator can override
  each one (`PUT /admin/llm-providers/:provider/catalog-policy` with
  `{"auto_enable": true|false}`), and reset it with `{"auto_enable": null}`, after
  which the provider follows its code default again. The policy only
  decides for models inserted **after** the change; it never enables or disables
  an existing row.
- **Eligibility.** The catalog must list text output and `tool_call: true`, the
  model must carry no `status` at all (`deprecated`, `alpha`, `beta`, or any
  value models.dev introduces later), and the id must be one the runtime can
  execute. A model that fails any rule is inserted disabled, and it stays
  disabled if it later qualifies (for example a `beta` model that reaches
  general availability): these rules only decide when the row is inserted.
  Enable such a model by hand under `/llm-models`.
- **A live, plausible run.** Only a successful fetch of models.dev can enable a
  model; see "Offline installations" below.
- **No earlier removal.** A model an operator deleted (or renamed away) comes
  back disabled.
- **Per-run caps.** One run enables at most
  `LLM_CATALOG_AUTO_ENABLE_MAX_PER_PROVIDER_PER_RUN` models per provider
  (default 100) and `LLM_CATALOG_AUTO_ENABLE_MAX_PER_RUN` in total (default
  300; both 1–1000). Within a provider the newest releases go first; the
  per-run total is handed out provider by provider in the fixed order of
  `PROVIDER_IDS` (`@clerum/llm-providers`, starting with `openai` and
  `claude`), so once it runs out the providers further down wait until the
  ones ahead have nothing left to enable. The models over a cap are not
  inserted yet; the next runs pick them up, so a large catalog (for example
  `openrouter` switched ON) completes over several runs. The sync logs a
  warning per provider while models are waiting. Do not switch that provider OFF to stop it: the
  waiting models would then be inserted disabled for good.

A model inserted by the sync also gets its catalog price (input, output and
cache rates) when models.dev lists one and the pair has no price row yet. An
existing price, even a disabled one, is never overwritten. Catalog prices are
a starting point for the operator to review, not a reviewed price: they are
stored as listed, so a model the catalog lists at $0 counts as priced at $0
(`cost` budgets treat its usage as free) rather than as unpriced.

**Boot sync.** Every replica runs one sync a few seconds after it starts. With
`LLM_CATALOG_SYNC_CRON_ENABLED=true` that sync is the cron's first tick; with the
cron off it runs on its own unless `LLM_CATALOG_BOOT_SYNC_ENABLED=false`
(default `true`; only `true`/`false` are accepted). When that boot sync could
not decide (the catalog was `vendored`, or live but implausibly small) or
failed (for example the database was briefly unreachable), the replica keeps
fetching models.dev with exponential backoff, from 30 seconds up to one hour
between attempts, and runs the sync again only once it gets a live, plausible
catalog. If another replica was already syncing at boot, there is no retry.
control-api refuses to start when `MODELS_DEV_API_URL` is not `https://` or
points at an internal host, so a misconfigured URL fails the rollout instead of
being retried.

**Offline installations.** Without egress to models.dev every run is
`vendored` (the bundled snapshot). Such a run cannot decide, so it inserts
**nothing** for providers whose policy is ON; providers whose policy is OFF still
get their models, disabled, to curate from. The boot sync's retry keeps probing
models.dev (at most once an hour after the first attempts) without reconciling
the snapshot again. Until a live run succeeds, create the
models of an ON provider by hand, or switch the provider OFF, knowing that its
models then arrive disabled and stay that way.

**Emergency brake.** If the catalog looks compromised (unexpected models being
enabled):

1. Switch the affected providers OFF in the catalog policy. New models then
   arrive disabled.
2. To stop every enablement at once, point `MODELS_DEV_API_URL` at an https
   destination that does not resolve, such as
   `https://models.dev.invalid/api.json`, and restart control-api. Every run
   becomes `vendored`, which enables nothing. Do not use an internal or `http://`
   address: control-api refuses to start with one.

Neither step undoes what is already enabled: disable or delete those rows in
`/llm-models`. Remove the override once the catalog is trusted again.

Per-model image-input capability (`image_input`) is covered in the
[providers overview](../llm-providers/README.md#image-input-capability-image_input).

### Propagation to runtime (ConfigMap)

control-api materializes the allowlist into the **`clerum-llm-allowed-models`**
ConfigMap in the `mcp-host` namespace (`<provider>` → JSON array of
`{ model, displayName?, contextWindowTokens?, vendor?, imageInput? }`). mcp-host and the workflow
runtime read it — there is no hot call from mcp-host to control-api (the
NetworkPolicy denies it by design). Changes therefore propagate **without a
redeploy**: edit the allowlist, and the wizard, the host editor, and the runtime
selector reflect it after the ConfigMap update.

- The write is best-effort after the Postgres commit, with retry, a content hash
  annotation, and re-materialization on control-api boot. If the write fails the
  operator sees a `503` (`configmap_write_failed` — "saved, propagation delayed")
  and the `clerum_llm_allowlist_configmap_write_failures_total` metric increments.
- `CLERUM_LLM_ALLOWED_MODELS_CM` is a canary knob for **mcp-host only**; do not
  re-point it independently or the read/write seam breaks.

### ConfigMap-absent / degraded semantics

If the ConfigMap does not exist yet (a rollout in progress, or the migration has
not run), mcp-host and the WRC operate in an **explicit degraded mode**: only the
model already configured on the Host/step is permitted — neither fully open nor
bricking existing Hosts. This emits a `WARN` and increments
`clerum_llm_allowlist_missing_total`. Recipe pods never read the ConfigMap; their
gate is the WRC, and for them the "absent" state is permanent by design.

An out-of-allowlist model on an **already-deployed** Host/recipe is **not**
interrupted (`WARN` + `clerum_llm_model_not_allowed_total`, marked "out of
allowlist" in the UI). Hard enforcement applies to **new** selections: host
create/edit via control-api, the runtime set-model call, and workflow `configure`.

## 6. The per-session model selector (desktop app)

Users change the agent's model per **chat session** (Claude-Code / Codex style),
restricted to the provider's allowlist:

- The change is **session state, not process state** — one Host serves many
  chats/users, so a switch never affects another user's chat.
- It applies **from the next task** ("applies to your next message"); in-flight
  tasks finish with the model they started on. `usage_events` records the model
  actually served, so cost attribution is exact.
- The selection survives a pod restart (persisted on the session). If a persisted
  model later falls out of the allowlist, the agent falls back to the Host default
  with a notice in the UI.
- The context-window indicator reflects the active model's window (the
  operator-declared `context_window_tokens`, falling back to
  `CLERUM_CONTEXT_MAX_TOKENS`).
- The set-model endpoint requires the `host:model:write` scope; without it the
  call returns **403**. Hosts too old to project a model simply don't render the
  selector.

## 7. Quick verification

1. Create/enable a Vertex and a Bedrock model under **LLM Models**.
2. Create an LLM Secret: paste a Vertex service-account JSON (confirm a malformed
   JSON is rejected) and enter a Bedrock key pair (confirm a single key is
   rejected).
3. Set `VERTEX_PROJECT_ID` / `AWS_REGION` under **Host → Environment**.
4. Create a Host with `provider: vertex` (or `bedrock`), run a chat with a
   tool-call, and confirm the calls appear in `usage_events`.
5. Disable a model in **LLM Models** and confirm the wizard and the runtime
   selector stop offering it without a redeploy.
