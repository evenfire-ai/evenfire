import { AuthClient } from './authClient.js'
import { RpcAccessScope, RpcScope, RpcTokenResult } from './types.js'

type RpcCache = {
  token: string
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  expiresAtMs: number
  expiresAtMonotonicMs: number
  bindingKey: string
}

export class RpcTokenIssuanceSupersededError extends Error {
  constructor() {
    super('RPC token issuance was superseded by a newer authenticated session')
    this.name = 'RpcTokenIssuanceSupersededError'
  }
}

export class RpcTokenManager {
  private cache: RpcCache | null = null
  private cacheGeneration = 0
  private activeBindingKey = ''

  constructor(
    private readonly authClient: AuthClient,
    private readonly nowMonotonic: () => number = () => performance.now()
  ) {}

  clear(): void {
    this.cacheGeneration += 1
    this.cache = null
    this.activeBindingKey = ''
  }

  getMetadata(): { expiresAtMs: number | null; scopes: RpcScope[]; hostRefs: string[] } {
    if (!this.cache) {
      return { expiresAtMs: null, scopes: [], hostRefs: [] }
    }
    return {
      expiresAtMs: this.cache.expiresAtMs,
      scopes: this.cache.scopes,
      hostRefs: this.cache.hostRefs,
    }
  }

  private satisfies(requiredScopes: RpcScope[], requestedHostRefs?: string[]): boolean {
    if (!this.cache) return false
    if (this.nowMonotonic() >= this.cache.expiresAtMonotonicMs - 5000) return false
    if (!requiredScopes.every(scope => this.cache!.scopes.includes(scope))) return false
    if (requestedHostRefs && requestedHostRefs.length > 0) {
      if (this.cache.hostRefs.length === 0) return false
      return requestedHostRefs.every(ref => this.cache!.hostRefs.includes(ref))
    }
    return true
  }

  /** Read an already cached credential without minting or mutating cache state. */
  peekCached(
    requiredScopes: RpcScope[],
    requestedHostRefs: string[] | undefined,
    bindingKey: string
  ): RpcTokenResult | null {
    if (
      !this.cache ||
      this.activeBindingKey !== bindingKey ||
      this.cache.bindingKey !== bindingKey ||
      !this.satisfies(requiredScopes, requestedHostRefs)
    )
      return null
    return {
      token: this.cache.token,
      accessScope: this.cache.accessScope,
      teamId: this.cache.teamId,
      scopes: this.cache.scopes,
      hostRefs: this.cache.hostRefs,
      expiresInSeconds: Math.max(
        0,
        Math.floor((this.cache.expiresAtMonotonicMs - this.nowMonotonic()) / 1000)
      ),
    }
  }

  async getOrIssue(
    sessionToken: string,
    requiredScopes: RpcScope[],
    requestedHostRefs: string[] | undefined,
    bindingKey: string
  ): Promise<RpcTokenResult> {
    if (this.activeBindingKey !== bindingKey) {
      this.cacheGeneration += 1
      this.cache = null
      this.activeBindingKey = bindingKey
    }
    if (
      this.satisfies(requiredScopes, requestedHostRefs) &&
      this.cache &&
      this.cache.bindingKey === bindingKey
    ) {
      return {
        token: this.cache.token,
        accessScope: this.cache.accessScope,
        teamId: this.cache.teamId,
        scopes: this.cache.scopes,
        hostRefs: this.cache.hostRefs,
        expiresInSeconds: Math.max(
          0,
          Math.floor((this.cache.expiresAtMonotonicMs - this.nowMonotonic()) / 1000)
        ),
      }
    }

    const generation = this.cacheGeneration
    const issued = await this.authClient.issueRpcToken(
      sessionToken,
      requiredScopes,
      requestedHostRefs
    )
    if (generation !== this.cacheGeneration || this.activeBindingKey !== bindingKey) {
      throw new RpcTokenIssuanceSupersededError()
    }
    if (!Number.isSafeInteger(issued.expiresInSeconds) || issued.expiresInSeconds <= 0) {
      throw new Error('RPC token issuer returned an invalid expiration interval')
    }
    const issuedAtMonotonicMs = this.nowMonotonic()
    this.cache = {
      token: issued.token,
      accessScope: issued.accessScope,
      teamId: issued.teamId,
      scopes: issued.scopes,
      hostRefs: issued.hostRefs,
      expiresAtMs: Date.now() + issued.expiresInSeconds * 1000,
      expiresAtMonotonicMs: issuedAtMonotonicMs + issued.expiresInSeconds * 1000,
      bindingKey,
    }
    return issued
  }
}
