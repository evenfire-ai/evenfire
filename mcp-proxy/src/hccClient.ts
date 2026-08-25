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
  schemaVersion: 1
  serverName: string
  targetUrl: string
  destinationRevision: string
}

export type SystemIdentityReader = () => Promise<string>

const BEARER_SCHEME = 'Bearer'
const MAX_HCC_RESPONSE_BYTES = 1_048_576
const SERVER_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseSafeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new HccAuthorizationError('unavailable')
  }
  try {
    const parsed = new URL(value)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search ||
      !parsed.pathname.startsWith('/')
    ) {
      throw new Error('invalid HCC URL')
    }
    return parsed.toString()
  } catch {
    throw new HccAuthorizationError('unavailable')
  }
}

function parseOptionalSafeUrl(value: unknown): string | undefined {
  return value === undefined ? undefined : parseSafeUrl(value)
}

function parseInventoryResponse(payload: unknown): HccServersResponse {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ['schemaVersion', 'servers', 'timestamp']) ||
    payload.schemaVersion !== 1 ||
    !Array.isArray(payload.servers) ||
    typeof payload.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(payload.timestamp))
  ) {
    throw new HccAuthorizationError('unavailable')
  }

  const serverNames = new Set<string>()
  const servers = payload.servers.map(value => {
    const requiredServerKeys = [
      'name',
      'contextRef',
      'transport',
      'enabled',
      'status',
      'destinationRevision',
    ]
    if (
      !isRecord(value) ||
      !Object.keys(value).every(key => requiredServerKeys.includes(key)) ||
      requiredServerKeys.some(key => !Object.hasOwn(value, key)) ||
      typeof value.name !== 'string' ||
      value.name.length > 253 ||
      !SERVER_NAME_RE.test(value.name) ||
      typeof value.contextRef !== 'string' ||
      value.contextRef.length > 253 ||
      !SERVER_NAME_RE.test(value.contextRef) ||
      typeof value.enabled !== 'boolean' ||
      typeof value.destinationRevision !== 'string' ||
      !value.destinationRevision
    ) {
      throw new HccAuthorizationError('unavailable')
    }
    if (serverNames.has(value.name)) {
      throw new HccAuthorizationError('unavailable')
    }
    serverNames.add(value.name)
    if (
      !isRecord(value.transport) ||
      !Object.keys(value.transport).every(key => key === 'type' || key === 'url') ||
      !Object.hasOwn(value.transport, 'type')
    ) {
      throw new HccAuthorizationError('unavailable')
    }
    if (
      typeof value.transport.type !== 'string' ||
      !value.transport.type ||
      value.transport.type.length > 32
    ) {
      throw new HccAuthorizationError('unavailable')
    }
    const url = parseOptionalSafeUrl(value.transport.url)
    if (!isRecord(value.status)) throw new HccAuthorizationError('unavailable')
    const statusKeys = ['deployed', 'ready', 'authoritative']
    const actualStatusKeys = Object.keys(value.status)
    if (
      actualStatusKeys.some(key => !statusKeys.includes(key)) ||
      typeof value.status.deployed !== 'boolean' ||
      typeof value.status.ready !== 'boolean' ||
      (value.status.authoritative !== undefined &&
        typeof value.status.authoritative !== 'boolean')
    ) {
      throw new HccAuthorizationError('unavailable')
    }
    return {
      name: value.name,
      contextRef: value.contextRef,
      transport: { type: value.transport.type, url },
      enabled: value.enabled,
      status: {
        deployed: value.status.deployed,
        ready: value.status.ready,
        ...(typeof value.status.authoritative === 'boolean'
          ? { authoritative: value.status.authoritative }
          : {}),
      },
      destinationRevision: value.destinationRevision,
    }
  })
  return { schemaVersion: 1, servers, timestamp: payload.timestamp }
}

function parseForwardAuthorization(payload: unknown): HccForwardAuthorization {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ['schemaVersion', 'serverName', 'targetUrl', 'destinationRevision']) ||
    payload.schemaVersion !== 1 ||
    typeof payload.serverName !== 'string' ||
    payload.serverName.length > 253 ||
    !SERVER_NAME_RE.test(payload.serverName) ||
    typeof payload.destinationRevision !== 'string' ||
    !payload.destinationRevision
  ) {
    throw new HccAuthorizationError('unavailable')
  }
  return {
    schemaVersion: 1,
    serverName: payload.serverName,
    targetUrl: parseSafeUrl(payload.targetUrl),
    destinationRevision: payload.destinationRevision,
  }
}

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
      const response = parseInventoryResponse(
        await this.requestJson<unknown>('GET', '/api/v2/system/mcpservers')
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
    const authorization = parseForwardAuthorization(
      await this.requestJson<unknown>(
        'POST',
        '/api/v2/system/mcpservers/authorize',
        {
          'X-Clerum-Host-Authorization': `${BEARER_SCHEME} ${hostBearer}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ serverName })
      )
    )
    if (authorization.serverName !== serverName) {
      throw new HccAuthorizationError('unavailable')
    }
    return authorization
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
