import { AuthClient } from './authClient.js'
import { RpcAccessScope, RpcScope, RpcTokenResult } from './types.js'

type RpcCache = {
  token: string
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  expiresAtMs: number
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

  constructor(private readonly authClient: AuthClient) {}

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
    if (Date.now() >= this.cache.expiresAtMs - 5000) return false
    if (!requiredScopes.every(scope => this.cache!.scopes.includes(scope))) return false
    if (requestedHostRefs && requestedHostRefs.length > 0) {
      if (this.cache.hostRefs.length === 0) return false
      return requestedHostRefs.every(ref => this.cache!.hostRefs.includes(ref))
    }
    return true
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
        expiresInSeconds: Math.max(0, Math.floor((this.cache.expiresAtMs - Date.now()) / 1000)),
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
    this.cache = {
      token: issued.token,
      accessScope: issued.accessScope,
      teamId: issued.teamId,
      scopes: issued.scopes,
      hostRefs: issued.hostRefs,
      expiresAtMs: Date.now() + issued.expiresInSeconds * 1000,
      bindingKey,
    }
    return issued
  }
}
