# Control UI LLM Management Analysis

## Scope and constraints

- Target workspace: `control-ui`.
- Backend must remain unchanged.
- New UI behavior must work against existing `control-api` routes.

## Current frontend architecture (before changes)

## Main state owner

- `control-ui/app/page.tsx` is the main dashboard container.
- It loads core resources in `loadAll()`:
  - `/api/v1/admin/hosts`
  - `/api/v1/admin/contexts`
  - `/api/v1/admin/mcp-servers`
  - `/api/v1/admin/communication-channels`
  - `/api/v1/admin/secrets`
- Tab rendering is centralized in this file and driven by `tab` query params.

## Host creation flow

- `control-ui/components/HostWizard.tsx` handles Create Agent.
- It already supports:
  - creating/reusing contexts
  - creating/reusing channels
  - creating/reusing host secrets via `/api/v1/admin/secrets`
  - creating host CRD via `/api/v1/admin/hosts`
- Before implementation, provider options were limited to `openai` and `claude`, and model was free-text.

## Host edit flow

- `control-ui/app/hosts/[name]/page.tsx` handles host details + edits.
- It supports editing:
  - host name/display
  - contextRef
  - `spec.model.provider` and `spec.model.name`
  - `secretRef`
- Before implementation, provider options were `openai`/`claude` only.

## Backend API contract relevant to LLM secrets

From `control-api/src/routes/admin/secrets.ts`:

- `GET /api/v1/admin/secrets`
  - forced namespace: `CONTROL_API_SECRETS_NAMESPACE` (default `mcp-host`)
  - returns filtered names only (host-secret label match)
  - rejects `namespace` query override
- `POST /api/v1/admin/secrets`
  - creates secret using provided payload, namespace forced by backend config
- `PUT /api/v1/admin/secrets`
  - updates (replace) secret via `updateSecret`
- `DELETE /api/v1/admin/secrets/:name`
  - deletes secret in fixed secrets namespace

From `control-api/src/services/secretService.ts`:

- `updateSecret` uses `replaceNamespacedSecret` with provided `data/stringData`.
- If fields are omitted in update payload, they are not preserved automatically in request body.

## Critical caveats from backend behavior

- Secret values are write-only from Control UI:
  - list endpoint returns names only, not secret payloads.
- Update is effectively a replace operation:
  - UI cannot fetch existing keys/values to prefill.
  - operators must re-enter all key entries they want retained.
- Namespace for these secrets is backend-controlled and cannot be changed from UI.

## LLM provider/model ecosystem signals in repo

- Host runtime supports provider strings including at least `openai`, `claude`, `zai` (and backend services also include `bailian` in broader system types).
- Current control-ui model menu is intentionally curated to:
  - OpenAI: `gpt-5.4-mini`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`
  - Anthropic (`claude` provider value): `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`
  - Z.AI: `glm-4.7`, `glm-5.1`, `glm-5`, `glm-5-turbo`

## Design implications for frontend-only implementation

- Add Z.AI provider support in both create and edit flows.
- Keep model input flexible (backend accepts arbitrary values), but provide curated dropdown presets for operator guidance.
- Add dedicated sidebar section for LLM secrets using existing secrets endpoints.
- In UI copy, explicitly communicate:
  - names-only visibility
  - update replace semantics
