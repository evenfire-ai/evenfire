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
import { ALL_PROVIDERS, type LlmProvider, descriptorFor } from '../llm/registryCore'

// ─── Provider mapping ──────────────────────────────────────────────────────

// Re-export so existing importers of `LlmProvider` from configStore keep working.
export type { LlmProvider }

/**
 * Lowercase-hyphen data key used inside the LLM Secret per provider.
 * Derived from the registry (single source of truth) so it cannot drift from
 * the external Secret contract.
 */
const PROVIDER_DATA_KEY = Object.fromEntries(
  ALL_PROVIDERS.map(p => [p, descriptorFor(p).dataKey])
) as Record<LlmProvider, string>

/**
 * Shell-style env var name per provider — what mcp-host code expects to read.
 * Derived from the registry (single source of truth). Exported so the
 * shell-tool env boundary (agentToolEnv.ts) and its lock test can reference
 * the exact env-var names that must never reach a tool subprocess.
 */
export const PROVIDER_ENV_NAME = Object.fromEntries(
  ALL_PROVIDERS.map(p => [p, descriptorFor(p).envName])
) as Record<LlmProvider, string>

/**
 * Reverse: any of the provider env var names (derived from the registry, so it
 * tracks the provider set). Used by the sanitizer when matching the LLM Secret's
 * contributed key.
 */
export const PROVIDER_ENV_NAMES: ReadonlySet<string> = new Set(Object.values(PROVIDER_ENV_NAME))

/**
 * Env var names that must NEVER be logged or surfaced through
 * clerum__get_capabilities (plan §3.5). Plugin Workload SDK credentials
 * join the provider keys in the redaction set.
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
}

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

type SourceTier = 'host-secret' | 'host-cm' | 'llm-secret'

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
  /** The single provider-matching key from the LLM Secret, if present. */
  private llmKeyEntry: { name: string; value: string } | null = null

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
  }
  private stopped = false

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
    ])
    this.recompute()
    // Watches start even if a list returned 404 — kubelet may create the
    // resource later and ConfigStore should pick it up automatically.
    this.startWatch('llm-secret')
    this.startWatch('host-cm')
    this.startWatch('host-secret')
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
    const llmName = this.opts.provider ? PROVIDER_ENV_NAME[this.opts.provider] : null
    const out: Record<string, string> = {}
    for (const [k, v] of this.effective) {
      if (llmName && k === llmName) continue
      out[k] = v.value
    }
    return out
  }

  /**
   * The provider key (translated to shell-style) currently in the LLM Secret,
   * or null if the Secret is missing the relevant entry. Always reflects the
   * latest watched state.
   */
  llmKey(): { name: string; value: string } | null {
    return this.llmKeyEntry ? { ...this.llmKeyEntry } : null
  }

  isLlmKeyConfigured(): boolean {
    return this.llmKeyEntry !== null && this.llmKeyEntry.value.length > 0
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
      const refresh =
        tier === 'llm-secret'
          ? this.bootstrapLlmSecret()
          : tier === 'host-cm'
            ? this.bootstrapHostCm()
            : this.bootstrapHostSecret()
      void refresh
        .catch(() => undefined)
        .finally(() => {
          this.recompute()
          this.startWatch(tier)
        })
    }, delay)
  }

  private applyWatchEvent(tier: SourceTier, type: string, obj: KubeObject): void {
    if (type === 'DELETED') {
      if (tier === 'llm-secret') this.llmKeyEntry = null
      else if (tier === 'host-cm') this.hostCm.clear()
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
    if (!this.opts.provider) {
      this.llmKeyEntry = null
      return
    }
    const dataKey = PROVIDER_DATA_KEY[this.opts.provider]
    const envName = PROVIDER_ENV_NAME[this.opts.provider]
    const raw = data[dataKey]
    if (!raw) {
      this.llmKeyEntry = null
      return
    }
    const value = decodeSecretValue(raw)
    if (!value) {
      this.llmKeyEntry = null
      return
    }
    this.llmKeyEntry = { name: envName, value }
  }

  // ─── Effective merge + change detection ──────────────────────────────

  private recompute(): void {
    const previous = this.effective
    const previousLlm = previous.get(
      this.opts.provider ? PROVIDER_ENV_NAME[this.opts.provider] : ''
    )
    const next: Map<string, Entry> = new Map()
    const nextSecretKeys = new Set<string>()

    // Lowest precedence first (LLM secret), then ConfigMap, then per-Host secret.
    if (this.llmKeyEntry) {
      next.set(this.llmKeyEntry.name, { value: this.llmKeyEntry.value, source: 'llm-secret' })
      nextSecretKeys.add(this.llmKeyEntry.name)
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

    const llmName = this.opts.provider ? PROVIDER_ENV_NAME[this.opts.provider] : null
    const currentLlm = llmName ? next.get(llmName) : undefined
    const llmKeyChanged = (previousLlm?.value ?? null) !== (currentLlm?.value ?? null)

    let envChanged = false
    // Compare envs excluding the LLM key (that's reported separately).
    if (!sameMapExcept(previous, next, llmName)) envChanged = true

    if (llmKeyChanged || envChanged) {
      const change: ConfigStoreChange = { llmKeyChanged, envChanged }
      for (const h of this.handlers) {
        try {
          h(change)
        } catch (err) {
          console.warn('[ConfigStore] onChange handler threw:', err)
        }
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
    return {
      path: `/api/v1/namespaces/${this.opts.namespace}/secrets`,
      name: this.hostSecretName(),
    }
  }
}

interface KubeObject {
  metadata?: { name?: string }
  data?: Record<string, string>
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

function sameMapExcept(
  a: Map<string, Entry>,
  b: Map<string, Entry>,
  exceptKey: string | null
): boolean {
  // Compare on key+value, ignoring `exceptKey` and the source tier.
  let aSize = a.size
  let bSize = b.size
  if (exceptKey !== null) {
    if (a.has(exceptKey)) aSize -= 1
    if (b.has(exceptKey)) bSize -= 1
  }
  if (aSize !== bSize) return false
  for (const [k, v] of a) {
    if (k === exceptKey) continue
    const other = b.get(k)
    if (!other || other.value !== v.value) return false
  }
  return true
}
