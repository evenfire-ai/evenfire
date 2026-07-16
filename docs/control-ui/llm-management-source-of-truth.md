# Control UI LLM Management Source of Truth

This document records the frontend-only implementation for:

- Z.AI provider support in agent setup/edit flows
- New `LLM Secrets` sidebar section for secret lifecycle operations

No backend code was modified.

## Files changed

## New shared LLM config

- `control-ui/lib/llm.ts`
  - Defines supported providers for control-ui host forms:
    - `openai`
    - `claude`
    - `zai`
  - Defines provider labels and model presets (newest first; legacy entries kept available):
    - OpenAI: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`
    - Anthropic (`claude` provider value): `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-6`, `claude-sonnet-4-5`
    - Z.AI: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`
  - Defines wizard pre-select / fallback default per provider (`LLM_DEFAULT_MODEL_BY_PROVIDER`); kept separate from the dropdown order so the wizard lands on the cost-effective tier (matches each provider's `defaultModel` in `mcp-host` `src/llm/registryCore.ts` `PROVIDERS`):
    - OpenAI: `gpt-5.4-mini`
    - Anthropic: `claude-sonnet-4-6`
    - Z.AI: `glm-5.1`
  - Defines LLM secret key fields used in UI forms:
    - `openai-api-key`
    - `claude-api-key`
    - `zai-api-key`
  - Helper utilities:
    - `normalizeProvider()`
    - `getModelOptions()`
    - `getDefaultModel()`

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
