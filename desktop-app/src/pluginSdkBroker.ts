/**
 * The plugin SDK chokepoint (spec §4).
 *
 * Every capability call, from every plugin surface, passes through here in one
 * fixed order:
 *
 *   resolve caller → look up descriptor → require session → rate budget →
 *   consent → provider → minimize → audit
 *
 * There is deliberately no second path. Adding a capability cannot skip the
 * consent check or the audit write because there is nowhere else for a request
 * to go.
 */
import type { AuditEntry, AuditOutcome, PluginAuditLog } from './pluginAuditLog.js'
import { shapeOf } from './pluginAuditLog.js'
import type { PluginConsentGate } from './pluginConsentGate.js'
import type { ConsentStore } from './pluginConsentStore.js'
import type { PluginRateLimiter } from './pluginRateLimiter.js'
import {
  CAPABILITY_IDS,
  CapabilityInputError,
  CapabilityNotFoundError,
  CapabilityTooLargeError,
  type PluginSdkDataSource,
  getCapability,
} from './pluginSdkCapabilities.js'
import {
  PLUGIN_SDK_MAX_BATCH,
  PLUGIN_SDK_PROTOCOL,
  PLUGIN_SDK_VERSION,
  type PluginSdkCapabilitiesResult,
  type PluginSdkPermissionStateResult,
  type PluginSdkPermissionsResult,
  type PluginSdkResponse,
  sdkError,
  sdkOk,
} from './pluginSdkProtocol.js'
import { type PinnedPluginSurface, resolvePluginSurface } from './pluginSurfaceRegistry.js'

export type BrokerDeps = {
  source: PluginSdkDataSource
  store: ConsentStore
  gate: PluginConsentGate
  limiter: PluginRateLimiter
  audit: PluginAuditLog
  /** Active environment key — scopes grants and the audit file. */
  getEnvKey: () => string
  /** Current user id, or null when logged out. */
  getUserId: () => string | null
  now?: () => number
}

type CacheEntry = { value: unknown; expiresAt: number }

export class PluginSdkBroker {
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: BrokerDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  private async writeAudit(
    surface: PinnedPluginSurface | null,
    capability: string,
    outcome: AuditOutcome,
    extra: Partial<AuditEntry> = {}
  ): Promise<void> {
    const userId = this.deps.getUserId() ?? 'anonymous'
    const entry: AuditEntry = {
      ts: new Date(this.now()).toISOString(),
      userId,
      pluginId: surface?.pluginId ?? 'unknown',
      capability,
      outcome,
      ...(surface ? { surface: surface.surface } : {}),
      ...extra,
    }
    await this.deps.audit.append(this.deps.getEnvKey(), entry)
  }

  /**
   * Sender → plugin. An unpinned sender is a hard rejection: the embed loads
   * from the rpc-proxy origin so `assertTrustedSender` cannot be the check
   * here, and the pinning map is what stands in its place (spec §8.1).
   */
  private resolveCaller(senderId: number): PinnedPluginSurface | null {
    const surface = resolvePluginSurface(senderId)
    if (!surface) {
      console.warn('[PluginSDK] request from unpinned sender', senderId)
      return null
    }
    return surface
  }

  listCapabilities(senderId: number): PluginSdkResponse<PluginSdkCapabilitiesResult> {
    if (!this.resolveCaller(senderId)) {
      return sdkError('internal', 'this surface is not registered', false)
    }
    return sdkOk({ capabilities: [...CAPABILITY_IDS], version: PLUGIN_SDK_VERSION })
  }

  /** Grant state without prompting, so a returning user sees no modal at all. */
  async permissionState(
    senderId: number,
    requested: unknown
  ): Promise<PluginSdkResponse<PluginSdkPermissionStateResult>> {
    const surface = this.resolveCaller(senderId)
    if (!surface) return sdkError('internal', 'this surface is not registered', false)
    const userId = this.deps.getUserId()
    if (!userId) return sdkError('unauthenticated', 'no active session', true)

    let ids: string[]
    try {
      ids = normalizeCapabilityList(requested, { allowEmpty: true })
    } catch (err) {
      return sdkError('invalid_request', (err as Error).message, false)
    }
    const list = ids.length > 0 ? ids : CAPABILITY_IDS
    const granted: Record<string, boolean> = {}
    for (const capability of list) {
      granted[capability] = await this.deps.gate.isGranted({
        envKey: this.deps.getEnvKey(),
        userId,
        pluginId: surface.pluginId,
        capability,
      })
    }
    return sdkOk({ granted })
  }

  /**
   * Batched consent (spec §9.2). One call, one modal, one decision per row.
   * Returns a MAP even when the user declines everything — a partial grant is a
   * normal state the plugin renders, not an exception.
   */
  async requestPermissions(
    senderId: number,
    payload: unknown
  ): Promise<PluginSdkResponse<PluginSdkPermissionsResult>> {
    const surface = this.resolveCaller(senderId)
    if (!surface) return sdkError('internal', 'this surface is not registered', false)

    const version = (payload as { v?: unknown })?.v
    if (version !== undefined && version !== PLUGIN_SDK_PROTOCOL) {
      return sdkError(
        'unsupported_version',
        `unsupported protocol version: ${String(version)}`,
        false
      )
    }
    const userId = this.deps.getUserId()
    if (!userId) return sdkError('unauthenticated', 'no active session', true)

    let ids: string[]
    try {
      ids = normalizeCapabilityList((payload as { capabilities?: unknown })?.capabilities, {
        allowEmpty: false,
      })
    } catch (err) {
      return sdkError('invalid_request', (err as Error).message, false)
    }

    const outcome = await this.deps.gate.ensure({
      envKey: this.deps.getEnvKey(),
      userId,
      pluginId: surface.pluginId,
      pluginTitle: surface.pluginTitle,
      capabilities: ids,
    })

    // One audit line per row, so the Settings activity view shows the user's
    // decision per capability rather than one opaque "prompt" entry.
    for (const capability of ids) {
      const allowed = outcome.granted[capability] === true
      await this.writeAudit(surface, capability, allowed ? 'granted' : 'denied', {
        consent: outcome.source[capability],
      })
    }

    const granted: Record<string, boolean> = {}
    for (const capability of ids) granted[capability] = outcome.granted[capability] === true
    return sdkOk({ granted, all: ids.every(capability => granted[capability]) })
  }

  /** One capability call. */
  async request(senderId: number, payload: unknown): Promise<PluginSdkResponse> {
    const surface = this.resolveCaller(senderId)
    if (!surface) return sdkError('internal', 'this surface is not registered', false)

    const request = (payload ?? {}) as { v?: unknown; capability?: unknown; params?: unknown }
    if (request.v !== undefined && request.v !== PLUGIN_SDK_PROTOCOL) {
      return sdkError(
        'unsupported_version',
        `unsupported protocol version: ${String(request.v)}`,
        false
      )
    }

    const capability = typeof request.capability === 'string' ? request.capability : ''
    const descriptor = getCapability(capability)
    if (!descriptor) {
      await this.writeAudit(surface, capability || 'unknown', 'error', {
        code: 'unsupported_capability',
      })
      return sdkError('unsupported_capability', `unknown capability: ${capability}`, false)
    }

    const userId = this.deps.getUserId()
    if (!userId) {
      await this.writeAudit(surface, capability, 'error', { code: 'unauthenticated' })
      return sdkError('unauthenticated', 'no active session', true)
    }

    let params: Record<string, unknown>
    try {
      params = descriptor.validate(request.params)
    } catch (err) {
      await this.writeAudit(surface, capability, 'error', { code: 'invalid_request' })
      return sdkError('invalid_request', (err as Error).message, false)
    }

    const budget = this.deps.limiter.take(surface.pluginId, capability, descriptor.limits)
    if (!budget.allowed) {
      await this.writeAudit(surface, capability, 'rate_limited')
      return sdkError('rate_limited', `too many requests; retry in ${budget.retryAfterMs}ms`, true)
    }

    const grantKey = {
      envKey: this.deps.getEnvKey(),
      userId,
      pluginId: surface.pluginId,
      capability,
    }
    const outcome = await this.deps.gate.ensure({
      ...grantKey,
      pluginTitle: surface.pluginTitle,
      capabilities: [capability],
    })
    if (outcome.granted[capability] !== true) {
      await this.writeAudit(surface, capability, 'denied', { consent: outcome.source[capability] })
      return sdkError('permission_denied', 'the user has not granted this permission', true)
    }

    const cacheKey = `${surface.pluginId}::${capability}::${JSON.stringify(params)}`
    if (descriptor.cacheTtlMs > 0) {
      const hit = this.cache.get(cacheKey)
      if (hit && hit.expiresAt > this.now()) {
        await this.finishAllowed(
          surface,
          capability,
          grantKey,
          hit.value,
          outcome.source[capability]
        )
        return sdkOk(hit.value)
      }
    }

    let value: unknown
    try {
      value = await descriptor.run(
        {
          source: this.deps.source,
          pluginId: surface.pluginId,
          pluginTitle: surface.pluginTitle,
          userId,
        },
        params
      )
    } catch (err) {
      return this.mapProviderError(surface, capability, err)
    }

    // Revocation can land while a provider call is in flight. Fail closed: the
    // user said no between the check and the answer, so the answer is not theirs
    // to receive.
    if (!(await this.deps.gate.isGranted(grantKey))) {
      await this.writeAudit(surface, capability, 'revoked_mid_flight')
      return sdkError('permission_revoked', 'this permission was revoked', true)
    }

    const serialized = JSON.stringify(value ?? null)
    if (Buffer.byteLength(serialized, 'utf8') > descriptor.limits.maxResponseBytes) {
      await this.writeAudit(surface, capability, 'error', { code: 'payload_too_large' })
      return sdkError('payload_too_large', 'the result is too large to return', false)
    }

    if (descriptor.cacheTtlMs > 0) {
      this.cache.set(cacheKey, { value, expiresAt: this.now() + descriptor.cacheTtlMs })
    }
    await this.finishAllowed(surface, capability, grantKey, value, outcome.source[capability])
    return sdkOk(value)
  }

  private async finishAllowed(
    surface: PinnedPluginSurface,
    capability: string,
    grantKey: { envKey: string; userId: string; pluginId: string; capability: string },
    value: unknown,
    consent: AuditEntry['consent']
  ): Promise<void> {
    const descriptor = getCapability(capability)
    if (descriptor?.requiresConsent) {
      await this.deps.store.touch(grantKey).catch(() => undefined)
    }
    await this.writeAudit(surface, capability, 'allowed', {
      consent,
      shape: shapeOf(value),
    })
  }

  private async mapProviderError(
    surface: PinnedPluginSurface,
    capability: string,
    err: unknown
  ): Promise<PluginSdkResponse> {
    if (err instanceof CapabilityInputError) {
      await this.writeAudit(surface, capability, 'error', { code: 'invalid_request' })
      return sdkError('invalid_request', err.message, false)
    }
    if (err instanceof CapabilityTooLargeError) {
      await this.writeAudit(surface, capability, 'error', { code: 'payload_too_large' })
      return sdkError('payload_too_large', err.message, false)
    }
    if (err instanceof CapabilityNotFoundError) {
      await this.writeAudit(surface, capability, 'error', { code: 'not_found' })
      return sdkError('not_found', 'not found', false)
    }
    // Upstream failures are logged locally and reported generically. An
    // upstream body forwarded verbatim is a data-leak path (spec §12, T8), and
    // `not_found` deliberately conflates "absent" with "not yours" so the SDK
    // is never an existence oracle.
    console.warn(`[PluginSDK] ${capability} failed for ${surface.pluginId}:`, err)
    const message = err instanceof Error ? err.message : String(err)
    if (/\b404\b|not found/i.test(message)) {
      await this.writeAudit(surface, capability, 'error', { code: 'not_found' })
      return sdkError('not_found', 'not found', false)
    }
    await this.writeAudit(surface, capability, 'error', { code: 'unavailable' })
    return sdkError('unavailable', 'the desktop app could not complete this request', true)
  }

  /** Drop cached provider results (logout, team switch, revocation). */
  invalidateCache(pluginId?: string): void {
    if (!pluginId) {
      this.cache.clear()
      return
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${pluginId}::`)) this.cache.delete(key)
    }
  }
}

function normalizeCapabilityList(raw: unknown, options: { allowEmpty: boolean }): string[] {
  if (raw === undefined || raw === null) {
    if (options.allowEmpty) return []
    throw new Error('capabilities is required')
  }
  if (!Array.isArray(raw)) throw new Error('capabilities must be an array')
  if (raw.length === 0) {
    if (options.allowEmpty) return []
    throw new Error('capabilities must not be empty')
  }
  if (raw.length > PLUGIN_SDK_MAX_BATCH) {
    throw new Error(`at most ${PLUGIN_SDK_MAX_BATCH} capabilities per request`)
  }
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new Error('capabilities must be strings')
    if (seen.has(entry)) throw new Error(`duplicate capability: ${entry}`)
    if (!getCapability(entry)) throw new Error(`unknown capability: ${entry}`)
    seen.add(entry)
  }
  return [...seen]
}
