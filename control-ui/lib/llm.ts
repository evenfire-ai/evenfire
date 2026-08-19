import {
  type LlmProviderId,
  PROVIDER_CREDENTIAL_SLOTS,
  PROVIDER_DISPLAY_LABELS,
  PROVIDER_IDS,
  PROVIDER_NON_SECRET_ENV,
  isLlmProviderId,
} from '@clerum/llm-providers'

// The canonical provider set, labels and credential slots live in the shared
// @clerum/llm-providers package (spec §3-R4) — this module derives its
// provider-level UI metadata from it instead of re-declaring the enum. The
// multi-slot secrets form itself is B3; here we only re-cable the data source.
export type LlmProvider = LlmProviderId

export type PromptBridgeTargetPolicyInput = {
  targetRef: string
  provider: string
  model: string
  credentialSlot: string
}

/**
 * Serialize the operator's ordered promptBridge list without inventing a
 * second default-selection rule. The first reviewed target is authoritative;
 * every other field is derived from that same ordered list.
 */
export function buildPromptBridgeTargetPolicy(targets: PromptBridgeTargetPolicyInput[]): {
  provider?: string
  allowedModels: string[]
  promptTargets: PromptBridgeTargetPolicyInput[]
  defaultTargetRef?: string
} {
  const promptTargets = targets.map(target => ({ ...target }))
  const first = promptTargets[0]
  return {
    ...(first ? { provider: first.provider, defaultTargetRef: first.targetRef } : {}),
    allowedModels: promptTargets.map(target => target.model),
    promptTargets,
  }
}

export const LLM_PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = PROVIDER_IDS.map(
  id => ({ value: id, label: PROVIDER_DISPLAY_LABELS[id] })
)

// The list of usable models per provider is no longer a static catalog: it is
// the operator-declared allowlist served by control-api (`/admin/llm-models`,
// spec §3-R3). Fetch it with `useLlmAllowedModels()` and pass the rows to the
// catalog helpers below. This module keeps only provider-level metadata.

// A minimal projection of an allowlist row — accepts `LlmAllowedModel` from
// lib/api without importing it, so this module stays dependency-free.
export type LlmModelCatalogEntry = {
  provider: string
  model: string
  enabled: boolean
}

// Wizard pre-select / fallback default per provider. This stays static on
// purpose: it is provider-level UI metadata (a mirror of each provider's
// `registryCore.defaultModel` in mcp-host), NOT a model catalog — R4 will
// absorb it into the shared providers package. When this default is not
// enabled in the allowlist, `resolveDefaultModel()` falls back to the first
// enabled model of the provider.
export const LLM_DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  openai: 'gpt-5.4-mini',
  claude: 'claude-sonnet-4-6',
  zai: 'glm-5.1',
  bailian: 'qwen3-coder-plus',
  vertex: 'gemini-2.5-pro',
  bedrock: 'anthropic.claude-sonnet-4-6-v1:0',
  // OpenAI-compatible additions (mirror registryCore.defaultModel).
  openrouter: 'anthropic/claude-sonnet-latest',
  gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-v4-flash',
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  mistral: 'mistral-medium-latest',
  xai: 'grok-4.3',
  cerebras: 'gpt-oss-120b',
  deepinfra: 'deepseek-ai/DeepSeek-V3.2',
  perplexity: 'sonar-pro',
  moonshot: 'kimi-k2.6',
  nebius: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
  novita: 'deepseek/deepseek-v3.2',
  // Azure: the "model" is a per-deployment name the operator chooses; this is
  // only a placeholder pre-select (operator overrides in the allowlist).
  azure: 'gpt-4.1',
}

// The vertex service-account slot key, derived from the package (never
// hardcoded). Drives the textarea rendering and the JSON-shape validation.
const VERTEX_SERVICE_ACCOUNT_KEY: string = PROVIDER_CREDENTIAL_SLOTS.vertex[0].dataKey

// UI-only decoration per slot (labels/placeholders are presentation, not
// provider data — the shared package carries no example values). Keyed by the
// slot's dataKey; slots without an entry fall back to a derived label.
const SECRET_FIELD_HINTS: Record<string, { label: string; placeholder: string }> = {
  'openai-api-key': { label: 'OpenAI API key', placeholder: 'sk-...' },
  'claude-api-key': { label: 'Claude API key', placeholder: 'sk-ant-...' },
  'zai-api-key': { label: 'Z.AI API key', placeholder: 'zai-...' },
  'bailian-api-key': { label: 'Bailian API key', placeholder: 'bailian-...' },
  'vertex-service-account-json': {
    label: 'Google Vertex AI service account JSON',
    placeholder: '{ "type": "service_account", ... }',
  },
  'aws-access-key-id': { label: 'Amazon Bedrock access key ID', placeholder: 'AKIA...' },
  'aws-secret-access-key': { label: 'Amazon Bedrock secret access key', placeholder: '' },
}

// One credential field of a provider group. Provider data (dataKey/envName/
// required) comes from the shared package; label/placeholder/multiline are UI
// decoration derived from SECRET_FIELD_HINTS above.
export type LlmCredentialField = {
  dataKey: string
  envName: string
  required: boolean
  label: string
  placeholder: string
  // The Vertex service-account JSON is pasted into a textarea, not a one-line
  // password input.
  multiline: boolean
}

// One provider group in the multi-slot secrets form (spec R4.5.2). Single-key
// providers render one field; Bedrock renders its access-key pair; Vertex
// renders the service-account JSON textarea. `nonSecretEnv` are the non-secret
// per-Host env vars (VERTEX_PROJECT_ID/-LOCATION, AWS_REGION) surfaced as a hint
// with a link to Host → Environment — they are NEVER credential fields
// (spec R4.5.4).
export type LlmCredentialGroup = {
  provider: LlmProvider
  label: string
  slots: LlmCredentialField[]
  nonSecretEnv: string[]
}

// The single source of the secrets-form structure (spec R4.5.1: the slot list
// always comes from the package — never a hardcoded field list in the UI).
export const LLM_CREDENTIAL_GROUPS: LlmCredentialGroup[] = PROVIDER_IDS.map(id => ({
  provider: id,
  label: PROVIDER_DISPLAY_LABELS[id],
  slots: PROVIDER_CREDENTIAL_SLOTS[id].map(slot => ({
    dataKey: slot.dataKey,
    envName: slot.envName,
    required: slot.required,
    label: SECRET_FIELD_HINTS[slot.dataKey]?.label ?? `${PROVIDER_DISPLAY_LABELS[id]} API key`,
    placeholder: SECRET_FIELD_HINTS[slot.dataKey]?.placeholder ?? '',
    multiline: slot.multiline ?? false,
  })),
  nonSecretEnv: PROVIDER_NON_SECRET_ENV[id].map(env => env.envName),
}))

// A blank LLM credential draft (dataKey -> '') seeded from the shared provider
// package, so every provider group (incl. Bailian/Vertex/Bedrock) renders. Used
// to initialize/reset the multi-slot secrets form on every LLM surface.
export function createEmptyLlmKeyDraft(): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const group of LLM_CREDENTIAL_GROUPS) {
    for (const slot of group.slots) draft[slot.dataKey] = ''
  }
  return draft
}

// The bedrock credential-slot keys and the vertex service-account key, derived
// from the package (never hardcoded here). Used by the slot-aware validation
// below and mirrored by control-api's write-side validation.
export const BEDROCK_CREDENTIAL_KEYS: string[] = PROVIDER_CREDENTIAL_SLOTS.bedrock.map(
  slot => slot.dataKey
)

// Group completeness for the "provider usable" chip (spec R4.5.5): a provider is
// usable once every `required` slot has a value. `present` counts required slots
// filled; `usable` is true when all required slots are present.
export function getLlmGroupCompleteness(
  group: LlmCredentialGroup,
  isPresent: (dataKey: string) => boolean
): { present: number; total: number; usable: boolean } {
  const required = group.slots.filter(slot => slot.required)
  const present = required.filter(slot => isPresent(slot.dataKey)).length
  return {
    present,
    total: required.length,
    usable: required.length > 0 && present === required.length,
  }
}

// UI descriptor for a group's usable/partial/absent chip (spec R4.5.5). Single
// required slot reads present/absent; multi-slot reads the filled/required ratio
// (● usable / ◐ partial / ○ absent). Shared by every per-provider block so the
// chip never drifts between surfaces.
export function describeLlmCompleteness(
  group: LlmCredentialGroup,
  isPresent: (dataKey: string) => boolean
): { symbol: string; text: string; state: 'present' | 'partial' | 'absent' } {
  const { present, total, usable } = getLlmGroupCompleteness(group, isPresent)
  if (total <= 1) {
    return usable
      ? { symbol: '●', text: 'present', state: 'present' }
      : { symbol: '○', text: 'absent', state: 'absent' }
  }
  if (usable) return { symbol: '●', text: `${present}/${total}`, state: 'present' }
  return present > 0
    ? { symbol: '◐', text: `${present}/${total}`, state: 'partial' }
    : { symbol: '○', text: `${present}/${total}`, state: 'absent' }
}

// Look up the credential group (slots + non-secret env) for a provider. Every
// known provider has exactly one group; falls back to the first group only for
// an impossible/unknown id so callers never handle `undefined`.
export function getLlmCredentialGroup(provider: LlmProvider): LlmCredentialGroup {
  return (
    LLM_CREDENTIAL_GROUPS.find(group => group.provider === provider) ?? LLM_CREDENTIAL_GROUPS[0]
  )
}

// Derive the providers a Secret can serve from its data-key NAMES alone. Secret
// values never reach the control UI: a provider is available only when every
// required key in its registry group is present (e.g. both Bedrock keys).
export function getProvidersWithCompleteCredentials(secretKeys: string[]): LlmProvider[] {
  const keys = new Set(secretKeys)
  return LLM_CREDENTIAL_GROUPS.filter(group => {
    const requiredSlots = group.slots.filter(slot => slot.required)
    return requiredSlots.length > 0 && requiredSlots.every(slot => keys.has(slot.dataKey))
  }).map(group => group.provider)
}

// The canonical (registry) credential dataKeys a provider loads by default —
// e.g. `['openai-api-key']`, or the Bedrock access-key pair. Used to project the
// per-provider credential blocks of the domain and to detect when a fallback
// would reuse the primary provider's key (spec Topic 1b, design C).
export function getProviderSlotKeys(provider: LlmProvider): string[] {
  return getLlmCredentialGroup(provider).slots.map(slot => slot.dataKey)
}

// True when every REQUIRED slot of the provider is present (usable). The
// asymmetric save gate uses this on the PRIMARY provider (block create/save when
// false); fallbacks only warn, never block (spec Topic 1b: optional means
// optional). `isPresent` is the write-only present predicate (typed value OR a
// key already stored in the Host's Secret).
export function isProviderUsable(
  provider: LlmProvider,
  isPresent: (dataKey: string) => boolean
): boolean {
  return getLlmGroupCompleteness(getLlmCredentialGroup(provider), isPresent).usable
}

// The credential dataKeys currently in the provider domain — the primary's
// canonical slots ∪ each fallback's EFFECTIVE slot(s) (its chosen extra slot, or
// its provider's canonical slots). This is the exact projection the Host's
// credential UI renders; use it to prune the write-only draft so a value typed
// for a since-unmounted provider (primary switched, or a fallback removed) is
// NEITHER validated NOR written — no stale block, no orphan key in the Secret
// (spec Topic 1b). Mirrors the component's per-block slot resolution.
export function getActiveCredentialKeys(
  provider: LlmProvider,
  policy: LlmPolicy | undefined
): Set<string> {
  const keys = new Set<string>(getProviderSlotKeys(provider))
  for (const fallback of policy?.fallbacks ?? []) {
    if (fallback.credentialSlot) keys.add(fallback.credentialSlot)
    else for (const key of getProviderSlotKeys(fallback.provider)) keys.add(key)
  }
  return keys
}

// Project a write-only credential draft onto the active domain and drop empties —
// the single builder for every LLM Secret write body (create POST, edit merge
// PUT) so an orphaned key can never be written.
export function projectCredentialDraft(
  draft: Record<string, string>,
  activeKeys: Set<string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(draft)) {
    if (!activeKeys.has(key)) continue
    const trimmed = value.trim()
    if (trimmed.length > 0) out[key] = trimmed
  }
  return out
}

// Mint the next non-colliding `${provider}-api-key-fbN` extra-slot dataKey given
// the keys already claimed by the primary, other fallbacks and the Secret. Used
// when a fallback reuses the primary provider and must NOT overwrite the primary
// key (spec Topic 1b: same-provider fallback needs an EXTRA slot). Mirrors the
// suggested naming in LlmCredentialFields' extra-slot mechanism.
export function mintFallbackSlot(provider: LlmProvider, claimed: Iterable<string>): string {
  const taken = new Set(claimed)
  let n = 1
  while (taken.has(`${provider}-api-key-fb${n}`)) n += 1
  return `${provider}-api-key-fb${n}`
}

// Slot-aware validation shared by every LLM secrets surface (spec R4.5.3),
// mirrored server-side in control-api's secrets route. Enforces only the
// cross-slot rules the generic key/value form cannot express:
//   - Bedrock: the access-key-id / secret-access-key pair must be written
//     together (never a half-configured state that surfaces at runtime).
//   - Vertex: the pasted service-account JSON must parse and carry client_email
//     and private_key before it is stored.
// Any key the package does not know is ignored, so the generic contract is
// untouched. `data` is the write payload (dataKey -> value); values are trimmed.
export function validateLlmSecretData(data: Record<string, string>): string[] {
  const errors: string[] = []
  const has = (key: string) => (data[key] ?? '').trim().length > 0

  const bedrockPresent = BEDROCK_CREDENTIAL_KEYS.filter(has)
  if (bedrockPresent.length > 0 && bedrockPresent.length < BEDROCK_CREDENTIAL_KEYS.length) {
    const missing = BEDROCK_CREDENTIAL_KEYS.filter(key => !has(key))
    errors.push(
      `Amazon Bedrock needs both credentials written together — missing: ${missing.join(', ')}.`
    )
  }

  if (has(VERTEX_SERVICE_ACCOUNT_KEY)) {
    const vertexError = validateVertexServiceAccountJson(data[VERTEX_SERVICE_ACCOUNT_KEY])
    if (vertexError) errors.push(vertexError)
  }

  return errors
}

// Validate the shape (not the cryptographic validity) of a pasted Vertex
// service-account JSON: it must parse and contain non-empty client_email and
// private_key. Returns an error message, or null when the shape is acceptable.
export function validateVertexServiceAccountJson(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return `${VERTEX_SERVICE_ACCOUNT_KEY} must be valid JSON.`
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `${VERTEX_SERVICE_ACCOUNT_KEY} must be a service account JSON object.`
  }
  const record = parsed as Record<string, unknown>
  const missing = ['client_email', 'private_key'].filter(field => {
    const value = record[field]
    return typeof value !== 'string' || value.trim().length === 0
  })
  if (missing.length > 0) {
    return `${VERTEX_SERVICE_ACCOUNT_KEY} must contain ${missing.join(' and ')}.`
  }
  return null
}

export function normalizeProvider(value: string | undefined | null): LlmProvider {
  return typeof value === 'string' && isLlmProviderId(value) ? value : 'openai'
}

export function getProviderLabel(provider: string | undefined | null): string {
  const normalized = normalizeProvider(provider)
  const match = LLM_PROVIDER_OPTIONS.find(option => option.value === normalized)
  return match?.label || 'OpenAI'
}

// True when `provider` is one of the recognized LlmProvider values.
export function isKnownProvider(provider: string | undefined | null): boolean {
  return LLM_PROVIDER_OPTIONS.some(option => option.value === provider)
}

// Friendly label for a known provider, otherwise the value verbatim. Unlike
// getProviderLabel (which falls back to "OpenAI"), this never mislabels an
// unrecognized provider — important where free-form providers surface, e.g.
// the LLM-prices table and the unpriced-model chips.
export function getProviderDisplayLabel(provider: string): string {
  return isKnownProvider(provider) ? getProviderLabel(provider) : provider
}

// Renders a model's context window for display. Falls back to an em dash when
// the value is unknown (NULL in the catalog) or not a finite number. Shared by
// the allowlist catalog table and the discovery review surfaces.
export function formatContextWindow(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString()
}

// Model names allowed for a provider, drawn from the allowlist catalog. By
// default only `enabled` rows are returned (host wizard / runtime pickers must
// offer only enabled models); pass `includeDisabled` for surfaces that browse
// the full catalog (e.g. price suggestions). Catalog order is preserved (the
// API returns rows ordered provider, model).
export function getModelOptions(
  catalog: LlmModelCatalogEntry[],
  provider: string,
  options: { includeDisabled?: boolean } = {}
): string[] {
  return catalog
    .filter(entry => entry.provider === provider && (options.includeDisabled || entry.enabled))
    .map(entry => entry.model)
}

// All model names in the allowlist across providers (e.g. for budget-scope
// suggestions). De-duplicated, insertion order preserved.
export function getAllModelOptions(
  catalog: LlmModelCatalogEntry[],
  options: { includeDisabled?: boolean } = {}
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of catalog) {
    if (!options.includeDisabled && !entry.enabled) continue
    if (seen.has(entry.model)) continue
    seen.add(entry.model)
    out.push(entry.model)
  }
  return out
}

// UI default model for a provider: the static provider-level default if it is
// present in the enabled list, otherwise the first enabled model. Returns '' if
// the provider has no enabled models (caller shows an empty/error picker; no
// hardcoded fallback per spec R4.5.1).
export function resolveDefaultModel(provider: LlmProvider, enabledModels: string[]): string {
  const explicit = LLM_DEFAULT_MODEL_BY_PROVIDER[provider]
  if (explicit && enabledModels.includes(explicit)) return explicit
  return enabledModels[0] ?? ''
}

// ── Per-host model allowlist subset (spec Topic 3a) ───────────────────────
// `spec.allowedModels` on a Host: a flat, OPTIONAL list of (provider, model)
// pairs = the SUBSET of the global operator allowlist this host offers to end
// users. Absent/empty = the host offers the FULL global allowlist for its
// provider(s) — the back-compat default (an operator who doesn't restrict keeps
// today's behavior). The OPERATOR curates this subset here; the END-USER's
// per-session model selector (desktop-app) later offers only this subset.
export type HostAllowedModel = { provider: string; model: string }

// The models this host explicitly restricts `provider` to (its per-host subset),
// in first-seen order and de-duplicated. Empty = the provider is UNRESTRICTED
// (the host offers the full global allowlist for it).
export function allowedModelsForProvider(allowed: HostAllowedModel[], provider: string): string[] {
  const out: string[] = []
  for (const entry of allowed) {
    if (entry.provider !== provider) continue
    const model = (entry.model || '').trim()
    if (model && !out.includes(model)) out.push(model)
  }
  return out
}

// True when the operator did NOT restrict this provider — either no models are
// listed, or every enabled global model is listed (selecting "all" is the same
// as leaving it unrestricted). Drives the "All models" default state in the UI
// and decides whether to emit entries into the spec (unrestricted → omit).
export function isProviderAllowUnrestricted(selected: string[], enabledGlobal: string[]): boolean {
  if (selected.length === 0) return true
  if (enabledGlobal.length === 0) return false
  return (
    selected.length === enabledGlobal.length &&
    enabledGlobal.every(model => selected.includes(model))
  )
}

// The model options a provider's model dropdown (primary or fallback) should
// offer: the per-host subset when the provider is restricted, otherwise the full
// enabled global allowlist. Constrains the operator's own primary/fallback pick
// to the subset they defined. A saved model that falls OUTSIDE the subset is not
// dropped here — the caller keeps it selectable as an out-of-set option
// (non-disruptive, spec R3.7).
export function constrainModelOptions(
  catalog: LlmModelCatalogEntry[],
  allowed: HostAllowedModel[],
  provider: string
): string[] {
  const enabledGlobal = getModelOptions(catalog, provider)
  const subset = allowedModelsForProvider(allowed, provider)
  if (isProviderAllowUnrestricted(subset, enabledGlobal)) return enabledGlobal
  return subset
}

// Assemble the flat `spec.allowedModels` array for the Host spec: drop any
// provider the operator left UNRESTRICTED (empty, or all enabled selected) so
// absent=all-global holds and a host that restricts nothing saves exactly as
// today. Only genuine subsets are emitted. When the catalog failed to load
// (`catalog` empty) an existing subset is preserved verbatim rather than lost.
// Order: provider groups in first-seen order, models in selection order.
export function buildAllowedModelsSpec(
  allowed: HostAllowedModel[],
  catalog: LlmModelCatalogEntry[]
): HostAllowedModel[] {
  const byProvider = new Map<string, string[]>()
  const order: string[] = []
  for (const entry of allowed) {
    const model = (entry.model || '').trim()
    if (!entry.provider || !model) continue
    if (!byProvider.has(entry.provider)) {
      byProvider.set(entry.provider, [])
      order.push(entry.provider)
    }
    const list = byProvider.get(entry.provider)
    if (list && !list.includes(model)) list.push(model)
  }
  const out: HostAllowedModel[] = []
  for (const provider of order) {
    const models = byProvider.get(provider) ?? []
    const enabledGlobal = getModelOptions(catalog, provider)
    if (isProviderAllowUnrestricted(models, enabledGlobal)) continue
    for (const model of models) out.push({ provider, model })
  }
  return out
}

// Coerce a raw `spec.allowedModels` (from the Host CR) into the flat editor
// shape. Tolerant of partial/old data: skips entries without a string provider
// AND model; preserves values verbatim (an entry whose model fell out of the
// global allowlist is kept — the editor surfaces it, spec R3.7); de-duplicates.
// Returns [] when absent/empty (the host offers the full global allowlist).
export function normalizeAllowedModels(raw: unknown): HostAllowedModel[] {
  if (!Array.isArray(raw)) return []
  const out: HostAllowedModel[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (!provider || !model) continue
    if (out.some(existing => existing.provider === provider && existing.model === model)) continue
    out.push({ provider, model })
  }
  return out
}

// ── LLM fallback policy (spec §3-R5) ──────────────────────────────────────
// `spec.llmPolicy` on a Host: an opt-in, ordered list of fallback (provider,
// model) pairs mcp-host switches to when the primary fails with an eligible
// error. The shape mirrors the CRD (charts/clerum-crds/crds/host.yaml) and the
// write-side gate in control-api (routes/admin/hostSpecValidation.ts). The
// editor lives in components/LlmPolicyEditor and is mounted on the Host edit
// page next to spec.model.

// The four error classes that can trigger a fallback (CRD enum + default). A
// Host omitting `triggerOn` fails over on all four.
export const LLM_TRIGGER_CLASSES = [
  'insufficient_quota',
  'auth',
  'provider_unavailable',
  'rate_limited',
] as const

export type LlmTriggerClass = (typeof LLM_TRIGGER_CLASSES)[number]

// Human-facing labels for the trigger classes (UI decoration only).
export const LLM_TRIGGER_LABELS: Record<LlmTriggerClass, string> = {
  insufficient_quota: 'Out of credit / quota',
  auth: 'Auth failure (banned/invalid key)',
  provider_unavailable: 'Provider unavailable (5xx / timeout)',
  rate_limited: 'Rate limited (429)',
}

// CRD default when `cooldownSeconds` is omitted.
export const LLM_DEFAULT_COOLDOWN_SECONDS = 300

// Shown when a policy has fallbacks but every trigger class is deselected — the
// runtime would then fail over on nothing. Shared by `validateLlmPolicy` and the
// Host page's catalog-independent save guard so the two can't drift.
export const LLM_EMPTY_TRIGGER_ERROR = 'Select at least one error class that triggers a fallback.'

// One ordered fallback entry. `credentialSlot` is optional (empty = the
// provider's normal/primary slot) and is ALWAYS chosen from a dropdown of real
// Secret data keys — never free text (spec R4.5.6, kills the CRD↔Secret typo).
export type LlmFallbackEntry = {
  provider: LlmProvider
  model: string
  credentialSlot?: string
}

export type LlmPolicy = {
  cooldownSeconds?: number
  triggerOn?: LlmTriggerClass[]
  fallbacks: LlmFallbackEntry[]
}

// Every credential slot key the registry knows across all providers — used to
// tell a provider's fallback slots apart from stray keys in the shared Secret.
const ALL_REGISTRY_SLOT_KEYS: ReadonlySet<string> = new Set(
  PROVIDER_IDS.flatMap(id => PROVIDER_CREDENTIAL_SLOTS[id].map(slot => slot.dataKey))
)

// Client mirror of control-api's `providerSupportsFallbackCredentialSlot`
// (hostSpecValidation.ts): a per-fallback `credentialSlot` is a SINGLE dataKey,
// so it can only express providers whose credential is one simple api-key value.
// Providers with a multi-slot pair (Bedrock: access-key-id + secret-access-key)
// or a multiline JSON slot (Vertex: service-account JSON) can't be expressed as
// one extra slot, so the backend rejects ANY credentialSlot on them (422). The
// UI must not let the operator compose such a spec. Uses the shared
// `PROVIDER_CREDENTIAL_SLOTS.multiline` flag — the SAME source of truth the
// control-api gate now reads — so the UI and backend cannot drift (no more
// name heuristic vs exact-key divergence).
export function providerSupportsFallbackCredentialSlot(provider: LlmProvider): boolean {
  const slots = PROVIDER_CREDENTIAL_SLOTS[provider]
  return slots.length === 1 && !slots[0].multiline
}

// Dropdown options for a fallback entry's `credentialSlot` (spec R4.5.6): the
// provider's canonical registry slots first, then any EXTRA keys already present
// in the LLM Secret that belong to this provider (e.g. `claude-api-key-fb1`).
// Extra keys are matched only by a canonical registry slot prefix (the
// suggested `<slot>-fb1` naming), excluding keys that are canonical slots of
// another provider. A provider-name prefix alone (for example
// `openai-project`) is not a credential slot and must not be offered.
// Providers that can't express a single-key slot (Bedrock/Vertex) offer NOTHING —
// their fallbacks reuse the primary credentials (mirrors the backend gate).
export function getCredentialSlotOptions(
  provider: LlmProvider,
  secretKeys: string[] = []
): string[] {
  if (!providerSupportsFallbackCredentialSlot(provider)) return []
  const registrySlots = PROVIDER_CREDENTIAL_SLOTS[provider].map(slot => slot.dataKey)
  const prefixes = registrySlots
  const extras = secretKeys
    .filter(key => !ALL_REGISTRY_SLOT_KEYS.has(key))
    .filter(key => prefixes.some(prefix => key.startsWith(prefix)))
    .sort((a, b) => a.localeCompare(b))
  return Array.from(new Set([...registrySlots, ...extras]))
}

/**
 * Credential identities for an ordered promptBridge target. Unlike a Host
 * failover override, a promptBridge target names the complete provider
 * credential set that the WRC broker resolves for that attempt. Canonical
 * multiline and multi-slot providers therefore remain selectable; only
 * single-key providers may add suffixed extra slots.
 */
export function getPromptBridgeCredentialSlotOptions(
  provider: LlmProvider,
  secretKeys: string[] = []
): string[] {
  const slots = PROVIDER_CREDENTIAL_SLOTS[provider]
  const registrySlots = slots.map(slot => slot.dataKey)
  if (registrySlots.length === 0) return []
  if (slots.length !== 1 || slots[0].multiline === true) return registrySlots

  const prefixes = registrySlots
  const extras = secretKeys
    .filter(key => !ALL_REGISTRY_SLOT_KEYS.has(key))
    .filter(key => prefixes.some(prefix => key.startsWith(prefix)))
    .sort((a, b) => a.localeCompare(b))
  return Array.from(new Set([...registrySlots, ...extras]))
}

// Derive the provider that owns a Secret dataKey, or null for a stray key
// (additive LLM secrets editor, spec B1). Prefix-aware — matching only
// canonical slots would lose operator-minted EXTRA slots (`claude-api-key-fb1`
// from mintFallbackSlot, or the secrets form's "Add credential slot"), making
// a Secret that holds ONLY an extra slot of a provider render that provider
// as absent. Mirrors the extra-key matching in getCredentialSlotOptions:
//   1. an exact canonical (registry) slot dataKey → its provider;
//   2. otherwise, a key carrying a provider's `${provider}-` prefix or
//      extending one of its canonical slot keys (the suggested `<slot>-fbN`
//      naming; covers Bedrock's `aws-…` extras) → that provider. A canonical
//      key of ANOTHER provider can never fall here — rule 1 already claimed
//      every key in ALL_REGISTRY_SLOT_KEYS;
//   3. otherwise → null (the editor ignores the key).
export function providerForDataKey(dataKey: string): LlmProvider | null {
  for (const group of LLM_CREDENTIAL_GROUPS) {
    if (group.slots.some(slot => slot.dataKey === dataKey)) return group.provider
  }
  for (const group of LLM_CREDENTIAL_GROUPS) {
    const prefixes = group.slots.map(slot => slot.dataKey)
    if (prefixes.some(prefix => dataKey.startsWith(prefix))) return group.provider
  }
  return null
}

// Client-side mirror of control-api's write gate (hostSpecValidation.ts): every
// fallback entry must name a known provider and a model that is ENABLED in the
// operator allowlist for that provider; cooldown must be a non-negative integer;
// at least one trigger must stay selected; and a `credentialSlot` may only be set
// on a provider that supports one (never Bedrock/Vertex). Returns human-readable
// messages (the backend 422 is still surfaced inline as the source of truth).
export function validateLlmPolicy(policy: LlmPolicy, catalog: LlmModelCatalogEntry[]): string[] {
  const errors: string[] = []
  if (policy.fallbacks.length === 0) return errors

  if (Array.isArray(policy.triggerOn) && policy.triggerOn.length === 0) {
    errors.push(LLM_EMPTY_TRIGGER_ERROR)
  }
  if (
    policy.cooldownSeconds !== undefined &&
    (!Number.isInteger(policy.cooldownSeconds) || policy.cooldownSeconds < 0)
  ) {
    errors.push('Cooldown must be a non-negative whole number of seconds.')
  }

  policy.fallbacks.forEach((entry, index) => {
    const label = `Fallback #${index + 1}`
    if (!isKnownProvider(entry.provider)) {
      errors.push(`${label}: choose a provider.`)
      return
    }
    const model = (entry.model || '').trim()
    if (!model) {
      errors.push(`${label}: choose a model.`)
      return
    }
    const enabled = getModelOptions(catalog, entry.provider)
    if (!enabled.includes(model)) {
      errors.push(
        `${label}: "${model}" is not enabled in the allowlist for ${getProviderDisplayLabel(entry.provider)}.`
      )
    }
    // Mirror the backend gate: a credentialSlot on a multi-slot/JSON provider
    // (Bedrock/Vertex) can't be expressed as one dataKey and is rejected (422).
    if (entry.credentialSlot && !providerSupportsFallbackCredentialSlot(entry.provider)) {
      errors.push(
        `${label}: ${getProviderDisplayLabel(entry.provider)} fallbacks reuse the primary credentials — remove the credential slot override.`
      )
    }
  })
  return errors
}

// Coerce a raw `spec.llmPolicy` (from the Host CR) into the editor's shape, or
// undefined when there are no usable fallback entries. Tolerant of partial/old
// data: an unknown provider is coerced to the default via `normalizeProvider`,
// while the model string is preserved verbatim (the editor flags a model that
// fell out of the allowlist) so editing never silently drops config.
export function normalizeLlmPolicy(raw: unknown): LlmPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const rawFallbacks = Array.isArray(record.fallbacks) ? record.fallbacks : []
  const fallbacks: LlmFallbackEntry[] = []
  for (const item of rawFallbacks) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const provider = normalizeProvider(typeof entry.provider === 'string' ? entry.provider : '')
    const model = typeof entry.model === 'string' ? entry.model : ''
    const credentialSlot =
      typeof entry.credentialSlot === 'string' && entry.credentialSlot.trim().length > 0
        ? entry.credentialSlot
        : undefined
    fallbacks.push({ provider, model, ...(credentialSlot ? { credentialSlot } : {}) })
  }
  if (fallbacks.length === 0) return undefined

  const cooldownSeconds =
    typeof record.cooldownSeconds === 'number' && Number.isFinite(record.cooldownSeconds)
      ? record.cooldownSeconds
      : LLM_DEFAULT_COOLDOWN_SECONDS
  const triggerOn = Array.isArray(record.triggerOn)
    ? LLM_TRIGGER_CLASSES.filter(cls => (record.triggerOn as unknown[]).includes(cls))
    : [...LLM_TRIGGER_CLASSES]

  return { cooldownSeconds, triggerOn, fallbacks }
}

// A grant stores model names but not the provider. Recover the provider from
// the first model found in the allowlist catalog so a model picklist can be
// filtered to the single provider bound to the recipe's mcp-host. Defaults to
// the first provider when no model matches (e.g. an empty allowlist).
export function inferProviderFromModels(
  models: string[],
  catalog: LlmModelCatalogEntry[]
): LlmProvider {
  for (const model of models) {
    const match = catalog.find(entry => entry.model === model)
    if (match && isKnownProvider(match.provider)) return match.provider as LlmProvider
  }
  return LLM_PROVIDER_OPTIONS[0].value
}
