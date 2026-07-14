import { AuthClient } from './authClient.js'
import { RpcAccessScope, RpcScope, RpcTokenResult } from './types.js'

type RpcCache = {
  token: string
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  expiresAtMs: number
}

export class RpcTokenManager {
  private cache: RpcCache | null = null

  constructor(private readonly authClient: AuthClient) {}

  clear(): void {
    this.cache = null
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
    requestedHostRefs?: string[]
  ): Promise<RpcTokenResult> {
    if (this.satisfies(requiredScopes, requestedHostRefs) && this.cache) {
      return {
        token: this.cache.token,
        accessScope: this.cache.accessScope,
        teamId: this.cache.teamId,
        scopes: this.cache.scopes,
        hostRefs: this.cache.hostRefs,
        expiresInSeconds: Math.max(0, Math.floor((this.cache.expiresAtMs - Date.now()) / 1000)),
      }
    }

    const issued = await this.authClient.issueRpcToken(
      sessionToken,
      requiredScopes,
      requestedHostRefs
    )
    this.cache = {
      token: issued.token,
      accessScope: issued.accessScope,
      teamId: issued.teamId,
      scopes: issued.scopes,
      hostRefs: issued.hostRefs,
      expiresAtMs: Date.now() + issued.expiresInSeconds * 1000,
    }
    return issued
  }
}
