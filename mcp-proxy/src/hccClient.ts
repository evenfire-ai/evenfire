import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { proxyLogger } from './logger'
import {
  type HccServerInfo,
  type HccServersResponse,
  type ProxyConfig,
  type ServerRoute,
} from './types'

export type HccAuthorizationErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'unavailable'

export class HccAuthorizationError extends Error {
  constructor(readonly code: HccAuthorizationErrorCode) {
    super(code)
    this.name = 'HccAuthorizationError'
  }
}

export interface HccForwardAuthorization {
  serverName: string
  contextRef: string
  targetUrl: string
  destinationRevision: string
}

export type SystemIdentityReader = () => Promise<string>

const BEARER_SCHEME = 'Bearer'
const MAX_HCC_RESPONSE_BYTES = 1_048_576

export class HccClient {
  private readonly config: ProxyConfig
  private readonly readSystemIdentity: SystemIdentityReader
  private cache: ServerRoute[] = []
  private lastSuccessfulPoll = 0

  constructor(config: ProxyConfig, readSystemIdentity?: SystemIdentityReader) {
    this.config = config
    this.readSystemIdentity =
      readSystemIdentity ??
      (async () => {
        const value = (await fs.readFile(config.systemTokenFile, 'utf8')).trim()
        if (!value) throw new Error('system identity file is empty')
        return value
      })
  }

  async fetchServers(): Promise<ServerRoute[]> {
    try {
      const response = await this.requestJson<HccServersResponse>(
        'GET',
        '/api/v2/system/mcpservers'
      )
      this.cache = response.servers.map(server => this.toServerRoute(server))
      this.lastSuccessfulPoll = Date.now()
      return this.cache
    } catch (error) {
      proxyLogger.warn('hcc_inventory_poll_failed', {
        code: error instanceof HccAuthorizationError ? error.code : 'unavailable',
      })
      return this.cache
    }
  }

  async authorizeForward(
    serverName: string,
    hostBearer: string
  ): Promise<HccForwardAuthorization> {
    if (!hostBearer.trim()) throw new HccAuthorizationError('unauthorized')
    return this.requestJson<HccForwardAuthorization>(
      'POST',
      '/api/v2/system/mcpservers/authorize',
      {
        'X-Clerum-Host-Authorization': `${BEARER_SCHEME} ${hostBearer}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ serverName })
    )
  }

  getCachedServers(): ServerRoute[] {
    return this.cache
  }

  isCacheStale(): boolean {
    if (this.lastSuccessfulPoll === 0) return true
    return Date.now() - this.lastSuccessfulPoll > this.config.hccCacheTTL
  }

  isCacheExpired(): boolean {
    if (this.lastSuccessfulPoll === 0) return true
    return Date.now() - this.lastSuccessfulPoll > this.config.hccCacheExpiry
  }

  getLastPollTime(): number {
    return this.lastSuccessfulPoll
  }

  private toServerRoute(server: HccServerInfo): ServerRoute {
    const url =
      server.transport.url ||
      `http://${server.name}.mcp-server.svc.cluster.local:3000/mcp`
    return {
      name: server.name,
      url,
      contextRef: server.contextRef,
      managed: server.enabled,
      ready: server.status.ready,
      port: this.extractPort(url),
    }
  }

  private extractPort(url: string): number {
    try {
      const parsed = new URL(url)
      return parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80)
    } catch {
      return 3000
    }
  }

  private async requestJson<T>(
    method: string,
    path: string,
    extraHeaders: Record<string, string> = {},
    body?: string
  ): Promise<T> {
    let systemIdentity: string
    try {
      systemIdentity = await this.readSystemIdentity()
    } catch {
      throw new HccAuthorizationError('unavailable')
    }
    if (!systemIdentity.trim()) throw new HccAuthorizationError('unavailable')

    const response = await this.httpRequest(
      method,
      path,
      {
        Accept: 'application/json',
        Authorization: `${BEARER_SCHEME} ${systemIdentity}`,
        ...extraHeaders,
      },
      body
    )
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new HccAuthorizationError(this.statusToCode(response.statusCode))
    }
    try {
      return JSON.parse(response.body) as T
    } catch {
      throw new HccAuthorizationError('unavailable')
    }
  }

  private statusToCode(status: number): HccAuthorizationErrorCode {
    if (status === 400) return 'bad_request'
    if (status === 401) return 'unauthorized'
    if (status === 403) return 'forbidden'
    return 'unavailable'
  }

  private httpRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      let parsed: URL
      try {
        parsed = new URL(this.config.hccApiUrl)
      } catch {
        reject(new HccAuthorizationError('unavailable'))
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new HccAuthorizationError('unavailable'))
        return
      }
      const requestHeaders = { ...headers }
      if (body !== undefined) {
        requestHeaders['Content-Length'] = String(Buffer.byteLength(body))
      }
      const requestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path,
        method,
        headers: requestHeaders,
        timeout: this.config.requestTimeout,
      }
      const requestModule = parsed.protocol === 'https:' ? https : http
      const request = requestModule.request(requestOptions, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > MAX_HCC_RESPONSE_BYTES) {
            response.destroy()
            reject(new HccAuthorizationError('unavailable'))
            return
          }
          chunks.push(buffer)
        })
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        response.on('error', () => reject(new HccAuthorizationError('unavailable')))
      })
      request.on('error', error => {
        proxyLogger.warn('hcc_request_failed', {
          method,
          path,
          reason: error instanceof Error ? error.name : 'unknown',
        })
        reject(new HccAuthorizationError('unavailable'))
      })
      request.on('timeout', () => {
        request.destroy()
        reject(new HccAuthorizationError('unavailable'))
      })
      if (body !== undefined) request.write(body)
      request.end()
    })
  }
}
