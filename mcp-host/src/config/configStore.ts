/**
 * ConfigStore — watched, hot-reloaded source for runtime config in mcp-host.
 *
 * Replaces the one-shot `k8sClient.getApiKeys()` boot-time read with three
 * narrowly-scoped Kubernetes watches:
 *
 *   1. LLM Secret (`spec.secretRef`, name from CLERUM_LLM_SECRET_REF)
 *      — holds lowercase-hyphen provider keys (`openai-api-key`, ...).
 *      The key matching `CLERUM_MODEL_PROVIDER` is exposed as the LLM key,
 *      translated to its shell-style name (e.g. `OPENAI_API_KEY`).
 *
 *   2. Per-Host env ConfigMap (`host-<hostRef>-env`)
 *      — non-secret operator-managed env vars, keys are shell-style.
 *
 *   3. Per-Host env Secret (`host-<hostRef>-env-secret`)
 *      — secret operator-managed env vars, keys are shell-style.
 *
 *   4. LLM allowlist ConfigMap (name from `allowlistConfigMapName`)
 *      — operator-declared, per-provider list of usable models (R3). Orthogonal
 *      to the env merge below: it is exposed via {@link allowedModels} /
 *      {@link allowlistAvailable}, not merged into the effective env table.
 *
 * Precedence (first match wins): host secret > host CM > LLM secret > process.env.
 *
 * Updates fire `onChange` with `{llmKeyChanged, envChanged}` so subscribers
 * can skip work that doesn't concern them (e.g. shell-tool spawn cares about
 * envChanged; LLM provider factory cares about llmKeyChanged).
 *
 * Reconnect strategy: watches that disconnect are restarted with exponential
 * backoff; on "too old" the watch falls back to a fresh list and resumes.
 */
import * as k8s from '@kubernetes/client-node'
import {
  ALL_PROVIDERS,
  ALL_PROVIDER_SLOT_ENV_NAMES,
  type LlmProvider,
  descriptorFor,
  primarySlot,
} from '../llm/registryCore'
import type { ProviderCredentials } from '../types'
import { llmAllowlistMissingTotal } from './allowlistMetrics'

// ─── Provider mapping ──────────────────────────────────────────────────────

// Re-export so existing importers of `LlmProvider` from configStore keep working.
export type { LlmProvider }

/**
 * Shell-style env var name of each provider's PRIMARY credential slot — what
 * mcp-host code expects to read for a single-key provider. Derived from the
 * registry (single source of truth). Multi-slot providers (Bedrock) also have
 * secondary slots; those live in {@link PROVIDER_ENV_NAMES}, NOT here.
 * Exported for status/debug callers that key on the primary env name.
 */
export const PROVIDER_ENV_NAME = Object.fromEntries(
  ALL_PROVIDERS.filter(p => descriptorFor(p).authMode === 'static-credentials').map(p => [
    p,
    primarySlot(descriptorFor(p)).envName,
  ])
) as Record<Exclude<LlmProvider, 'codex-subscription'>, string>

/**
 * Every provider credential env var name across ALL providers and ALL their
 * slots (registry-derived, so it tracks the provider/slot set). This is the
 * registry half of the subprocess credential-exclusion boundary and the
 * sanitizer's provider-key matcher. Multi-slot (R4): Bedrock contributes two
 * names here; a single-key provider one.
 */
export const PROVIDER_ENV_NAMES: ReadonlySet<string> = ALL_PROVIDER_SLOT_ENV_NAMES

/**
 * Env var names that must NEVER reach a tool subprocess, be logged, or be
 * surfaced through clerum__get_capabilities (plan §3.5): every provider
 * credential slot (all providers) plus the platform runtime tokens. Wired into
 * {@link ConfigStore.userEnvSnapshot} as the registry+platform half of the
 * credential boundary (spec §3-R4.3); the by-source half (keys actually
 * delivered by the llm-secret tier, covering R5's dynamic fallback slots) is
 * added on top there.
 */
export const RESERVED_SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  ...PROVIDER_ENV_NAMES,
  'PLUGIN_WORKLOAD_SDK_TOKEN',
  'PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKEN',
  'MCP_HOST_RUNTIME_ACCESS_TOKEN',
  'MCP_HOST_RUNTIME_REFRESH_TOKEN',
  'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
])

// ─── Public types ──────────────────────────────────────────────────────────

export interface ConfigStoreChange {
  llmKeyChanged: boolean
  envChanged: boolean
  /** The LLM allowlist ConfigMap (R3) was delivered, updated, or removed. */
  allowlistChanged: boolean
}

/**
 * One operator-declared model in the allowlist ConfigMap (R3). Shape mirrors
 * the shared contract: a JSON array of these per provider key. Only `model` is
 * required; the rest are optional metadata.
 */
export interface AllowedModelEntry {
  model: string
  displayName?: string
  contextWindowTokens?: number
  vendor?: string
}

/**
 * Catalog/credential pair projected onto `clerum-llm-allowed-models` by
 * control-api. Host chat hashes this with the selected model to authorize a
 * Codex attempt. Annotation names are a cross-service contract with
 * control-api, HCC, and WRC.
 */
export type CodexPolicyBinding = {
  catalogRevision: number
  credentialRevision: number
  connectionKey: string
}

export const CATALOG_REVISION_ANNOTATION = 'clerum.io/catalog-revision'
export const CONNECTION_REVISION_ANNOTATION = 'clerum.io/connection-revision'
export const CODEX_CONNECTIONS_ANNOTATION = 'clerum.io/codex-connections'

export type ConfigStoreChangeHandler = (change: ConfigStoreChange) => void

export interface ConfigStoreOptions {
  /** Namespace where the watched resources live (default: mcp-host). */
  namespace: string
  /** This Host's hostRef — drives the per-Host CM/Secret names. */
  hostRef: string
  /** Name of the LLM Secret to watch — typically from CLERUM_LLM_SECRET_REF. */
  llmSecretRef: string | null
  /** Configured LLM provider — selects which key inside the LLM Secret is exposed. */
  provider: LlmProvider | null
  /** Assigned Codex grant; defaults to deployment-default. */
  connectionRef?: string | null
  /**
   * Name of the operator-managed LLM allowlist ConfigMap to watch (R3). When
   * null/undefined the fourth tier is disabled entirely (no watch, no bootstrap)
   * and {@link allowlistAvailable} stays false — preserves the 3-tier behavior.
   */
  allowlistConfigMapName?: string | null
  /**
   * R5 — extra credential-slot dataKeys (of the SAME LLM Secret) the failover
   * policy references: fallback `credentialSlot` overrides PLUS the normal slot
   * dataKeys of every fallback provider (for cross-provider fallbacks whose keys
   * the active-provider load below never touches). Their decoded values are
   * exposed ONLY via {@link fallbackSlotValue} — deliberately NEVER merged into
   * the effective env, so they can never reach a tool subprocess (spec §3-R5
   * step 2 + the by-source exclusion of §3-R4.3). Empty/undefined = no failover.
   */
  fallbackCredentialSlots?: string[]
  /** KubeConfig (default: loadFromDefault). Tests inject a fake. */
  kc?: k8s.KubeConfig
  /**
   * Inject K8s API clients for testing. When omitted, clients are built
   * from `kc`. Tests pass mocks here.
   */
  coreApi?: k8s.CoreV1Api
  watch?: k8s.Watch
}

// ─── ConfigStore ───────────────────────────────────────────────────────────

type SourceTier = 'host-secret' | 'host-cm' | 'llm-secret' | 'allowlist-cm'

interface Entry {
  value: string
  source: SourceTier
}

const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 30_000

/**
 * Decode a Secret data value if it looks base64-encoded. The K8s client lib
 * sometimes returns already-decoded values (CRD client, projected secret
 * mounts), sometimes raw base64. Mirror the heuristic from `k8sClient.ts`.
 */
function decodeSecretValue(raw: string): string {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    const reEncoded = Buffer.from(decoded).toString('base64')
    if (reEncoded === raw && decoded !== raw) {
      return decoded
    }
  } catch {
    // not base64 → fall through
  }
  return raw
}

export class ConfigStore {
  private readonly opts: ConfigStoreOptions
  private readonly coreApi: k8s.CoreV1Api
  private readonly watch: k8s.Watch
  private readonly handlers = new Set<ConfigStoreChangeHandler>()

  /** Per-source tables. The merge takes precedence: host-secret > host-cm > llm-secret. */
  private hostSecret: Map<string, string> = new Map()
  private hostCm: Map<string, string> = new Map()
  /**
   * The active provider's credential slots loaded from the LLM Secret, in
   * descriptor order (primary first). Multi-slot (R4): single-key providers
   * hold one entry, Bedrock two, Vertex one (its JSON). Empty when the Secret
   * is missing the relevant entries. `dataKey` keys the credentials bag handed
   * to the driver factory; `name` is the shell-style env var name.
   */
  private llmSlots: Array<{ dataKey: string; name: string; value: string }> = []

  /**
   * R5 — decoded values of the failover policy's referenced credential slots,
   * keyed by Secret dataKey (e.g. `claude-api-key-fb1`, or a cross-provider
   * `openai-api-key`). Loaded from the SAME LLM Secret as {@link llmSlots} but
   * kept in a SEPARATE map that is NEVER merged into {@link effective} — so a
   * fallback slot can never reach a tool subprocess env. Read via
   * {@link fallbackSlotValue} by the fallback provider factory in main.ts.
   */
  private fallbackSlotValues: Map<string, string> = new Map()

  /** Effective merged table, populated by `recompute()` after every source update. */
  private effective: Map<string, Entry> = new Map()

  /** Names of keys whose effective value comes from a Secret (LLM or per-Host). */
  private secretEffectiveKeys = new Set<string>()

  /** Active watch aborters keyed by source. */
  private watchAborters: Partial<Record<SourceTier, { abort: () => void }>> = {}
  /** Reconnect timers keyed by source. */
  private reconnectTimers: Partial<Record<SourceTier, ReturnType<typeof setTimeout>>> = {}
  /** Current reconnect backoff ms keyed by source. */
  private reconnectBackoff: Record<SourceTier, number> = {
    'host-secret': RECONNECT_INITIAL_MS,
    'host-cm': RECONNECT_INITIAL_MS,
    'llm-secret': RECONNECT_INITIAL_MS,
    'allowlist-cm': RECONNECT_INITIAL_MS,
  }
  private stopped = false

  // ─── Allowlist tier (R3) — orthogonal to the env merge above ─────────────
  /** Per-provider allowed models, parsed from the allowlist ConfigMap data. */
  private allowedModelsMap: Map<string, AllowedModelEntry[]> = new Map()
  /** True once a watch/bootstrap has delivered the allowlist CM (exists). */
  private allowlistDelivered = false
  /** Dedupe flag for the "CM absent" WARN + metric (fires once per transition). */
  private allowlistMissingWarned = false
  /** Catalog/credential pair from allowlist CM annotations, or null. */
  private codexBinding: CodexPolicyBinding | null = null

  constructor(opts: ConfigStoreOptions) {
    this.opts = opts
    const kc = opts.kc ?? new k8s.KubeConfig()
    if (!opts.kc && !opts.coreApi) {
      kc.loadFromDefault()
    }
    this.coreApi = opts.coreApi ?? kc.makeApiClient(k8s.CoreV1Api)
    this.watch = opts.watch ?? new k8s.Watch(kc)
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Initial list across the three sources, then start watches. Resolves once
   * the initial list has populated the in-memory tables; watches continue
   * delivering updates after that.
   */
  async start(): Promise<void> {
    await Promise.all([
      this.bootstrapLlmSecret(),
      this.bootstrapHostCm(),
      this.bootstrapHostSecret(),
      this.bootstrapAllowlistCm(),
    ])
    this.recompute()
    // Watches start even if a list returned 404 — kubelet may create the
    // resource later and ConfigStore should pick it up automatically.
    this.startWatch('llm-secret')
    this.startWatch('host-cm')
    this.startWatch('host-secret')
    this.startWatch('allowlist-cm')
  }

  /** Tear down watches and timers. */
  stop(): void {
    this.stopped = true
    for (const tier of Object.keys(this.watchAborters) as SourceTier[]) {
      this.watchAborters[tier]?.abort()
    }
    this.watchAborters = {}
    for (const tier of Object.keys(this.reconnectTimers) as SourceTier[]) {
      const t = this.reconnectTimers[tier]
      if (t) clearTimeout(t)
    }
    this.reconnectTimers = {}
    this.handlers.clear()
  }

  // ─── Public read API ─────────────────────────────────────────────────

  get(key: string): string | undefined {
    const entry = this.effective.get(key)
    if (entry) return entry.value
    return process.env[key]
  }

  /**
   * Effective merged snapshot keyed by shell-style env var name. INCLUDES the
   * LLM provider key, so this is for callers that legitimately need a full
   * view of the merged environment (status reporting, debugging).
   *
   * Subprocess spawns and any other code path that doesn't directly call the
   * LLM provider must use {@link userEnvSnapshot} instead — exposing the LLM
   * API key to a child shell would let any tool-call exfiltrate it.
   *
   * process.env values are NOT included — callers that want a full env must
   * spread `{ ...process.env, ...store.snapshot() }` themselves.
   */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of this.effective) out[k] = v.value
    return out
  }

  /**
   * Like {@link snapshot} but with the configured LLM provider's API key
   * filtered out. Use this when populating environments that the agent or
   * any tool can read — `shell_exec`, recipe sub-processes, etc.
   *
   * The LLM key is consumed only by the in-process LLM provider client,
   * which reads it via {@link llmKey}. No subprocess needs it.
   */
  userEnvSnapshot(): Record<string, string> {
    // Credential-exclusion boundary (spec §3-R4.3). Exclude, by TWO derivations:
    //  1. registry + platform: every provider's every credential slot env name
    //     (for ANY provider, present or not) plus the reserved platform tokens
    //     — RESERVED_SECRET_ENV_NAMES;
    //  2. by-source: every env key the LLM Secret tier actually loaded
    //     (`llmSlots`). Today this is a SUBSET of (1) — the loader only reads
    //     the active provider's registry-known slots, so it adds nothing yet.
    //     It is kept as a distinct, by-source rule because it derives from what
    //     was LOADED, not from the registry: when R5 extends the llm-secret
    //     load with dynamically-named fallback slots, they land in `llmSlots`
    //     and are excluded here automatically — the registry set (1) cannot
    //     know those names.
    // NEVER derive this from a single "active provider key" (primarySlot is
    // prohibited here): that would leak Bedrock's second slot / fallback slots.
    const out: Record<string, string> = {}
    for (const [k, v] of this.effective) {
      if (RESERVED_SECRET_ENV_NAMES.has(k)) continue
      if (this.llmSlots.some(s => s.name === k)) continue
      out[k] = v.value
    }
    return out
  }

  /**
   * The active provider's PRIMARY credential slot (translated to shell-style),
   * or null if the Secret is missing it. Always reflects the latest watched
   * state. Kept for single-key callers/back-compat; multi-slot callers use
   * {@link llmCredentials}.
   */
  llmKey(): { name: string; value: string } | null {
    const primary = this.llmSlots[0]
    return primary ? { name: primary.name, value: primary.value } : null
  }

  /**
   * The active provider id and its full credential bag (keyed by slot
   * `dataKey`), or null when no provider is configured or none of its slots are
   * present. Feeds the driver factory (a multi-slot provider like Bedrock
   * needs the whole bag).
   */
  llmCredentials(): { provider: LlmProvider; credentials: ProviderCredentials } | null {
    if (!this.opts.provider || this.llmSlots.length === 0) return null
    const credentials: ProviderCredentials = {}
    for (const s of this.llmSlots) credentials[s.dataKey] = s.value
    return { provider: this.opts.provider, credentials }
  }

  /**
   * R5 — decoded value of a failover policy credential slot (by Secret dataKey),
   * or undefined when absent. Used by the fallback provider factory to build a
   * fallback provider from the SAME LLM Secret. Never merged into the effective
   * env, so it cannot reach a subprocess.
   */
  fallbackSlotValue(dataKey: string): string | undefined {
    return this.fallbackSlotValues.get(dataKey)
  }

  /**
   * True when EVERY required credential slot of the active provider is present
   * and non-empty. Multi-slot (R4): Bedrock reports configured only once BOTH
   * AWS keys are present. Single-key providers are unchanged.
   */
  isLlmKeyConfigured(): boolean {
    if (!this.opts.provider) return false
    const loaded = new Set(this.llmSlots.filter(s => s.value.length > 0).map(s => s.dataKey))
    return descriptorFor(this.opts.provider).credentialSlots.every(
      slot => !slot.required || loaded.has(slot.dataKey)
    )
  }

  /**
   * Names of keys whose effective value came from a Secret. Used by callers
   * that want to redact / mask values originating from sensitive sources.
   */
  listSecretKeys(): string[] {
    return [...this.secretEffectiveKeys]
  }

  /**
   * All secret values (LLM key + per-Host secret entries) — for the output
   * sanitizer to redact from tool output. Never returned to the LLM directly.
   */
  listSecretValues(): string[] {
    const values: string[] = []
    for (const k of this.secretEffectiveKeys) {
      const e = this.effective.get(k)
      if (e && e.value.length > 0) values.push(e.value)
    }
    // R5 — the failover slot values live outside `effective`, but they are still
    // LLM credentials: redact them from tool output too (defense in depth; no
    // realistic path echoes them since they never enter a subprocess env).
    for (const v of this.fallbackSlotValues.values()) {
      if (v.length > 0) values.push(v)
    }
    return values
  }

  /**
   * Like `listSecretValues()` but pairs each value with its key name so the
   * sanitizer can emit `[REDACTED:<KEY>]` markers that point at the source.
   * Sorted by descending value length to defeat overlapping-substring attacks
   * (a longer secret containing a shorter one is masked first).
   */
  listSecretEntries(): Array<{ name: string; value: string }> {
    const out: Array<{ name: string; value: string }> = []
    for (const k of this.secretEffectiveKeys) {
      const e = this.effective.get(k)
      if (e && e.value.length > 0) out.push({ name: k, value: e.value })
    }
    // R5 — see listSecretValues: fallback slot values are LLM credentials too.
    for (const [name, value] of this.fallbackSlotValues) {
      if (value.length > 0) out.push({ name, value })
    }
    out.sort((a, b) => b.value.length - a.value.length)
    return out
  }

  /** Subscribe to change notifications. Returns an unsubscribe fn. */
  onChange(handler: ConfigStoreChangeHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  // ─── Allowlist read API (R3) ─────────────────────────────────────────

  /**
   * Per-provider allowed models from the operator allowlist ConfigMap. Keyed
   * by provider id (registry id, e.g. `openai`). Empty until the CM is
   * delivered; callers MUST gate on {@link allowlistAvailable} to distinguish
   * "no models allowed" from "allowlist not yet known" (degraded-explicit).
   */
  allowedModels(): ReadonlyMap<string, AllowedModelEntry[]> {
    return this.allowedModelsMap
  }

  /**
   * True once the allowlist ConfigMap has been delivered by a bootstrap read
   * or watch event. False when the CM does not exist yet or the tier is
   * disabled — the consumer then treats only the Host-configured model as
   * permitted (spec §3-R3.5).
   */
  allowlistAvailable(): boolean {
    return this.allowlistDelivered
  }

  /**
   * Live Codex catalog/credential revisions from the allowlist ConfigMap
   * annotations. Null when the CM is absent, the annotations are missing, or
   * either value is not an integer. Callers must still require catalogRevision
   * >= 1 before authorizing.
   */
  codexPolicyBinding(): CodexPolicyBinding | null {
    return this.codexBinding
  }

  // ─── Bootstrap (initial list) ────────────────────────────────────────

  private async bootstrapLlmSecret(): Promise<void> {
    if (!this.opts.llmSecretRef) return
    const data = await this.readSecretData(this.opts.llmSecretRef)
    if (!data) return
    this.applyLlmSecretData(data)
  }

  private async bootstrapHostCm(): Promise<void> {
    const name = this.hostCmName()
    if (!name) return
    try {
      const cm = await this.coreApi.readNamespacedConfigMap({
        name,
        namespace: this.opts.namespace,
      })
      const data = cm.data ?? {}
      this.hostCm = new Map(Object.entries(data))
    } catch (err) {
      if (errorCode(err) === 404) return
      console.warn(`[ConfigStore] readNamespacedConfigMap ${name} failed:`, err)
    }
  }

  private async bootstrapHostSecret(): Promise<void> {
    const name = this.hostSecretName()
    if (!name) return
    const data = await this.readSecretData(name)
    if (!data) return
    this.hostSecret = new Map(Object.entries(data).map(([k, v]) => [k, decodeSecretValue(v)]))
  }

  /**
   * (Re)read the allowlist CM. Returns whether the observable allowlist state
   * changed (content or availability) so the reconnect path can fire
   * `allowlistChanged` only on a real transition, not on every watch cycle.
   */
  private async bootstrapAllowlistCm(): Promise<boolean> {
    const name = this.opts.allowlistConfigMapName
    if (!name) return false
    try {
      const cm = await this.coreApi.readNamespacedConfigMap({
        name,
        namespace: this.opts.namespace,
      })
      const wasAvailable = this.allowlistDelivered
      const contentChanged = this.applyAllowlistConfigMap(cm)
      this.allowlistDelivered = true
      this.allowlistMissingWarned = false
      return contentChanged || !wasAvailable
    } catch (err) {
      if (errorCode(err) === 404) {
        return this.markAllowlistMissing()
      }
      console.warn(`[ConfigStore] readNamespacedConfigMap ${name} failed:`, err)
      return false
    }
  }

  /**
   * Parse models plus Codex catalog/credential annotations from the allowlist
   * ConfigMap. Returns whether either surface changed so annotation-only
   * catalog bumps still refresh Host chat's authorize binding.
   */
  private applyAllowlistConfigMap(cm: {
    data?: Record<string, string>
    metadata?: { annotations?: Record<string, string> }
  }): boolean {
    const modelsChanged = this.applyAllowlistData(cm.data ?? {})
    const nextBinding = parseCodexPolicyBinding(
      cm.metadata?.annotations,
      this.opts.connectionRef?.trim() || 'deployment-default'
    )
    const bindingChanged = !codexBindingsEqual(this.codexBinding, nextBinding)
    this.codexBinding = nextBinding
    return modelsChanged || bindingChanged
  }

  /**
   * Parse the allowlist ConfigMap data — one key per provider, value a JSON
   * array of {@link AllowedModelEntry}. Per-key fail-loud: a key with invalid
   * JSON (or a non-array / malformed entry) is logged at ERROR naming the key
   * and skipped, without tumbling the other providers (§13 per-row principle).
   *
   * Returns whether the parsed result differs from the current in-memory
   * allowlist — callers use this to notify subscribers only on a real content
   * change (so routine watch reconnects don't re-fire the R3.7 signal).
   */
  private applyAllowlistData(data: Record<string, string>): boolean {
    const next = new Map<string, AllowedModelEntry[]>()
    for (const [provider, raw] of Object.entries(data)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        // Log only the key and the error class — never the raw error/message: a
        // V8 SyntaxError can embed a snippet of the offending value. Mirrors the
        // deliberate no-log-value policy in WRC's modelConfigHandler parser.
        const errName = err instanceof Error ? err.name : 'ParseError'
        console.error(
          `[ConfigStore] allowlist key '${provider}' has invalid JSON (${errName}) — skipping`
        )
        continue
      }
      if (!Array.isArray(parsed)) {
        console.error(`[ConfigStore] allowlist key '${provider}' is not a JSON array — skipping`)
        continue
      }
      const entries: AllowedModelEntry[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          console.error(
            `[ConfigStore] allowlist key '${provider}' has a non-object entry — skipping it`
          )
          continue
        }
        const rec = item as Record<string, unknown>
        if (typeof rec.model !== 'string' || rec.model.length === 0) {
          console.error(
            `[ConfigStore] allowlist key '${provider}' has an entry without a model — skipping it`
          )
          continue
        }
        const entry: AllowedModelEntry = { model: rec.model }
        if (typeof rec.displayName === 'string') entry.displayName = rec.displayName
        // Optional, operator-declared: accept only a positive integer; drop
        // NaN/Infinity/negatives silently (it is metadata, not part of the
        // allow/deny decision).
        if (Number.isInteger(rec.contextWindowTokens) && (rec.contextWindowTokens as number) > 0) {
          entry.contextWindowTokens = rec.contextWindowTokens as number
        }
        if (typeof rec.vendor === 'string') entry.vendor = rec.vendor
        entries.push(entry)
      }
      next.set(provider, entries)
    }
    const changed = !allowlistMapsEqual(this.allowedModelsMap, next)
    this.allowedModelsMap = next
    return changed
  }

  /**
   * Transition into "allowlist CM absent" — clear the parsed models and, once
   * per transition, emit the degraded-explicit WARN + metric. Returns whether
   * this was an actual availability transition (was delivered → now missing),
   * so callers fire `allowlistChanged` only on the real edge.
   */
  private markAllowlistMissing(): boolean {
    const wasAvailable = this.allowlistDelivered
    this.allowlistDelivered = false
    this.allowedModelsMap = new Map()
    this.codexBinding = null
    if (!this.allowlistMissingWarned) {
      this.allowlistMissingWarned = true
      llmAllowlistMissingTotal.inc()
      console.warn(
        '[ConfigStore] LLM allowlist ConfigMap absent — degraded-explicit mode (only the Host-configured model is treated as permitted)'
      )
    }
    return wasAvailable
  }

  private async readSecretData(name: string): Promise<Record<string, string> | null> {
    try {
      const sec = await this.coreApi.readNamespacedSecret({
        name,
        namespace: this.opts.namespace,
      })
      return (sec.data ?? {}) as Record<string, string>
    } catch (err) {
      if (errorCode(err) === 404) return null
      console.warn(`[ConfigStore] readNamespacedSecret ${name} failed:`, err)
      return null
    }
  }

  // ─── Watch wiring ────────────────────────────────────────────────────

  private startWatch(tier: SourceTier): void {
    if (this.stopped) return
    const ctx = this.watchContext(tier)
    if (!ctx) return
    const { path, name } = ctx

    const onEvent = (type: string, obj: KubeObject): void => {
      if (this.stopped) return
      // fieldSelector should already filter, but guard anyway.
      if (obj?.metadata?.name !== name) return
      this.applyWatchEvent(tier, type, obj)
      // Successful event → reset backoff for this tier.
      this.reconnectBackoff[tier] = RECONNECT_INITIAL_MS
    }

    const onDone = (err: Error | null | undefined): void => {
      this.watchAborters[tier] = undefined
      if (this.stopped) return
      const reason = err ? err.message : 'closed'
      console.log(`[ConfigStore] watch ${tier}/${name} ended (${reason}); reconnecting`)
      this.scheduleReconnect(tier)
    }

    this.watch
      .watch(path, { fieldSelector: `metadata.name=${name}` }, onEvent, onDone)
      .then(req => {
        if (this.stopped) {
          ;(req as { abort: () => void }).abort()
          return
        }
        this.watchAborters[tier] = req as { abort: () => void }
      })
      .catch((err: unknown) => {
        if (this.stopped) return
        console.warn(`[ConfigStore] watch ${tier}/${name} failed to start:`, err)
        this.scheduleReconnect(tier)
      })
  }

  private scheduleReconnect(tier: SourceTier): void {
    if (this.stopped) return
    const delay = this.reconnectBackoff[tier]
    this.reconnectBackoff[tier] = Math.min(delay * 2, RECONNECT_MAX_MS)
    this.reconnectTimers[tier] = setTimeout(() => {
      this.reconnectTimers[tier] = undefined
      // Refresh state via list before resubscribing — handles "watch too old"
      // and keeps us correct after extended disconnects.
      const refresh: Promise<void | boolean> =
        tier === 'llm-secret'
          ? this.bootstrapLlmSecret()
          : tier === 'host-cm'
            ? this.bootstrapHostCm()
            : tier === 'host-secret'
              ? this.bootstrapHostSecret()
              : this.bootstrapAllowlistCm()
      void (async () => {
        let allowlistChanged = false
        try {
          allowlistChanged = (await refresh) === true
        } catch {
          // Bootstrap already logs its own failures; fall through to resubscribe.
        }
        // The allowlist tier is orthogonal to the env merge: notify its own
        // subscribers, but only when the refresh actually changed state. The env
        // tiers go through recompute(), which already diff-gates its own emit.
        if (tier === 'allowlist-cm') {
          if (allowlistChanged) this.fireAllowlistChanged()
        } else {
          this.recompute()
        }
        this.startWatch(tier)
      })()
    }, delay)
  }

  private applyWatchEvent(tier: SourceTier, type: string, obj: KubeObject): void {
    if (tier === 'allowlist-cm') {
      if (type === 'DELETED') {
        if (this.markAllowlistMissing()) this.fireAllowlistChanged()
        return
      }
      if (type !== 'ADDED' && type !== 'MODIFIED') return
      const wasAvailable = this.allowlistDelivered
      const contentChanged = this.applyAllowlistConfigMap(obj)
      this.allowlistDelivered = true
      this.allowlistMissingWarned = false
      // Only notify subscribers on a real transition — a re-delivered,
      // byte-identical CM (routine watch churn) must not re-fire the signal.
      if (contentChanged || !wasAvailable) this.fireAllowlistChanged()
      return
    }
    if (type === 'DELETED') {
      if (tier === 'llm-secret') {
        this.llmSlots = []
        this.fallbackSlotValues = new Map()
      } else if (tier === 'host-cm') this.hostCm.clear()
      else this.hostSecret.clear()
      this.recompute()
      return
    }
    if (type !== 'ADDED' && type !== 'MODIFIED') return
    if (tier === 'llm-secret') {
      this.applyLlmSecretData((obj.data as Record<string, string> | undefined) ?? {})
    } else if (tier === 'host-cm') {
      this.hostCm = new Map(Object.entries((obj.data as Record<string, string> | undefined) ?? {}))
    } else {
      const data = (obj.data as Record<string, string> | undefined) ?? {}
      this.hostSecret = new Map(Object.entries(data).map(([k, v]) => [k, decodeSecretValue(v)]))
    }
    this.recompute()
  }

  private applyLlmSecretData(data: Record<string, string>): void {
    // R5 — load the failover policy's referenced slots FIRST (independent of the
    // active provider). These are kept out of `effective` entirely (see
    // `fallbackSlotValues` doc) so they never reach a subprocess.
    this.fallbackSlotValues = new Map()
    for (const dataKey of this.opts.fallbackCredentialSlots ?? []) {
      const raw = data[dataKey]
      if (!raw) continue
      const value = decodeSecretValue(raw)
      if (value) this.fallbackSlotValues.set(dataKey, value)
    }

    this.llmSlots = []
    if (!this.opts.provider) return
    // Load EVERY slot of the active provider (multi-slot, R4). A missing or
    // empty slot is simply omitted; `isLlmKeyConfigured` decides completeness.
    for (const slot of descriptorFor(this.opts.provider).credentialSlots) {
      const raw = data[slot.dataKey]
      if (!raw) continue
      const value = decodeSecretValue(raw)
      if (!value) continue
      this.llmSlots.push({ dataKey: slot.dataKey, name: slot.envName, value })
    }
  }

  // ─── Effective merge + change detection ──────────────────────────────

  private recompute(): void {
    const previous = this.effective
    // The active provider's slot env-var names (stable per configured provider,
    // regardless of which slots are currently loaded). Multi-slot (R4): a
    // change to ANY of them is an llmKeyChanged, and ALL are excluded from the
    // env-diff below (they are reported via llmKeyChanged, not envChanged).
    const slotNames = this.opts.provider
      ? descriptorFor(this.opts.provider).credentialSlots.map(s => s.envName)
      : []
    const previousSig = llmSlotSignature(previous, slotNames)

    const next: Map<string, Entry> = new Map()
    const nextSecretKeys = new Set<string>()

    // Lowest precedence first (LLM secret), then ConfigMap, then per-Host secret.
    for (const slot of this.llmSlots) {
      next.set(slot.name, { value: slot.value, source: 'llm-secret' })
      nextSecretKeys.add(slot.name)
    }
    for (const [k, v] of this.hostCm) {
      next.set(k, { value: v, source: 'host-cm' })
      nextSecretKeys.delete(k) // CM entries override secret status if same key
    }
    for (const [k, v] of this.hostSecret) {
      next.set(k, { value: v, source: 'host-secret' })
      nextSecretKeys.add(k)
    }

    this.effective = next
    this.secretEffectiveKeys = nextSecretKeys

    const currentSig = llmSlotSignature(next, slotNames)
    const llmKeyChanged = previousSig !== currentSig

    let envChanged = false
    // Compare envs excluding the LLM slot keys (those are reported separately).
    if (!sameMapExcept(previous, next, slotNames)) envChanged = true

    if (llmKeyChanged || envChanged) {
      this.emit({ llmKeyChanged, envChanged, allowlistChanged: false })
    }
  }

  /** Notify subscribers that the allowlist tier (R3) changed. */
  private fireAllowlistChanged(): void {
    this.emit({ llmKeyChanged: false, envChanged: false, allowlistChanged: true })
  }

  /** Dispatch a change to all subscribers, isolating handler throws. */
  private emit(change: ConfigStoreChange): void {
    for (const h of this.handlers) {
      try {
        h(change)
      } catch (err) {
        console.warn('[ConfigStore] onChange handler threw:', err)
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private hostCmName(): string {
    return `host-${this.opts.hostRef}-env`
  }

  private hostSecretName(): string {
    return `host-${this.opts.hostRef}-env-secret`
  }

  private watchContext(tier: SourceTier): { path: string; name: string } | null {
    if (tier === 'llm-secret') {
      if (!this.opts.llmSecretRef) return null
      return {
        path: `/api/v1/namespaces/${this.opts.namespace}/secrets`,
        name: this.opts.llmSecretRef,
      }
    }
    if (tier === 'host-cm') {
      return {
        path: `/api/v1/namespaces/${this.opts.namespace}/configmaps`,
        name: this.hostCmName(),
      }
    }
    if (tier === 'allowlist-cm') {
      if (!this.opts.allowlistConfigMapName) return null
      return {
        path: `/api/v1/namespaces/${this.opts.namespace}/configmaps`,
        name: this.opts.allowlistConfigMapName,
      }
    }
    return {
      path: `/api/v1/namespaces/${this.opts.namespace}/secrets`,
      name: this.hostSecretName(),
    }
  }
}

interface KubeObject {
  metadata?: { name?: string; annotations?: Record<string, string> }
  data?: Record<string, string>
}

function parseOptionalIntegerAnnotation(
  annotations: Record<string, string>,
  key: string
): number | null | 'invalid' {
  if (!(key in annotations)) return null
  const parsed = Number(annotations[key])
  return Number.isInteger(parsed) ? parsed : 'invalid'
}

function parseCodexPolicyBinding(
  annotations: Record<string, string> | undefined,
  connectionKey = 'deployment-default'
): CodexPolicyBinding | null {
  if (!annotations) return null
  let catalogRevision = parseOptionalIntegerAnnotation(annotations, CATALOG_REVISION_ANNOTATION)
  let credentialRevision = parseOptionalIntegerAnnotation(
    annotations,
    CONNECTION_REVISION_ANNOTATION
  )
  const rawMap = annotations[CODEX_CONNECTIONS_ANNOTATION]
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap) as Record<
        string,
        { catalogRevision?: number; connectionRevision?: number }
      >
      const assigned = parsed[connectionKey]
      if (
        assigned &&
        Number.isInteger(assigned.catalogRevision) &&
        Number.isInteger(assigned.connectionRevision)
      ) {
        catalogRevision = assigned.catalogRevision as number
        credentialRevision = assigned.connectionRevision as number
      }
    } catch {
      return null
    }
  }
  if (
    catalogRevision === null ||
    catalogRevision === 'invalid' ||
    credentialRevision === null ||
    credentialRevision === 'invalid'
  ) {
    return null
  }
  return { catalogRevision, credentialRevision, connectionKey }
}

function codexBindingsEqual(a: CodexPolicyBinding | null, b: CodexPolicyBinding | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.catalogRevision === b.catalogRevision &&
    a.credentialRevision === b.credentialRevision &&
    a.connectionKey === b.connectionKey
  )
}

/**
 * Deep, order-sensitive equality for two parsed allowlist maps. Used to decide
 * whether a re-delivered allowlist ConfigMap actually changed (so routine watch
 * churn doesn't re-fire the R3.7 signal). Order is significant — it is the
 * operator-declared display order carried straight from the CM.
 */
function allowlistMapsEqual(
  a: Map<string, AllowedModelEntry[]>,
  b: Map<string, AllowedModelEntry[]>
): boolean {
  if (a.size !== b.size) return false
  for (const [provider, aEntries] of a) {
    const bEntries = b.get(provider)
    if (!bEntries || bEntries.length !== aEntries.length) return false
    for (let i = 0; i < aEntries.length; i++) {
      const x = aEntries[i]
      const y = bEntries[i]
      if (
        x.model !== y.model ||
        x.displayName !== y.displayName ||
        x.contextWindowTokens !== y.contextWindowTokens ||
        x.vendor !== y.vendor
      ) {
        return false
      }
    }
  }
  return true
}

function errorCode(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } }
    if (typeof e.code === 'number') return e.code
    if (typeof e.statusCode === 'number') return e.statusCode
    if (typeof e.response?.statusCode === 'number') return e.response.statusCode
  }
  return undefined
}

/**
 * Signature of the active provider's LLM slot values in `map`, in slot order.
 * Used to detect an llmKeyChanged across ALL slots (multi-slot, R4) — any slot
 * added/removed/rotated changes the signature. NUL is a safe joiner (never
 * appears in a decoded secret env value).
 */
function llmSlotSignature(map: Map<string, Entry>, slotNames: string[]): string {
  return slotNames.map(n => map.get(n)?.value ?? '').join('\u0000')
}

function sameMapExcept(
  a: Map<string, Entry>,
  b: Map<string, Entry>,
  exceptKeys: string[]
): boolean {
  // Compare on key+value, ignoring `exceptKeys` and the source tier.
  const skip = new Set(exceptKeys)
  let aSize = a.size
  let bSize = b.size
  for (const key of skip) {
    if (a.has(key)) aSize -= 1
    if (b.has(key)) bSize -= 1
  }
  if (aSize !== bSize) return false
  for (const [k, v] of a) {
    if (skip.has(k)) continue
    const other = b.get(k)
    if (!other || other.value !== v.value) return false
  }
  return true
}
