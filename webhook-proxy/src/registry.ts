import http from 'node:http'
import https from 'node:https'
import type { ProxyConfig } from './config'
import type { RegistryResult, RouteIds } from './types'

interface CachedEntry {
  result: RegistryResult
  expiresAt: number
}

/**
 * Tiny in-memory registry cache. Entries live for `registryCacheTtlMs`
 * regardless of result kind — both hits and misses are cached so a
 * burst of "unknown id" probes from a misconfigured provider doesn't
 * hammer control-api on every request.
 */
export class RegistryClient {
  private readonly cache = new Map<string, CachedEntry>()
  private readonly fetcher: (
    url: string,
    headers: Record<string, string>
  ) => Promise<{ status: number; body: string }>

  constructor(
    private readonly config: ProxyConfig,
    fetcher?: (
      url: string,
      headers: Record<string, string>
    ) => Promise<{ status: number; body: string }>
  ) {
    this.fetcher = fetcher ?? defaultFetcher
  }

  async lookup(ids: RouteIds): Promise<RegistryResult> {
    const key = `${ids.recipeNs}/${ids.recipeName}/${ids.webhookId}`
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result
    }
    const result = await this.fetchUncached(ids)
    // Don't cache `upstream_error` — transient network failures shouldn't
    // pin a 5s "broken" result while control-api recovers.
    if (result.exists || (result as { reason?: string }).reason !== 'upstream_error') {
      this.cache.set(key, {
        result,
        expiresAt: Date.now() + this.config.registryCacheTtlMs,
      })
    }
    return result
  }

  invalidate(ids: RouteIds): void {
    this.cache.delete(`${ids.recipeNs}/${ids.recipeName}/${ids.webhookId}`)
  }

  size(): number {
    return this.cache.size
  }

  private async fetchUncached(ids: RouteIds): Promise<RegistryResult> {
    const path = `/internal/webhook/registry/${encodeURIComponent(ids.recipeNs)}/${encodeURIComponent(ids.recipeName)}/${encodeURIComponent(ids.webhookId)}`
    const url = `${this.config.controlApiBaseUrl.replace(/\/$/, '')}${path}`
    let res: { status: number; body: string }
    try {
      res = await this.fetcher(url, {
        authorization: `Bearer ${this.config.controlApiServiceToken}`,
        'x-service-token': 'webhook-proxy',
        accept: 'application/json',
      })
    } catch (err) {
      return {
        exists: false,
        reason: 'upstream_error',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
    if (res.status === 200) {
      try {
        const parsed = JSON.parse(res.body)
        if (parsed?.exists !== true) {
          return { exists: false, reason: 'upstream_error', detail: 'malformed_registry_response' }
        }
        return parsed
      } catch (err) {
        return {
          exists: false,
          reason: 'upstream_error',
          detail: err instanceof Error ? err.message : String(err),
        }
      }
    }
    if (res.status === 404) {
      try {
        const parsed = JSON.parse(res.body)
        if (
          parsed?.reason === 'recipe_not_found' ||
          parsed?.reason === 'webhook_not_found'
        ) {
          return { exists: false, reason: parsed.reason }
        }
        return { exists: false, reason: 'webhook_not_found' }
      } catch {
        return { exists: false, reason: 'webhook_not_found' }
      }
    }
    if (res.status === 400) {
      // control-api rejected our shape — surface a synthetic 400
      // back to the caller via the route handler.
      return { exists: false, reason: 'invalid_request', status: 400 }
    }
    // 401, 5xx, anything else.
    return {
      exists: false,
      reason: 'upstream_error',
      detail: `control-api returned status ${res.status}`,
    }
  }
}

async function defaultFetcher(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url)
  const lib = parsed.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: 5_000,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('control-api lookup timed out'))
    })
    req.end()
  })
}
