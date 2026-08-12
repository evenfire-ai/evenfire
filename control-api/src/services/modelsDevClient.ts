/**
 * models.dev catalog client (spec 09 §2 / §11 — Eje A "discovery" acquisition).
 *
 * Discovery in F2 needs NO API keys and NO per-provider operator config: the
 * source is the PUBLIC models.dev catalog (`https://models.dev/api.json`, MIT).
 * We fetch it LIVE from a single FIXED, trusted URL and fall back to a VENDORED
 * snapshot bundled in the image when the fetch/parse fails, so the sync always
 * has data. There are NO live `<baseURL>/models` calls and NO discovery-keys
 * secret here — that is the higher-risk F3 surface, deliberately out of scope.
 *
 * Because the URL is fixed and takes no operator/tenant input, this is not the
 * SSRF surface the threat-model (§4/§11) worries about. The fetch client still
 * keeps its guards (https-only, timeout, byte cap, no cross-host redirect, JSON
 * parse-guard) as defense-in-depth. No auth header is sent (the catalog is
 * public) and the response body is never logged.
 */
import { type LlmProviderId, PROVIDER_IDS } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../data/modelsDevSnapshot.js'

/**
 * The catalog URL. Defaults to the fixed, trusted public endpoint. It is NOT
 * an operator/tenant-input surface (no SSRF vector — see the module header), but
 * `MODELS_DEV_API_URL` may override it via env so a non-prod plane (e.g. a test
 * cluster with the periodic sync enabled) can be pointed at a local stub instead
 * of hammering the real models.dev host. Trimmed; a blank env falls back to the
 * default. The `fetchImpl`/`loadCatalog` DI seam remains the mechanism tests use.
 */
const DEFAULT_MODELS_DEV_API_URL = 'https://models.dev/api.json'
export const MODELS_DEV_API_URL =
  process.env.MODELS_DEV_API_URL?.trim() || DEFAULT_MODELS_DEV_API_URL

/** Fetch guards (defense-in-depth; the URL is fixed/trusted). */
const FETCH_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024 // ~15MB — api.json is ~3MB today.

/**
 * One model entry as it appears in the (normalized) catalog. This is a subset
 * of the models.dev per-model object — only the fields discovery consumes. The
 * live api.json carries many more fields; they are ignored, not parsed.
 */
export interface RawModelsDevModel {
  id?: string
  name?: string
  limit?: { context?: number }
}

/** One provider entry in the (normalized) catalog: a map of model id → entry. */
export interface RawModelsDevProvider {
  name?: string
  models: Record<string, RawModelsDevModel>
}

/**
 * The normalized catalog shape shared by the live parse and the vendored
 * snapshot: models.dev provider key → provider entry. The live api.json is
 * keyed EXACTLY like this at its top level (provider key → { …, models }); the
 * vendored snapshot is generated to the same shape, so both parse identically.
 */
export type RawModelsDevCatalog = Record<string, RawModelsDevProvider>

/**
 * Our provider id → models.dev provider KEY (spec 09 §11.2: the mapping layer is
 * load-bearing — ~10/21 keys differ from our ids). Every value was verified
 * against a live `api.json` fetch during implementation. Providers absent from
 * this map (none today — all 21 are mapped) would simply contribute nothing.
 *
 * Notable / non-obvious choices:
 *   - `zai` → `zai-coding-plan`: our zai baseURL is the Z.AI *Coding Plan*
 *     endpoint, so we map to models.dev's coding-plan key (present) rather than
 *     the generic `zai` / `zhipuai` keys — the coding-plan model set is the one
 *     our runtime can actually reach.
 *   - `bailian` → `alibaba`: bailian is Alibaba Cloud Model Studio; models.dev's
 *     `alibaba` key carries the qwen/glm/kimi/minimax catalog bailian hosts.
 *   - `claude` → `anthropic`, `gemini` → `google`, `vertex` → `google-vertex`,
 *     `bedrock` → `amazon-bedrock`, `together` → `togetherai`,
 *     `fireworks` → `fireworks-ai`, `moonshot` → `moonshotai`,
 *     `novita` → `novita-ai`.
 *   - direct (key == our id): openai, openrouter, deepseek, groq, mistral, xai,
 *     cerebras, deepinfra, perplexity, nebius, azure.
 *
 * NOTE: Azure/Bedrock ids in models.dev are generic model ids, NOT the Azure
 * deployment names / regional inference-profile ids a real deployment uses.
 * Discovery inserts them as `enabled=false, source='discovery'`, so they are
 * only ever review candidates — the operator's hand-added `source='manual'`
 * rows (deployment names, `us.anthropic.*` profiles) are never touched (§11.2).
 */
export const PROVIDER_KEY_MAP: Readonly<Record<LlmProviderId, string>> = {
  openai: 'openai',
  claude: 'anthropic',
  zai: 'zai-coding-plan',
  bailian: 'alibaba',
  vertex: 'google-vertex',
  bedrock: 'amazon-bedrock',
  openrouter: 'openrouter',
  gemini: 'google',
  deepseek: 'deepseek',
  groq: 'groq',
  together: 'togetherai',
  fireworks: 'fireworks-ai',
  mistral: 'mistral',
  xai: 'xai',
  cerebras: 'cerebras',
  deepinfra: 'deepinfra',
  perplexity: 'perplexity',
  moonshot: 'moonshotai',
  nebius: 'nebius',
  novita: 'novita-ai',
  azure: 'azure',
}

/** One discovered model, mapped to our columns (spec 09 §2.2 reconciliation). */
export interface DiscoveredModel {
  model_id: string
  context_window_tokens?: number
  vendor?: string
  display_name?: string
}

/** Result of loading the catalog: which source served it, when, and the data. */
export interface ModelsDevCatalogResult {
  source: 'live' | 'vendored'
  fetchedAt: string
  catalog: RawModelsDevCatalog
}

/** Injectable fetch for tests (defaults to the global fetch). */
export type FetchLike = typeof fetch

/**
 * Read a `fetch` Response body with a hard byte cap. Streams the body so an
 * over-cap (or Content-Length-lying) response is aborted early rather than
 * buffered whole. Returns the decoded text, or throws if the cap is exceeded.
 */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const body = res.body
  if (!body) {
    // Non-streaming path: only reached with a fetch impl that exposes no body
    // stream (undici's global fetch always streams, so this is not hit today).
    // Honor a declared Content-Length BEFORE buffering so an oversized response
    // is rejected without materializing it; the post-buffer check still guards a
    // missing/lying header.
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error('models.dev response exceeded byte cap')
    }
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('models.dev response exceeded byte cap')
    }
    return text
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) throw new Error('models.dev response exceeded byte cap')
        chunks.push(value)
      }
    }
  } finally {
    // Release the lock; if we bailed early this also cancels the download.
    try {
      await reader.cancel()
    } catch {
      // best-effort
    }
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')
}

/**
 * Type-guard: a parsed value is a usable catalog only if it is a plain object
 * whose entries look like provider entries (carry a `models` object). This is
 * the JSON parse-guard — a malformed/hostile body that parses to a non-object,
 * an array, or the wrong shape is rejected (→ caller falls back to vendored).
 */
function isRawCatalog(value: unknown): value is RawModelsDevCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value as Record<string, unknown>)
  if (entries.length === 0) return false
  // At least one entry must carry a `models` object; entries without it are
  // tolerated (skipped later) but a body with zero provider-shaped entries is
  // treated as unusable.
  return entries.some(
    e =>
      !!e &&
      typeof e === 'object' &&
      !Array.isArray(e) &&
      typeof (e as { models?: unknown }).models === 'object' &&
      (e as { models?: unknown }).models !== null
  )
}

/**
 * Assert the resolved catalog URL is a safe egress target BEFORE any fetch. The
 * module header promises an https-only guard; with the `MODELS_DEV_API_URL` env
 * override in play, a misconfigured deploy could otherwise resolve to `http://`
 * or an internal/link-local host (cloud metadata at 169.254.169.254, a cluster
 * `.internal` Service). This is a deploy-time input, not operator/tenant-facing,
 * but the boundary is real — so a bad URL is a hard error, not a silent
 * vendored-fallback that would hide the misconfiguration forever.
 */
function assertSafeCatalogUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`models.dev catalog URL is not a valid URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`models.dev catalog URL must be https:// (got "${parsed.protocol}//")`)
  }
  const host = parsed.hostname.toLowerCase()
  const linkLocalOrMetadata =
    host === 'localhost' ||
    host === '::1' ||
    host === '169.254.169.254' ||
    host.startsWith('169.254.') || // IPv4 link-local range (incl. cloud metadata)
    host === 'metadata.google.internal' ||
    host.endsWith('.internal')
  if (linkLocalOrMetadata) {
    throw new Error(`models.dev catalog URL host is not an allowed egress target: ${host}`)
  }
}

/**
 * Fetch the LIVE catalog from the resolved URL with all guards, or fall back to
 * the vendored snapshot on ANY fetch/parse failure (network error, timeout,
 * non-2xx, redirect, over-cap body, parse/shape failure) — so the sync always
 * has data. A misconfigured (non-https / disallowed-host) catalog URL is a
 * DEPLOY error, not a transient failure: it throws BEFORE any fetch rather than
 * degrading to vendored, so the misconfiguration surfaces instead of hiding.
 */
export async function loadModelsDevCatalog(
  opts: { fetchImpl?: FetchLike; now?: () => Date } = {}
): Promise<ModelsDevCatalogResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => new Date())
  // Egress guard — throws before touching the network on a bad URL.
  assertSafeCatalogUrl(MODELS_DEV_API_URL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(MODELS_DEV_API_URL, {
      method: 'GET',
      // Reject ANY redirect. The URL is fixed and served 200 directly; a 3xx
      // (esp. to a different host) is treated as failure → vendored fallback.
      // This is stricter than "don't follow cross-host redirects".
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`models.dev fetch returned HTTP ${res.status}`)
    const text = await readCappedText(res, MAX_RESPONSE_BYTES)
    const parsed: unknown = JSON.parse(text)
    if (!isRawCatalog(parsed)) throw new Error('models.dev response failed shape validation')
    return { source: 'live', fetchedAt: now().toISOString(), catalog: parsed }
  } catch (err) {
    // Do NOT log the body. A short reason is enough for operators.
    console.warn(
      '[Discovery] models.dev live fetch failed; using vendored snapshot:',
      err instanceof Error ? err.message : String(err)
    )
    return {
      source: 'vendored',
      fetchedAt: now().toISOString(),
      catalog: VENDORED_MODELS_DEV_SNAPSHOT,
    }
  } finally {
    clearTimeout(timer)
  }
}

// Mirror the manual admin path's zod caps (createLlmAllowedModelSchema:
// `model` .max(400), `display_name` .max(400)) so NO external-source (models.dev)
// field can be stored larger than what the operator API itself accepts. The
// target columns are unbounded TEXT and the operator "enable" flow
// (updateLlmAllowedModelSchema is `.partial()`) never re-validates the stored
// `model`, so an oversized discovered id would be serialized verbatim into the
// `clerum-llm-allowed-models` ConfigMap once enabled — a multi-KB value could
// push the CM past etcd's ~1MB limit and 503 every subsequent materialization
// (allowlist DoS seeded from external data). Clamp/skip here at ingest.
const MAX_MODEL_ID_LEN = 400
const MAX_DISPLAY_NAME_LEN = 400
// A model id with a control/newline char is never valid; reject rather than
// truncate (a truncated id is a different, wrong id).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * Normalize a catalog model id to what our runtime addresses. models.dev keys a
 * few providers' ids with a `models/` prefix (Google native style); strip it.
 * All other ids (vertex `@version`, bedrock `region.vendor.*`, fireworks
 * `accounts/…` paths) are the runtime-addressable ids and are kept verbatim.
 */
function normalizeModelId(rawId: string): string {
  const trimmed = rawId.trim()
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed
}

/**
 * Extract our-provider → discovered models from a catalog. Only providers we map
 * (PROVIDER_KEY_MAP) contribute; a mapped key absent from the catalog yields an
 * empty list (fine — that provider stays manual). Duplicate normalized ids
 * within a provider are de-duplicated (first wins). vendor is left undefined —
 * models.dev has no reliable per-model vendor field, so discovery leaves vendor
 * NULL for the operator to fill.
 */
export function mapCatalogToProviders(
  catalog: RawModelsDevCatalog
): Record<LlmProviderId, DiscoveredModel[]> {
  const out = Object.create(null) as Record<LlmProviderId, DiscoveredModel[]>
  for (const providerId of PROVIDER_IDS) {
    const key = PROVIDER_KEY_MAP[providerId]
    const entry = key ? catalog[key] : undefined
    const models: DiscoveredModel[] = []
    out[providerId] = models
    if (!entry || typeof entry.models !== 'object' || entry.models === null) continue
    const seen = new Set<string>()
    for (const rawId of Object.keys(entry.models)) {
      const m = entry.models[rawId]
      const sourceId = typeof m?.id === 'string' && m.id.trim() ? m.id : rawId
      const modelId = normalizeModelId(sourceId)
      // SKIP (never truncate) a malformed id: empty, a duplicate, over the
      // operator-API length cap, or carrying a control/newline char. Bounding
      // only by the 15MB fetch byte cap, a single hostile/malformed entry could
      // otherwise be multi-KB and, once enabled, bloat the allowlist ConfigMap.
      if (!modelId || seen.has(modelId)) continue
      if (modelId.length > MAX_MODEL_ID_LEN || CONTROL_CHARS.test(modelId)) continue
      seen.add(modelId)
      const discovered: DiscoveredModel = { model_id: modelId }
      const ctx = m?.limit?.context
      if (typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0) {
        discovered.context_window_tokens = ctx
      }
      // display_name is non-load-bearing metadata → clamp (truncate) to the
      // operator-API cap rather than skip the whole model over a long label.
      const displayName = (typeof m?.name === 'string' ? m.name.trim() : '').slice(
        0,
        MAX_DISPLAY_NAME_LEN
      )
      if (displayName) discovered.display_name = displayName
      models.push(discovered)
    }
    // Deterministic order keeps sync output/tests stable.
    models.sort((a, b) => a.model_id.localeCompare(b.model_id))
  }
  return out
}
