import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { decodeRuntimeJwtScopes } from '../workflow/mcpHostRuntimeJwt'
import type { GfscWriteClient } from './gfs'

const DIRECT_KEY = 'MCP_HOST_GFS_TOKEN'
const FILE_KEY = 'MCP_HOST_GFS_TOKEN_FILE'
const AUTH_HEADER = 'authorization'
const AUTH_SCHEME = 'Bearer'

export const DEFAULT_GFS_ACCESS_FILE = '/var/run/clerum/workflow-tokens/mcp-host-gfs-token'
export const DEFAULT_GFSC_BASE_URL = 'http://gfsc.gfs.svc.cluster.local:8087'
export const DEFAULT_GFSC_WRITE_BASE_URL = 'http://gfsc-writer.gfs.svc.cluster.local:8087'

export interface GfsRuntimeEnv {
  get(key: string): string | undefined
  readFile?(path: string): Promise<string>
  readFileSync?(path: string): string
  fileExists?(path: string): boolean
  fetch?(input: string, init?: RequestInit): Promise<Response>
}

export type GfsToolScope = 'gfs.read' | 'gfs.write'

/**
 * Read the mounted token only to advertise its supported native tools. This is
 * deliberately fail-closed and is not an authorization boundary: gfsc still
 * verifies the same bearer token and evaluates the permission store.
 */
export function getGfsToolScopes(env: GfsRuntimeEnv): ReadonlySet<GfsToolScope> | null {
  try {
    const direct = envValue(env, DIRECT_KEY)
    const token = direct
      ? direct
      : (env.readFileSync ?? ((path: string) => readFileSync(path, 'utf8')))(
          envValue(env, FILE_KEY, DEFAULT_GFS_ACCESS_FILE)
        ).trim()
    if (!token) return null
    const scopes = decodeRuntimeJwtScopes(token)
    if (
      !scopes ||
      scopes.length === 0 ||
      !scopes.every((scope): scope is GfsToolScope => scope === 'gfs.read' || scope === 'gfs.write')
    ) {
      return null
    }
    return new Set(scopes)
  } catch {
    return null
  }
}

function envValue(env: GfsRuntimeEnv, key: string, fallback = ''): string {
  const value = env.get(key)?.trim()
  return value && value.length > 0 ? value : fallback
}

export function hasGfsRuntimeAccess(env: GfsRuntimeEnv): boolean {
  if (envValue(env, DIRECT_KEY)) return true
  const filePath = envValue(env, FILE_KEY, DEFAULT_GFS_ACCESS_FILE)
  return (env.fileExists ?? existsSync)(filePath)
}

/**
 * A non-2xx answer from gfsc. The message keeps the `gfsc <status>: …` prefix
 * that `redactedFail` parses. `retryAfterSeconds` is set only on a 429, from
 * gfsc's `Retry-After` header when it is a positive integer of seconds.
 */
export class GfscHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterSeconds?: number
  ) {
    super(
      `gfsc ${status}: ${detail}` +
        (retryAfterSeconds === undefined ? '' : ` (retry after ${retryAfterSeconds}s)`)
    )
    this.name = 'GfscHttpError'
  }
}

export interface GfscClientOptions {
  /**
   * The longest `Retry-After` the client will sleep through before its single
   * retry: the calling tool's timeout. A longer advertised delay fails at once
   * instead of sleeping into that timeout. Time already spent inside the same
   * tool call is not subtracted; against gfsc's 60 s window and the default
   * tool budget that difference is not reachable.
   */
  maxRetryWaitMs: number
}

function retryAfterHeader(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')?.trim()
  return raw !== undefined && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : undefined
}

export function createGfscClient(env: GfsRuntimeEnv, options: GfscClientOptions): GfscWriteClient {
  const { maxRetryWaitMs } = options
  if (!Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0) {
    throw new Error(
      `gfsc client maxRetryWaitMs must be a non-negative number, got ${maxRetryWaitMs}`
    )
  }
  const fetchFn = env.fetch ?? fetch
  const readerBase = envValue(env, 'MCP_HOST_GFSC_BASE_URL', DEFAULT_GFSC_BASE_URL).replace(
    /\/+$/,
    ''
  )
  const writerBase = envValue(
    env,
    'MCP_HOST_GFSC_WRITER_BASE_URL',
    DEFAULT_GFSC_WRITE_BASE_URL
  ).replace(/\/+$/, '')
  const readFileFn = env.readFile ?? ((path: string) => readFile(path, 'utf8'))

  async function accessValue(): Promise<string> {
    const direct = envValue(env, DIRECT_KEY)
    if (direct) return direct
    const filePath = envValue(env, FILE_KEY, DEFAULT_GFS_ACCESS_FILE)
    const value = (await readFileFn(filePath)).trim()
    if (!value) throw new Error(`${FILE_KEY} is empty`)
    return value
  }

  async function send(baseUrl: string, path: string, init: RequestInit): Promise<Response> {
    return fetchFn(`${baseUrl}${path}`, {
      ...init,
      headers: {
        [AUTH_HEADER]: `${AUTH_SCHEME} ${await accessValue()}`,
        ...(init.headers ?? {}),
      },
    })
  }

  async function httpError(res: Response): Promise<GfscHttpError> {
    const body = await res.text().catch(() => '')
    const retryAfter = res.status === 429 ? retryAfterHeader(res) : undefined
    return new GfscHttpError(res.status, body || res.statusText, retryAfter)
  }

  async function decode(res: Response): Promise<unknown> {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) return res.json()
    return res.text()
  }

  // A 429 that states a delay is retried once, after that delay. gfsc's agent
  // limiter answers before the permission store and the executor run, so the
  // denied attempt had no effect and repeating a write is safe. A 429 without a
  // delay, a delay beyond maxRetryWaitMs, or a second denial fails at once.
  async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const first = await send(baseUrl, path, init)
    if (first.ok) return decode(first)
    const denied = await httpError(first)
    const waitSeconds = denied.retryAfterSeconds
    if (denied.status !== 429 || waitSeconds === undefined || waitSeconds * 1000 > maxRetryWaitMs) {
      throw denied
    }
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000))
    const second = await send(baseUrl, path, init)
    if (second.ok) return decode(second)
    throw await httpError(second)
  }

  return {
    accessible: ({ drive, cursor }) => {
      const q = new URLSearchParams({ drive })
      if (cursor) q.set('cursor', cursor)
      return request(readerBase, `/v1/accessible?${q}`)
    },
    list: ({ drive, resourceId, cursor }) => {
      const q = new URLSearchParams({ drive })
      if (cursor) q.set('cursor', cursor)
      return request(readerBase, `/v1/resources/${encodeURIComponent(resourceId)}/children?${q}`)
    },
    read: ({ drive, resourceId }) =>
      request(
        readerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}/content?drive=${encodeURIComponent(drive)}`
      ),
    stat: ({ drive, resourceId }) =>
      request(
        readerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}?drive=${encodeURIComponent(drive)}`
      ),
    resolve: ({ uri }) => request(readerBase, `/v1/resolve?uri=${encodeURIComponent(uri)}`),
    write: ({ drive, resourceId, content, ifMatch }) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}/content?drive=${encodeURIComponent(drive)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, ifMatch }),
        }
      ),
    createFile: ({ drive, parentResourceId, name, content }) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(parentResourceId)}/children?drive=${encodeURIComponent(drive)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, kind: 'file', content }),
        }
      ),
    createFolder: ({ drive, parentResourceId, name }) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(parentResourceId)}/children?drive=${encodeURIComponent(drive)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, kind: 'directory' }),
        }
      ),
    rename: ({ drive, resourceId, newName, ifMatch }) =>
      request(writerBase, `/v1/resources/${encodeURIComponent(resourceId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drive, newName, ifMatch }),
      }),
    copy: args =>
      request(writerBase, '/v1/copy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      }),
  }
}
