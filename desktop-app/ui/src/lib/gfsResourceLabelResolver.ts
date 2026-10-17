import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'

export type GfsResourceLabel = { name: string; kind: 'directory' | 'file' }
export type GfsResourceLabelListener = (label: GfsResourceLabel | null, error?: unknown) => void

type Resolve = (uri: string) => Promise<unknown>

type Request = {
  key: string
  principalIdentity: string
  authorizationEpoch: number
  sessionGeneration: number
  uri: string
  invalidationGeneration: number
  listeners: Set<GfsResourceLabelListener>
  state: 'queued' | 'running'
}

type CachedLabel = {
  principalIdentity: string
  authorizationEpoch: number
  sessionGeneration: number
  label: GfsResourceLabel | null
  expiresAt: number
}

export const GFS_RESOURCE_LABEL_POLICY = {
  maxStartsPerPrincipalPerMinute: 60,
  rollingWindowMs: 60_000,
  maxConcurrent: 4,
  maxQueued: 64,
  cacheTtlMs: 60_000,
} as const

function requestKey(
  principalIdentity: string,
  authorizationEpoch: number,
  sessionGeneration: number,
  uri: string
): string {
  return JSON.stringify([principalIdentity, authorizationEpoch, sessionGeneration, uri])
}

function validLabel(resource: unknown, exactUri: string): GfsResourceLabel | null {
  if (!resource || typeof resource !== 'object') return null
  const candidate = resource as { gfsUri?: unknown; name?: unknown; kind?: unknown }
  if (
    typeof candidate.gfsUri !== 'string' ||
    normalizeGfsResourceUri(candidate.gfsUri) !== exactUri ||
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    (candidate.kind !== 'directory' && candidate.kind !== 'file')
  ) {
    return null
  }
  return { name: sanitizeAppTabTitle(candidate.name) || 'Unnamed', kind: candidate.kind }
}

/**
 * App-local scheduler for authenticated labels on bare GFS links. A label is
 * presentation metadata only: the URI stays the navigation target and every
 * resolver response is checked against that exact canonical URI.
 */
export class GfsResourceLabelResolver {
  private readonly requests = new Map<string, Request>()
  private readonly queue: Request[] = []
  private readonly cache = new Map<string, CachedLabel>()
  private readonly startsByPrincipal = new Map<string, number[]>()
  private readonly epochByPrincipal = new Map<string, number>()
  private readonly sessionGenerationByPrincipal = new Map<string, number>()
  private readonly invalidationGenerationByPrincipal = new Map<string, number>()
  private activePrincipal: string | null = null
  private running = 0

  constructor(
    private readonly resolve: Resolve,
    private readonly now: () => number = Date.now,
    private readonly getSessionGeneration: () => Promise<number> = async () => 0
  ) {}

  subscribe(
    principalIdentity: string | null,
    authorizationEpoch: number,
    rawUri: string,
    listener: GfsResourceLabelListener
  ): () => void {
    const uri = normalizeGfsResourceUri(rawUri)
    if (
      !principalIdentity ||
      !uri ||
      !Number.isSafeInteger(authorizationEpoch) ||
      authorizationEpoch < 0
    ) {
      listener(null)
      return () => undefined
    }

    this.setActivePrincipal(principalIdentity)
    if (!this.acceptEpoch(principalIdentity, authorizationEpoch)) {
      listener(null)
      return () => undefined
    }

    const invalidationGeneration =
      this.invalidationGenerationByPrincipal.get(principalIdentity) ?? 0
    let request: Request | null = null
    let cancelled = false
    void this.prepareSubscription(
      principalIdentity,
      authorizationEpoch,
      uri,
      invalidationGeneration,
      listener,
      value => {
        request = value
        if (cancelled && value) this.unsubscribe(value, listener)
      },
      () => cancelled
    )
    return () => {
      cancelled = true
      if (request) this.unsubscribe(request, listener)
    }
  }

  private async prepareSubscription(
    principalIdentity: string,
    authorizationEpoch: number,
    uri: string,
    invalidationGeneration: number,
    listener: GfsResourceLabelListener,
    registerRequest: (request: Request | null) => void,
    isCancelled: () => boolean
  ): Promise<void> {
    let sessionGeneration: number
    try {
      sessionGeneration = await this.getSessionGeneration()
    } catch {
      if (!isCancelled()) listener(null)
      return
    }
    if (isCancelled()) return
    if (
      !Number.isSafeInteger(sessionGeneration) ||
      sessionGeneration < 0 ||
      this.activePrincipal !== principalIdentity ||
      (this.invalidationGenerationByPrincipal.get(principalIdentity) ?? 0) !==
        invalidationGeneration ||
      !this.acceptSessionGeneration(principalIdentity, sessionGeneration)
    ) {
      listener(null)
      return
    }
    const currentInvalidationGeneration =
      this.invalidationGenerationByPrincipal.get(principalIdentity) ?? 0

    this.prune(principalIdentity)
    const key = requestKey(principalIdentity, authorizationEpoch, sessionGeneration, uri)
    const cached = this.cache.get(key)
    if (cached) {
      registerRequest(null)
      listener(cached.label)
      return
    }

    const existing = this.requests.get(key)
    if (existing) {
      existing.listeners.add(listener)
      registerRequest(existing)
      return
    }

    if (
      this.liveStarts(principalIdentity).length >=
      GFS_RESOURCE_LABEL_POLICY.maxStartsPerPrincipalPerMinute
    ) {
      registerRequest(null)
      listener(null)
      return
    }

    const queuedCount = this.queue.filter(request => request.state === 'queued').length
    if (queuedCount >= GFS_RESOURCE_LABEL_POLICY.maxQueued) {
      registerRequest(null)
      listener(null)
      return
    }

    const request: Request = {
      key,
      principalIdentity,
      authorizationEpoch,
      sessionGeneration,
      uri,
      invalidationGeneration: currentInvalidationGeneration,
      listeners: new Set([listener]),
      state: 'queued',
    }
    this.requests.set(key, request)
    this.queue.push(request)
    registerRequest(request)
    this.pump()
  }

  setActivePrincipal(principalIdentity: string | null): void {
    if (this.activePrincipal === principalIdentity) return
    const previousPrincipal = this.activePrincipal
    this.activePrincipal = principalIdentity
    if (previousPrincipal) this.invalidatePrincipal(previousPrincipal)
    for (const request of [...this.queue]) {
      if (!principalIdentity || request.principalIdentity !== principalIdentity) {
        this.discardQueued(request)
      }
    }
    for (const [key, cached] of this.cache) {
      if (!principalIdentity || cached.principalIdentity !== principalIdentity) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Discard all presentation labels and pending work for a principal after a
   * session-authority failure. Running IPC work may finish, but its receipt no
   * longer owns the current resolver generation and cannot publish a label.
   */
  invalidatePrincipal(principalIdentity: string): void {
    this.invalidationGenerationByPrincipal.set(
      principalIdentity,
      (this.invalidationGenerationByPrincipal.get(principalIdentity) ?? 0) + 1
    )
    for (const request of [...this.requests.values()]) {
      if (request.principalIdentity !== principalIdentity) continue
      this.requests.delete(request.key)
      if (request.state === 'queued') {
        const index = this.queue.indexOf(request)
        if (index >= 0) this.queue.splice(index, 1)
      }
      request.listeners.clear()
    }
    for (const [key, cached] of this.cache) {
      if (cached.principalIdentity === principalIdentity) this.cache.delete(key)
    }
  }

  private acceptEpoch(principalIdentity: string, authorizationEpoch: number): boolean {
    const currentEpoch = this.epochByPrincipal.get(principalIdentity)
    if (currentEpoch !== undefined && authorizationEpoch < currentEpoch) return false
    if (currentEpoch === authorizationEpoch) return true

    this.epochByPrincipal.set(principalIdentity, authorizationEpoch)
    for (const request of [...this.queue]) {
      if (
        request.principalIdentity === principalIdentity &&
        request.authorizationEpoch !== authorizationEpoch
      ) {
        this.discardQueued(request)
      }
    }
    for (const [key, cached] of this.cache) {
      if (
        cached.principalIdentity === principalIdentity &&
        cached.authorizationEpoch !== authorizationEpoch
      ) {
        this.cache.delete(key)
      }
    }
    return true
  }

  private acceptSessionGeneration(principalIdentity: string, sessionGeneration: number): boolean {
    const currentGeneration = this.sessionGenerationByPrincipal.get(principalIdentity)
    if (currentGeneration !== undefined && sessionGeneration < currentGeneration) return false
    if (currentGeneration === sessionGeneration) return true

    this.sessionGenerationByPrincipal.set(principalIdentity, sessionGeneration)
    if (currentGeneration !== undefined) this.invalidatePrincipal(principalIdentity)
    return true
  }

  private unsubscribe(request: Request, listener: GfsResourceLabelListener): void {
    request.listeners.delete(listener)
    if (request.state === 'queued' && request.listeners.size === 0) this.discardQueued(request)
  }

  private discardQueued(request: Request): void {
    if (request.state !== 'queued') return
    this.requests.delete(request.key)
    const index = this.queue.indexOf(request)
    if (index >= 0) this.queue.splice(index, 1)
    request.listeners.clear()
  }

  private liveStarts(principalIdentity: string): number[] {
    const earliest = this.now() - GFS_RESOURCE_LABEL_POLICY.rollingWindowMs
    const current = (this.startsByPrincipal.get(principalIdentity) ?? []).filter(
      startedAt => startedAt > earliest
    )
    this.startsByPrincipal.set(principalIdentity, current)
    return current
  }

  private prune(principalIdentity: string): void {
    const now = this.now()
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now) this.cache.delete(key)
    }
    this.liveStarts(principalIdentity)
  }

  private pump(): void {
    while (this.running < GFS_RESOURCE_LABEL_POLICY.maxConcurrent && this.queue.length > 0) {
      const request = this.queue.shift()!
      if (request.listeners.size === 0 || !this.isCurrent(request)) {
        this.discardQueued(request)
        continue
      }
      const starts = this.liveStarts(request.principalIdentity)
      if (starts.length >= GFS_RESOURCE_LABEL_POLICY.maxStartsPerPrincipalPerMinute) {
        this.discardQueued(request)
        continue
      }

      request.state = 'running'
      starts.push(this.now())
      this.startsByPrincipal.set(request.principalIdentity, starts)
      this.running += 1
      void Promise.resolve().then(() => this.resolveForSession(request))
    }
  }

  private async resolveForSession(request: Request): Promise<void> {
    try {
      const before = await this.getSessionGeneration()
      if (
        before !== request.sessionGeneration ||
        !this.acceptSessionGeneration(request.principalIdentity, before) ||
        !this.isCurrent(request)
      ) {
        if (Number.isSafeInteger(before) && before >= 0) {
          this.acceptSessionGeneration(request.principalIdentity, before)
        }
        this.finish(request, null, undefined, true)
        return
      }

      const resource = await this.resolve(request.uri)
      const after = await this.getSessionGeneration()
      if (
        after !== request.sessionGeneration ||
        !this.acceptSessionGeneration(request.principalIdentity, after) ||
        !this.isCurrent(request)
      ) {
        if (Number.isSafeInteger(after) && after >= 0) {
          this.acceptSessionGeneration(request.principalIdentity, after)
        }
        this.finish(request, null, undefined, true)
        return
      }
      this.finish(request, validLabel(resource, request.uri))
    } catch (error) {
      let after: number
      try {
        after = await this.getSessionGeneration()
      } catch {
        this.finish(request, null, undefined, true)
        return
      }
      if (
        after !== request.sessionGeneration ||
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !this.acceptSessionGeneration(request.principalIdentity, after) ||
        !this.isCurrent(request)
      ) {
        if (Number.isSafeInteger(after) && after >= 0) {
          this.acceptSessionGeneration(request.principalIdentity, after)
        }
        this.finish(request, null, undefined, true)
        return
      }
      this.finish(request, null, error)
    }
  }

  private finish(
    request: Request,
    label: GfsResourceLabel | null,
    error?: unknown,
    suppress = false
  ): void {
    this.running = Math.max(0, this.running - 1)
    if (this.requests.get(request.key) === request) this.requests.delete(request.key)
    const current = this.isCurrent(request)
    if (current && !suppress) {
      this.cache.set(request.key, {
        principalIdentity: request.principalIdentity,
        authorizationEpoch: request.authorizationEpoch,
        sessionGeneration: request.sessionGeneration,
        label,
        expiresAt: this.now() + GFS_RESOURCE_LABEL_POLICY.cacheTtlMs,
      })
      request.listeners.forEach(listener => {
        try {
          if (error === undefined) listener(label)
          else listener(label, error)
        } catch {
          // A subscriber is a presentation surface; one broken listener must
          // not stall this shared scheduler or prevent other labels resolving.
        }
      })
    }
    request.listeners.clear()
    this.pump()
  }

  private isCurrent(request: Request): boolean {
    return (
      this.activePrincipal === request.principalIdentity &&
      this.epochByPrincipal.get(request.principalIdentity) === request.authorizationEpoch &&
      this.sessionGenerationByPrincipal.get(request.principalIdentity) ===
        request.sessionGeneration &&
      (this.invalidationGenerationByPrincipal.get(request.principalIdentity) ?? 0) ===
        request.invalidationGeneration
    )
  }
}

export const gfsResourceLabelResolver = new GfsResourceLabelResolver(
  uri => window.clerum.gfs.resolve(uri),
  Date.now,
  () => window.clerum.auth.getSessionGeneration()
)
