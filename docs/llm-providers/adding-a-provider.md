# Adding an LLM provider

This guide explains how to add a new LLM provider to Clerum. There are two paths:

- **Data-only (OpenAI-compatible)** — the provider exposes an OpenAI-compatible
  `/chat/completions` endpoint reachable with a base URL + `Authorization: Bearer`
  API key. **No driver code.** Most of the industry (Groq, DeepSeek, Mistral, xAI,
  Together, Fireworks, OpenRouter, Perplexity, Moonshot, Cerebras, DeepInfra,
  Nebius, Novita, Google Gemini via its compat endpoint, …) falls here.
- **Driver-based** — a bespoke wire protocol (Anthropic, Vertex, Bedrock) or
  non-vanilla auth/host (Azure OpenAI: per-resource host + `api-key` header +
  deployment-name-as-model). Needs a `makeProvider` arm and possibly an SDK.

## The single source of truth

The canonical provider set lives in **`packages/llm-providers`** (`index.cjs` +
`index.d.ts`). It is a DATA-ONLY leaf consumed by mcp-host, control-api, WRC, HCC
and control-ui — so the provider id, its credential slots, its display label and
its non-secret env are defined **once** here and everyone inherits them. Never
reintroduce a hardcoded provider list anywhere else.

Runtime-only fields (base URL, default model, tokenizer, how to build the client)
stay local to **`mcp-host/src/llm/registryCore.ts`** (`RUNTIME_FIELDS`) and
**`mcp-host/src/llm/registry.ts`** (`makeProvider`).

---

## Path A — OpenAI-compatible provider (data-only)

Example: adding `groq`.

### 1. Shared package — `packages/llm-providers/`
- `index.cjs`: add the id to `PROVIDER_IDS`, a credential slot to
  `PROVIDER_CREDENTIAL_SLOTS` (use the `apiKeySlot('<id>-api-key', '<ID>_API_KEY')`
  helper), a brand label to `PROVIDER_DISPLAY_LABELS`, and an **empty**
  `PROVIDER_NON_SECRET_ENV` entry (fixed base URL → no per-Host config).
- `index.d.ts`: append the id to the `PROVIDER_IDS` readonly tuple (the
  `LlmProviderId` union derives from it).

### 2. mcp-host runtime row — `registryCore.ts` `RUNTIME_FIELDS`
Add `{ baseURL, defaultModel, tokenizer: 'fallback' }`. The data-driven arm in
`makeProvider` picks up anything carrying a `baseURL` — **no driver needed**.
- `baseURL` must be exact so `${baseURL}/chat/completions` resolves. Watch the
  path: some include `/v1` (`https://api.mistral.ai/v1`), some don't
  (`https://api.perplexity.ai`), Fireworks needs an id prefix, DeepInfra is
  `/v1/openai`. See the gotchas table below.
- `tokenizer: 'fallback'` for non-OpenAI models (`'openai'` only for GPT-family).

### 3. CRD enums — `charts/clerum-crds/crds/`
- `host.yaml`: add the id to the `spec.model.provider` enum **and** the
  `spec.llmPolicy.fallbacks[].provider` enum.
- `workflowrecipe.yaml`: add it to both provider enums **iff** the provider is
  single-credential with no required non-secret env (all OpenAI-compatible
  api-key providers qualify). These enums are additive — old resources stay valid.

### 4. Allowlist seed — control-api migration (`control-api/src/db.ts`)
Append a new migration (next `NNNN_…` version, append-only + idempotent) that
`INSERT … ON CONFLICT DO NOTHING`s one sensible default `(provider, model, vendor)`
into `llm_allowed_models`. Operators curate the rest from `/llm-models`.

### 5. control-ui — `control-ui/lib/llm.ts`
Add the provider's default model to `LLM_DEFAULT_MODEL_BY_PROVIDER` (a
`Record<LlmProvider, …>`, so it **must** be exhaustive — tsc enforces it). The
provider dropdown (`LLM_PROVIDER_OPTIONS`), the multi-slot secrets form
(`LLM_CREDENTIAL_GROUPS`) and the field label all **auto-derive** from the
package — no other UI change. A nicer `SECRET_FIELD_HINTS` placeholder is optional.

### 6. Param compatibility (important)
The OpenAI-compatible driver (`mcp-host/src/llm/openaiCompatible.ts`) shares the
`openai` provider's request shape. Some providers **reject** params: Groq
(`n>1`, `logprobs`, `logit_bias`), Cerebras (`frequency_penalty`/`presence_penalty`),
Moonshot (`tool_choice: 'required'`, temperature outside `[0,1]`), DeepSeek
reasoner (sampling params). Keep the default request to a **conservative,
portable set** (model + messages + tools). If a provider needs something special,
gate it per-provider — don't broaden the shared default.

### 7. Tests
`mcp-host` registry tests (provider present + constructs), the control-api
migration/enum test, and confirm the credential-exclusion leak test still passes
with the expanded slot set (it derives from `ALL_PROVIDERS`, so it should).

---

## Path B — driver-based provider

Everything in Path A, **plus**:

### makeProvider arm — `registry.ts`
Add an explicit `case '<id>':` that builds the provider. Load any SDK **lazily**
with a synchronous `require()` inside the arm (mcp-host is CommonJS) so the SDK is
only parsed when the provider is actually used, and a broken dependency can't take
down startup. Never route a driver provider through the `baseURL` arm.

### Credentials & non-secret env
- Multi-credential providers (Bedrock: key pair; Vertex: SA JSON) list every slot
  in `PROVIDER_CREDENTIAL_SLOTS`. The credential-exclusion boundary
  (`userEnvSnapshot`) derives from the full slot set — never `primarySlot()`.
- Non-secret, per-Host config (region, project, endpoint) goes in
  `PROVIDER_NON_SECRET_ENV` and flows via the pod env (`host-<ref>-env`), surfaced
  in the UI as a "configure in Host → Environment" hint, never a secret field.
- **Exclude such providers from `workflowrecipe.yaml`** — the WRC `configure`
  transport is single-credential and doesn't carry non-secret env, so a
  multi-credential / endpoint-requiring provider must fail at admission, not
  mid-workflow (this is why `bedrock` and `azure` are host-only).

### Azure OpenAI — the reference non-vanilla case
Azure is OpenAI-compatible in shape but not a `baseURL + Bearer` row:
- **No fixed base URL** — the operator supplies `AZURE_OPENAI_ENDPOINT`
  (non-secret env). The driver builds `${endpoint}/openai/v1/` (v1 GA path).
- **Auth is the `api-key` header**, not `Authorization: Bearer`.
- **`model` is the deployment name**, not a catalog id.
Its `RUNTIME_FIELDS.azure` carries a `defaultModel` + `tokenizer: 'openai'` but
**no static baseURL**, so it takes the explicit `case 'azure':` arm and reads the
endpoint from `process.env` at construction. Fail-closed if the endpoint is absent.

---

## Gotchas encoded in the registry (2026)

| provider | base_url quirk | param / behavior gotcha |
|---|---|---|
| fireworks | model id needs prefix `accounts/fireworks/models/<name>` | — |
| deepinfra | base path is `/v1/openai` (not `/v1`) | tool-calling only on ~most models |
| perplexity | **no** `/v1` in base URL | every call is web-grounded (returns citations) |
| deepseek | accepts with or without `/v1` | reasoner mode restricts sampling params |
| moonshot | `.ai` (global) vs `.cn` (China) host | **no** `tool_choice: 'required'`; temperature `[0,1]` |
| groq | — | rejects `n>1`, `logprobs`, `logit_bias` |
| cerebras | — | rejects `frequency_penalty`/`presence_penalty` |
| openrouter | — | router: same slug may hit different upstreams; tool support per-model |
| nebius | two brands mid-rename (tokenfactory / studio) | `org/model` namespaced ids |
| together / novita / nebius | — | `org/model` namespaced ids |
| gemini (compat) | `…/v1beta/openai/` | beta: unsupported params silently ignored; distinct from `vertex` |
| azure | per-resource endpoint (env) | `api-key` header; `model` = deployment name |

## Checklist

- [ ] `packages/llm-providers/index.cjs` — id, slot(s), label, non-secret env
- [ ] `packages/llm-providers/index.d.ts` — id in the `PROVIDER_IDS` tuple
- [ ] `mcp-host/registryCore.ts` — `RUNTIME_FIELDS` row (baseURL/defaultModel/tokenizer)
- [ ] `mcp-host/registry.ts` — `makeProvider` arm (driver path only)
- [ ] `charts/clerum-crds/crds/host.yaml` — both provider enums
- [ ] `charts/clerum-crds/crds/workflowrecipe.yaml` — enums (single-credential only)
- [ ] `control-api/src/db.ts` — allowlist seed migration
- [ ] `control-ui/lib/llm.ts` — `LLM_DEFAULT_MODEL_BY_PROVIDER` entry
- [ ] param-compat reviewed; tests updated; `tsc --noEmit` clean across services
- [ ] operator doc updated (`docs/deploy/llm-providers.md`)
