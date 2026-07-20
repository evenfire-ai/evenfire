# Control UI LLM Management Source of Truth

## Source of truth for models (spec §3-R3, allowlist)

**The list of usable models is the operator-declared allowlist, not a static
catalog.** It lives in the control-api Postgres table `llm_allowed_models` and is
served by the admin API `GET/POST/PUT/DELETE /admin/llm-models`. A mutation also
materializes the `clerum-llm-allowed-models` ConfigMap that mcp-host and the WRC
read at runtime.

Fail-closed semantics: a model is usable only if a row exists for
`(provider, model)` and `enabled = true`. Disabled/absent rows are not
selectable in new host creation, host editing, or the runtime picker.

The former static `LLM_MODELS_BY_PROVIDER` map in `control-ui/lib/llm.ts` has
been **removed**. `lib/llm.ts` now keeps only provider-level metadata; every
model picker loads the allowlist and passes the rows to the catalog helpers.

### Data flow in control-ui

- `lib/api.ts` — typed wrappers `getLlmModels`, `getLlmModel`, `createLlmModel`,
  `updateLlmModel`, `deleteLlmModel` (+ types `LlmAllowedModel`,
  `CreateLlmModelInput`, `UpdateLlmModelInput`) and `isLlmModelConfigMapDeferred`
  (detects the 503 `configmap_write_failed` — the row was saved, only the
  ConfigMap propagation is delayed; surfaced as an info toast, not a failure).
- `lib/hooks/useLlmAllowedModels.ts` — loads the allowlist once and exposes
  `{ models, loading, error, reload }`. On error the caller shows an
  error/empty picker; there is **no** hardcoded fallback list (spec R4.5.1).
- `lib/llm.ts` catalog helpers (all take the allowlist rows as an argument):
  - `getModelOptions(catalog, provider, { includeDisabled? })` — model names for
    a provider (enabled only by default).
  - `getAllModelOptions(catalog, { includeDisabled? })` — de-duplicated model
    names across all providers (budget-scope suggestions).
  - `resolveDefaultModel(provider, enabledModels)` — the static
    `LLM_DEFAULT_MODEL_BY_PROVIDER` default when enabled, else the first enabled
    model, else `''`.
  - `inferProviderFromModels(models, catalog)` — recovers the provider for a
    legacy grant that stored model names but no explicit provider.

### Admin page

- `control-ui/app/llm-models/` (`page.tsx` + `new/page.tsx` +
  `[id]/edit/page.tsx`) — App Router list / create / edit, mirroring
  `app/cost/llm-prices/`. Columns: provider, model, vendor, display name,
  context window, enabled; provider filter + search; disabled badge. Rows for
  enabled models that have no enabled price render a "No price" chip linking to
  `/cost/llm-prices` (cross-check against `getUnpricedModels`, spec R3.3).
  A 503 `configmap_write_failed` is treated as "saved, propagation delayed".
- `components/LlmModelTable.tsx` / `components/LlmModelForm/` — table and form.
- Sidebar entry `llm-models` ("LLM Models", `IconModels`) registered in
  `components/Sidebar/constants.tsx` + `types.ts`, with the route→tab mapping in
  `components/DashboardLayout.tsx`.

## Provider metadata source: the shared `@clerum/llm-providers` package (spec §3-R4)

The canonical provider set, their display labels, credential slots, and
non-secret env vars now live in the shared **`@clerum/llm-providers`** package
(`packages/llm-providers/`), consumed by control-ui, control-api, mcp-host, and
the WRC. `lib/llm.ts` derives its provider-level UI metadata from that package
instead of re-declaring the enum — this is the single source of truth referenced
by spec R4.5.1 ("the slot list always comes from the package; never a hardcoded
field list in the UI").

Exports the package provides:

- `PROVIDER_IDS` / `LlmProviderId` — the canonical 6 provider ids
  (`openai`, `claude`, `zai`, `bailian`, `vertex`, `bedrock`).
- `PROVIDER_CREDENTIAL_SLOTS` — the credential slots each provider loads from the
  LLM Secret (single key for the 4 originals; the `aws-access-key-id` /
  `aws-secret-access-key` pair for Bedrock; the `vertex-service-account-json`
  slot for Vertex), each mapped to its shell env name.
- `PROVIDER_DISPLAY_LABELS` — the brand label per provider.
- `PROVIDER_NON_SECRET_ENV` — the non-secret per-Host env vars a provider needs
  (`VERTEX_PROJECT_ID`/`VERTEX_LOCATION`, `AWS_REGION`), which flow via
  `host-<ref>-env`, **not** the Secret.
- `isLlmProviderId` — a prototype-safe own-property guard.

### Provider metadata that stays local to `lib/llm.ts`

- `LlmProvider` union + `LLM_PROVIDER_OPTIONS` (labels) — derived from the package.
- `LLM_CREDENTIAL_GROUPS` — the grouped structure the multi-slot secrets form
  renders (one group per provider, derived from `PROVIDER_CREDENTIAL_SLOTS` +
  UI-only label/placeholder hints; the Vertex slot is flagged `multiline`). This
  **replaces** the former flat `LLM_SECRET_FIELDS` (removed in B3).
- `getLlmGroupCompleteness(group, isPresent)` — powers the "provider usable" chip
  (all `required` slots present, spec R4.5.5).
- `validateLlmSecretData(draft)` — slot-aware validation shared with the
  server-side gate in control-api's secrets route (spec R4.5.3): the Bedrock pair
  must be written together; the Vertex JSON must parse with `client_email` +
  `private_key`. The `BEDROCK_CREDENTIAL_KEYS` set it uses is derived from the
  package, not hardcoded.
- `LLM_DEFAULT_MODEL_BY_PROVIDER` — wizard pre-select default per provider (a
  provider-level mirror of each provider's `defaultModel` in
  `mcp-host/src/llm/registryCore.ts`; includes `vertex: gemini-2.5-pro` and
  `bedrock: anthropic.claude-sonnet-4-6-v1:0`, aligned with the registry and the
  control-api migration `0052` seed rows). Consumed only via `resolveDefaultModel`,
  which falls back to the first enabled allowlist model when this default is not
  enabled.
- Helpers `normalizeProvider`, `isKnownProvider`, `getProviderLabel`,
  `getProviderDisplayLabel`.

### Multi-slot secrets form (spec R4.5)

`components/LlmCredentialFields/` renders the grouped credential form from
`LLM_CREDENTIAL_GROUPS`, reused by the create-secret page
(`app/secrets/new/page.tsx`), the update-secret modal (`components/SecretsTable.tsx`),
and the HostWizard credential step. Each provider is a group with a completeness
chip; single-key providers show one password field; Bedrock shows its pair;
Vertex shows a JSON textarea. Non-secret env vars appear only as a hint linking
to **Host → Environment** (`HostEnvTable`) — the form never duplicates that
editor. An "Add credential slot" action creates an extra key in the same Secret
(suggested `<provider>-api-key-fb1`, validated as a data key) for the R5 fallback
credentials. The write-only pattern is intact: existing values are never
re-rendered (the listing returns names only).

## Consumers migrated off the static catalog

`HostWizard`, host edit page (`app/hosts/[name]/page.tsx`), `LlmPriceForm`
(suggestions, includes disabled), `TokenBudgetForm` (`getAllModelOptions`),
the SDK grant picker (`app/plugin-workload-sdk/page.tsx` +
`lib/pluginWorkloadSdkModels.ts`) all load the allowlist via
`useLlmAllowedModels`. The host edit page keeps a host's saved model selectable
even if it fell out of the allowlist (preexisting resources are not
interrupted — spec R3.7), marking it "(out of allowlist)".

---

## Historical notes (pre-allowlist)

The sections below record the earlier frontend-only work (Z.AI provider support
and the `LLM Secrets` section) and predate the allowlist. `LLM_MODELS_BY_PROVIDER`
and `getDefaultModel`/`getModelOptions` as described there no longer exist in
their original static form.

## Host creation (wizard)

- `control-ui/components/HostWizard.tsx`
  - Added Z.AI API key input in new-secret step.
  - Secret validation now accepts any of:
    - OpenAI key
    - Claude key
    - Z.AI key
  - Secret creation payload now includes `zai-api-key` when provided.
  - Provider selector now includes Z.AI.
  - Model selection is now provider-aware:
    - dropdown of presets per provider
    - model input is restricted to curated dropdown values

## Host details editing

- `control-ui/app/hosts/[name]/page.tsx`
  - Provider state normalized with shared helper.
  - Provider selector includes Z.AI.
  - Model selection now offers provider-specific presets.
  - Model input is restricted to curated dropdown values.
  - `secretRef` now supports dropdown selection from `/api/v1/admin/secrets`.
  - Manual custom `secretRef` override remains available.
  - Provider is displayed as `Anthropic` in UI while preserving `claude` provider value in payloads.
  - Save payload still sends `spec.model.provider` + `spec.model.name` to backend unchanged.

## New LLM Secrets section

- `control-ui/components/LlmSecretsTable.tsx` (new)
  - Displays current LLM secret names from `/api/v1/admin/secrets`.
  - Supports:
    - create (`POST /api/v1/admin/secrets`)
    - update (`PUT /api/v1/admin/secrets`)
    - delete (`DELETE /api/v1/admin/secrets/:name`)
  - Create flow enforces host-secret label:
    - `clerum.io/host-secret: "true"`
  - UI warnings explain backend constraints:
    - names only are visible
    - update replaces secret data with submitted keys

## Navigation wiring

- `control-ui/components/Sidebar.tsx`
  - Added `llm-secrets` tab and icon.
- `control-ui/components/DashboardLayout.tsx`
  - Added `llm-secrets` query-tab support.
- `control-ui/app/page.tsx`
  - Added `llm-secrets` tab handling and rendering with `LlmSecretsTable`.

## Documentation update

- `control-ui/README.md`
  - Added `LLM Secrets` tab and updated host wizard/provider description.

## Operational behavior and caveats

- Secret values are intentionally not readable from Control UI (backend returns names only).
- Updating a secret requires re-entering all keys that must remain in the final secret payload.
- Namespace for these secret operations is backend-controlled (`CONTROL_API_SECRETS_NAMESPACE`).
- Model dropdowns are convenience presets only; custom model values are still allowed and forwarded.

## Suggested manual verification

1. Open Control UI and switch to `LLM Secrets`.
2. Create a secret with only `zai-api-key`.
3. Use Create Agent wizard:
   - choose provider `Z.AI`
   - select model `glm-5-turbo` (or custom override)
   - reference the created secret
4. Open created agent details:
   - verify provider/model persist
   - switch provider/model and save
5. Update the secret from `LLM Secrets` and confirm backend accepts update.
