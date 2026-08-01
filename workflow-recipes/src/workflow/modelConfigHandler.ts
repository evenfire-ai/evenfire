/**
 * Model Config Handler — WRC-side Secret Broker for workflow model hot-swap.
 *
 * The coordinator sends { provider, model, stepId } (never apiKey).
 * WRC resolves the API key from K8s Secrets and forwards to mcp_host.
 *
 * Security invariant: workflow model credentials travel only on the WRC→mcp_host
 * configure request and are never returned to the coordinator. Plugin Workload
 * SDK bootstrap is identity-only; its prompt credentials stay behind the
 * per-attempt broker.
 */
import { PROVIDER_CREDENTIAL_SLOTS, isLlmProviderId } from '@clerum/llm-providers'
import { createLogger } from '../observability/logger'

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Provider-fallback (R5 F6). One ordered fallback the step may switch to. The
 * broker resolves `credentialSlot` (a key of the SAME provider Secret, e.g.
 * `claude-api-key-fb1`; absent = the provider's default mapped key) into the
 * actual credential and forwards it on the mcp-host `configure` leg only — the
 * slot name, like the primary key, never returns to the coordinator.
 */
export interface FallbackModelEntry {
  provider: string
  model: string
  credentialSlot?: string
}

export interface ConfigureModelRequest {
  stepId: string
  provider: string
  model: string
  soulStorageRef?: {
    bucket: string
    key: string
  }
  /**
   * Provider-fallback (R5 F6). Ordered failover list for this step. When
   * present and the allowlist permits an entry, the broker resolves its
   * credential and forwards a resolved `llmPolicy` to mcp-host. Absent = no
   * failover (today's behaviour). See {@link ModelConfigHandler.handle}.
   */
  fallbacks?: FallbackModelEntry[]
  cooldownSeconds?: number
  triggerOn?: string[]
}

export interface ConfigureModelResult {
  status: number
  body: Record<string, unknown>
}

export interface PluginSdkCredentialTarget {
  targetRef: string
  provider: string
  model: string
  credentialSlot: string
}

/**
 * Result of a presence-aware ConfigMap read. Distinguishes "the CM does not
 * exist" (404) from "the CM exists but its `data` is empty/omitted" — a
 * distinction `readConfigMap` (which collapses both to `null`) cannot express.
 * The allowlist gate needs it: an existing-but-empty CM must deny-all, whereas
 * an absent CM drops into degraded mode. See {@link ModelConfigHandler.handle}.
 */
export type ConfigMapPresence = { exists: false } | { exists: true; data: Record<string, string> }

export interface K8sSecretReader {
  readConfigMap(namespace: string, name: string): Promise<Record<string, string> | null>
  /**
   * Like {@link readConfigMap} but preserves the exists-vs-empty distinction:
   * `{ exists: false }` ONLY on a real 404; `{ exists: true, data }` (with an
   * empty object when `data` is omitted) when the CM object exists. Other
   * errors propagate. Used exclusively for the allowlist read.
   */
  readConfigMapWithPresence(namespace: string, name: string): Promise<ConfigMapPresence>
  readSecret(namespace: string, name: string): Promise<Record<string, string> | null>
}

export interface McpHostClient {
  configure(
    endpoint: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }>
  /** Publish only the public provider/model bootstrap identity for SDK mode. */
  configurePluginWorkloadSdkBootstrap?(
    endpoint: string,
    token: string,
    body: { provider: string; model: string }
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

export interface ObjectStorageReader {
  download(bucket: string, key: string): Promise<string | null>
}

/**
 * Optional hook invoked ONLY when the allowlist ConfigMap is absent (degraded
 * mode). It lets the caller enforce the R3.5 fallback ("only the declared step
 * model is permitted") without the broker needing recipe context. Returns an
 * error result to reject, or `null` to allow the request to proceed.
 */
export type DegradedModeValidator = () => Promise<ConfigureModelResult | null>

export interface HandleOptions {
  /** Enforced only when the allowlist ConfigMap does not exist (see R3.5). */
  validateDegraded?: DegradedModeValidator
}

// ─── Handler ────────────────────────────────────────────────────────────

const CONFIGMAP_NAME = 'clerum-model-secret-mapping'
// R3: operator-declared allowlist, materialized by control-api in the same
// namespace as the model-secret mapping (both keyed by provider). May be absent
// during rollout — see the degraded-mode semantics in `handle()`.
//
// CROSS-SERVICE CONTRACT: this name + namespace is one of three touchpoints on
// the allowlist ConfigMap. The producer is control-api
// (control-api/src/services/llmAllowedModelsConfigMap.ts, buildConfigMapData);
// the other consumer is mcp-host (mcp-host/src/config.ts,
// CLERUM_LLM_ALLOWED_MODELS_CM). Keep the name/namespace/data format in sync.
const ALLOWLIST_CONFIGMAP_NAME = 'clerum-llm-allowed-models'
const DEFAULT_CONFIGMAP_NAMESPACE = 'mcp-host'
// CROSS-SERVICE CONTRACT: must resolve to control-api's target namespace
// (CONTROL_API_HOSTS_NAMESPACE, default `mcp-host`) where the allowlist CM is
// written. Overridable via CLERUM_MODEL_CONFIG_NAMESPACE for non-default topologies.
const CONFIGMAP_NAMESPACE = process.env.CLERUM_MODEL_CONFIG_NAMESPACE ?? DEFAULT_CONFIGMAP_NAMESPACE

/**
 * Tolerant parse of one provider's allowlist entry: a JSON array of
 * `{ model: string, ... }`. A missing or corrupt entry yields an EMPTY set so
 * the provider is treated as having no allowed models (fail-closed for that
 * provider) rather than throwing or leaking into other providers. Corrupt data
 * is logged (never the value itself, to avoid leaking anything unexpected).
 */
function parseAllowedModels(raw: string | undefined, provider: string): Set<string> {
  const allowed = new Set<string>()
  if (raw === undefined) return allowed
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // ERROR to match mcp-host's configStore.applyAllowlistData for the same
    // corrupt-key event. Never log the value/parse error itself (a V8
    // SyntaxError can embed a snippet of the raw value).
    createLogger('wrc', 'model-config-handler').error(
      'Allowlist entry is not valid JSON — treating provider as having no allowed models',
      { provider }
    )
    return allowed
  }
  if (!Array.isArray(parsed)) {
    createLogger('wrc', 'model-config-handler').error(
      'Allowlist entry is not a JSON array — treating provider as having no allowed models',
      { provider }
    )
    return allowed
  }
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { model?: unknown }).model === 'string' &&
      (entry as { model: string }).model.length > 0
    ) {
      allowed.add((entry as { model: string }).model)
    }
  }
  return allowed
}

export class ModelConfigHandler {
  constructor(
    private readonly k8s: K8sSecretReader,
    private readonly mcpHost: McpHostClient,
    private readonly objectStorage?: ObjectStorageReader
  ) {}

  /**
   * Publish an SDK host's public bootstrap binding without resolving a Secret.
   * Prompt credentials are resolved by the per-attempt broker instead; using
   * the normal workflow `handle()` path here would load and forward a provider
   * key into the eager mcp-host.
   */
  async configurePluginWorkloadSdkBootstrap(
    provider: string,
    model: string,
    mcpHostEndpoint: string,
    wrcConfigureToken: string
  ): Promise<ConfigureModelResult> {
    const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/
    if (!isLlmProviderId(provider) || !MODEL_PATTERN.test(model)) {
      return { status: 400, body: { error: 'Invalid Plugin Workload SDK bootstrap target' } }
    }
    if (!this.mcpHost.configurePluginWorkloadSdkBootstrap) {
      return { status: 503, body: { error: 'Plugin Workload SDK bootstrap unavailable' } }
    }
    try {
      const result = await this.mcpHost.configurePluginWorkloadSdkBootstrap(
        mcpHostEndpoint,
        wrcConfigureToken,
        { provider, model }
      )
      if (result.status >= 400) {
        return { status: 502, body: { error: 'mcp_host bootstrap failed' } }
      }
      return { status: 202, body: { configured: true, provider, model } }
    } catch {
      return { status: 502, body: { error: 'mcp_host bootstrap unreachable' } }
    }
  }

  /**
   * Resolve exactly one ticket-authorized Plugin Workload SDK target. Unlike
   * workflow `/configure`, this path has no degraded mode and never skips a
   * missing slot: configuration failures are terminal for the current attempt.
   */
  async resolvePluginSdkCredential(
    target: PluginSdkCredentialTarget
  ): Promise<ConfigureModelResult> {
    const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/
    const SECRET_KEY_PATTERN = /^[A-Za-z0-9._-]{1,253}$/
    if (
      !isLlmProviderId(target.provider) ||
      !MODEL_PATTERN.test(target.model) ||
      !SECRET_KEY_PATTERN.test(target.credentialSlot)
    ) {
      return { status: 400, body: { error: 'Invalid credential target' } }
    }

    const slots = PROVIDER_CREDENTIAL_SLOTS[target.provider]
    const canonicalDataKeys = slots.map(slot => slot.dataKey)
    const singleSlotProvider = slots.length === 1
    const slotBelongsToProvider = canonicalDataKeys.some(
      dataKey =>
        target.credentialSlot === dataKey || target.credentialSlot.startsWith(`${dataKey}-`)
    )
    if (
      !slotBelongsToProvider ||
      (!singleSlotProvider && !canonicalDataKeys.includes(target.credentialSlot))
    ) {
      return { status: 400, body: { error: 'Invalid credential target' } }
    }

    // SDK prompt targets are reviewed operator policy. Absence of the global
    // allowlist must fail closed here; workflow degraded-mode semantics do not
    // apply to a cross-provider SDK request.
    const allowlistCm = await this.k8s.readConfigMapWithPresence(
      CONFIGMAP_NAMESPACE,
      ALLOWLIST_CONFIGMAP_NAME
    )
    if (!allowlistCm.exists) {
      return { status: 503, body: { error: 'Provider configuration unavailable' } }
    }
    const allowed = parseAllowedModels(allowlistCm.data[target.provider], target.provider)
    if (!allowed.has(target.model)) {
      return { status: 403, body: { error: 'Provider target is not enabled' } }
    }

    const configMap = await this.k8s.readConfigMap(CONFIGMAP_NAMESPACE, CONFIGMAP_NAME)
    if (!configMap) {
      return { status: 503, body: { error: 'Provider configuration unavailable' } }
    }
    const mapping = configMap[target.provider] ?? configMap[`${target.provider}__${target.model}`]
    if (!mapping) {
      return { status: 503, body: { error: 'Provider configuration unavailable' } }
    }
    const slash = mapping.indexOf('/')
    if (slash <= 0 || slash === mapping.length - 1) {
      return { status: 503, body: { error: 'Provider configuration unavailable' } }
    }
    const secretName = mapping.slice(0, slash)
    const secret = await this.k8s.readSecret(CONFIGMAP_NAMESPACE, secretName)
    if (!secret) {
      return { status: 503, body: { error: 'Provider configuration unavailable' } }
    }

    const credentials: Record<string, string> = {}
    for (const [index, slot] of slots.entries()) {
      const sourceKey = singleSlotProvider && index === 0 ? target.credentialSlot : slot.dataKey
      const value = Object.prototype.hasOwnProperty.call(secret, sourceKey)
        ? secret[sourceKey]
        : undefined
      if (typeof value !== 'string' || value.length === 0) {
        return { status: 503, body: { error: 'Provider configuration unavailable' } }
      }
      credentials[slot.dataKey] = value
    }

    return {
      status: 200,
      body: {
        provider: target.provider,
        model: target.model,
        credentialSlot: target.credentialSlot,
        credentials,
        llmSecretName: secretName,
      },
    }
  }

  async handle(
    req: ConfigureModelRequest,
    mcpHostEndpoint: string,
    wrcConfigureToken: string,
    opts?: HandleOptions
  ): Promise<ConfigureModelResult> {
    // Canonical provider set lives in @clerum/llm-providers (R4). The guard is
    // prototype-safe (own-property check), so req.provider='constructor' etc.
    // is rejected here rather than passing validation.
    if (!isLlmProviderId(req.provider)) {
      return { status: 400, body: { error: 'Invalid provider' } }
    }
    const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/
    if (!MODEL_PATTERN.test(req.model)) {
      return { status: 400, body: { error: 'Invalid model name' } }
    }

    // 0. Allowlist gate (R3). The operator declares, per provider, which models
    // may be used. This recovers the model gate that R1 removed (spec §1.1).
    //   - ConfigMap exists   → enforce `model ∈ allowlist[provider]`, else 403.
    //     An existing CM with empty/omitted data denies ALL models (a declared
    //     allowlist with zero enabled rows is deny-all, not degraded) — this is
    //     why we read with presence: control-api materializes `data: {}` (which
    //     kube-apiserver then omits) for an empty allowlist, and collapsing that
    //     to `null` would silently fail OPEN into degraded mode.
    //   - ConfigMap absent   → degraded mode (R3.5): only the declared step
    //     model is permitted. The broker has no recipe context, so the caller
    //     enforces this via `opts.validateDegraded` (configure-model path); the
    //     SDK injection path already validated the declared model upstream.
    const allowlistCm = await this.k8s.readConfigMapWithPresence(
      CONFIGMAP_NAMESPACE,
      ALLOWLIST_CONFIGMAP_NAME
    )
    if (allowlistCm.exists) {
      const allowed = parseAllowedModels(allowlistCm.data[req.provider], req.provider)
      if (!allowed.has(req.model)) {
        return {
          status: 403,
          body: {
            error: 'Model not allowed for provider',
            code: 'model_not_allowed',
            provider: req.provider,
            model: req.model,
          },
        }
      }
    } else {
      createLogger('wrc', 'model-config-handler').warn(
        'Allowlist ConfigMap absent — degraded mode: only the declared step model is permitted',
        { provider: req.provider, model: req.model, stepId: req.stepId }
      )
      if (opts?.validateDegraded) {
        const degradedError = await opts.validateDegraded()
        if (degradedError) return degradedError
      }
    }

    // 1. Read ConfigMap to resolve provider/model → secretName
    const configMap = await this.k8s.readConfigMap(CONFIGMAP_NAMESPACE, CONFIGMAP_NAME)
    if (!configMap) {
      return { status: 500, body: { error: 'ConfigMap not found', configMap: CONFIGMAP_NAME } }
    }

    // 2. Resolve the primary credential (provider → Secret → apiKey).
    const primary = await this.resolveCredential(configMap, req.provider, req.model)
    if ('error' in primary) return primary.error
    const { secretName, apiKey } = primary

    // 2b. Provider-fallback (R5 F6): resolve each fallback's credential slot and
    // build the resolved `llmPolicy` forwarded to mcp-host. Non-disruption
    // (spec V16): a fallback whose model is not allowed, or whose credential is
    // absent, is SKIPPED with a WARN — never fails the whole configure. In
    // degraded mode (allowlist CM absent) fallbacks are dropped entirely, since
    // the broker cannot gate them against an allowlist.
    const resolvedFallbacks = await this.resolveFallbacks(
      req,
      configMap,
      allowlistCm.exists ? allowlistCm.data : null
    )

    // 3. Optional SOUL download
    let soulContent: string | undefined
    if (req.soulStorageRef && this.objectStorage) {
      try {
        const content = await this.objectStorage.download(
          req.soulStorageRef.bucket,
          req.soulStorageRef.key
        )
        if (content) soulContent = content
      } catch {
        // Non-blocking: workflow continues without SOUL override
        createLogger('wrc', 'model-config-handler').warn(
          'SOUL download failed — continuing without step SOUL override',
          { stepId: req.stepId }
        )
      }
    }

    // 4. POST /configure to mcp_host — apiKey ONLY on this leg. The secret
    // name is non-secret metadata used only for usage attribution; the key
    // name and value never leave WRC.
    const configureBody: Record<string, unknown> = {
      provider: req.provider,
      model: req.model,
      apiKey,
      llmSecretName: secretName,
    }
    if (soulContent) configureBody.soulContent = soulContent
    if (resolvedFallbacks.length > 0) {
      const llmPolicy: Record<string, unknown> = { fallbacks: resolvedFallbacks }
      if (typeof req.cooldownSeconds === 'number') llmPolicy.cooldownSeconds = req.cooldownSeconds
      if (Array.isArray(req.triggerOn)) llmPolicy.triggerOn = req.triggerOn
      configureBody.llmPolicy = llmPolicy
    }

    try {
      const result = await this.mcpHost.configure(mcpHostEndpoint, wrcConfigureToken, configureBody)
      if (result.status >= 400) {
        return {
          status: 502,
          body: { error: 'mcp_host configure failed', mcpHostStatus: result.status },
        }
      }
    } catch {
      return { status: 502, body: { error: 'mcp_host configure unreachable' } }
    }

    // 5. Response to coordinator — NEVER include apiKey
    return {
      status: 202,
      body: { configured: true, provider: req.provider, model: req.model },
    }
  }

  /**
   * Resolve a (provider, model[, credentialSlot]) tuple to its Secret name +
   * apiKey via the per-provider mapping ConfigMap. `credentialSlot` overrides
   * the mapped key name (R5 slot, a key of the SAME Secret); absent = the mapped
   * default key. Returns `{ error }` with the same status/body the primary path
   * used, so the primary keeps its exact behaviour.
   */
  private async resolveCredential(
    configMap: Record<string, string>,
    provider: string,
    model: string,
    credentialSlot?: string
  ): Promise<{ secretName: string; apiKey: string } | { error: ConfigureModelResult }> {
    // The credential is associated with the provider (R1): the mapping key is
    // the provider. Dual-read during rollout — prefer the new per-provider key,
    // fall back to the legacy `provider__model` key so the ConfigMap↔WRC rollout
    // order does not matter. K8s ConfigMap keys cannot contain "/", so the
    // legacy separator was "__" (e.g. "zai/glm-4.7" → "zai__glm-4.7").
    // TODO(remove-legacy-mapping): drop the `provider__model` fallback in the
    // next release once every cluster ships the per-provider ConfigMap.
    const legacyKey = `${provider}__${model}`
    const mapping = configMap[provider] ?? configMap[legacyKey]
    if (!mapping) {
      return { error: { status: 404, body: { error: 'No secret mapping found', key: provider } } }
    }

    // Value format is "<secretName>/<keyName>" — explicit addressing of any
    // (Secret, key) tuple without assuming a canonical key name.
    const slash = mapping.indexOf('/')
    if (slash <= 0 || slash === mapping.length - 1) {
      return { error: { status: 500, body: { error: 'Malformed secret mapping' } } }
    }
    const secretName = mapping.substring(0, slash)
    // R5: a fallback may pin a specific key of the same Secret (its slot).
    const keyName =
      credentialSlot && credentialSlot.length > 0 ? credentialSlot : mapping.substring(slash + 1)

    // Read Secret by name (get only, not list)
    const secret = await this.k8s.readSecret(CONFIGMAP_NAMESPACE, secretName)
    if (!secret) {
      return {
        error: { status: 500, body: { error: 'Secret resolution failed for provider/model' } },
      }
    }
    // `keyName` may be an operator-supplied `credentialSlot`. Own-property +
    // string guard so a reserved name (`__proto__`, `constructor`) can never
    // resolve to a truthy non-string off the prototype chain.
    const apiKey = Object.prototype.hasOwnProperty.call(secret, keyName)
      ? secret[keyName]
      : undefined
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      return {
        error: { status: 500, body: { error: 'Secret resolution failed for provider/model' } },
      }
    }
    return { secretName, apiKey }
  }

  /**
   * Resolve the ordered fallback list into credential-bearing entries for the
   * mcp-host `configure` leg. Each entry is validated (provider/model shape),
   * allowlist-gated (when the allowlist CM is present), and credential-resolved;
   * any entry that fails a gate is SKIPPED with a WARN (spec V16 — never fail
   * the whole configure). When `allowlist` is null (degraded mode, CM absent)
   * ALL fallbacks are dropped: the broker cannot gate them, so it fails closed
   * on failover rather than forwarding unvetted models.
   */
  private async resolveFallbacks(
    req: ConfigureModelRequest,
    configMap: Record<string, string>,
    allowlist: Record<string, string> | null
  ): Promise<Array<{ provider: string; model: string; apiKey: string; llmSecretName: string }>> {
    const fallbacks = req.fallbacks
    if (!fallbacks || fallbacks.length === 0) return []
    const log = createLogger('wrc', 'model-config-handler')
    if (!allowlist) {
      log.warn(
        'Allowlist ConfigMap absent — dropping step fallbacks (failover unavailable in degraded mode)',
        { stepId: req.stepId, count: fallbacks.length }
      )
      return []
    }

    const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/
    const resolved: Array<{
      provider: string
      model: string
      apiKey: string
      llmSecretName: string
    }> = []
    for (const entry of fallbacks) {
      if (!isLlmProviderId(entry.provider) || !MODEL_PATTERN.test(entry.model)) {
        log.warn('Skipping fallback with invalid provider/model', { stepId: req.stepId })
        continue
      }
      const allowed = parseAllowedModels(allowlist[entry.provider], entry.provider)
      if (!allowed.has(entry.model)) {
        log.warn('Skipping fallback model not in allowlist', {
          stepId: req.stepId,
          provider: entry.provider,
          model: entry.model,
        })
        continue
      }
      const cred = await this.resolveCredential(
        configMap,
        entry.provider,
        entry.model,
        entry.credentialSlot
      )
      if ('error' in cred) {
        log.warn('Skipping fallback with unresolved credential slot', {
          stepId: req.stepId,
          provider: entry.provider,
          model: entry.model,
        })
        continue
      }
      resolved.push({
        provider: entry.provider,
        model: entry.model,
        apiKey: cred.apiKey,
        llmSecretName: cred.secretName,
      })
    }
    return resolved
  }
}
