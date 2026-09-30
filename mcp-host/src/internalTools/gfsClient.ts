import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { withAbort } from '../core/adapters/abortableLlmPort'
import { decodeRuntimeJwtScopes } from '../workflow/mcpHostRuntimeJwt'
import type { GfscCallOptions, GfscWriteClient } from './gfs'
import { boundedGfsErrorDetail, readGfsContent } from './gfsContentRead'

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
 * What the Host's GFS token says about the native tools it can serve.
 * - `not_configured`: no direct token and no token file at the default path.
 * - `token_unreadable`: the configured token file cannot be read, or is empty.
 * - `token_undecodable`: the token is not a JWT with a list of string scopes.
 * - `scope_outside_allowlist`: a scope other than `gfs.read`/`gfs.write`.
 * - `ok`: the scopes, possibly none.
 */
export type GfsToolScopeInspection =
  | { status: 'ok'; scopes: ReadonlySet<GfsToolScope> }
  | { status: 'not_configured' }
  | { status: 'token_unreadable' }
  | { status: 'token_undecodable' }
  | { status: 'scope_outside_allowlist' }

/**
 * Read the mounted token only to learn which native GFS tools it can serve.
 * This is not an authorization boundary: gfsc still verifies the same bearer
 * token and evaluates the permission store.
 */
export function inspectGfsToolScopes(env: GfsRuntimeEnv): GfsToolScopeInspection {
  let token = envValue(env, DIRECT_KEY)
  if (!token) {
    const configuredPath = envValue(env, FILE_KEY)
    try {
      token = (env.readFileSync ?? ((path: string) => readFileSync(path, 'utf8')))(
        configuredPath || DEFAULT_GFS_ACCESS_FILE
      ).trim()
    } catch (error) {
      // Only the default path may be absent: a configured path that cannot be
      // read is a broken mount, not a Host without GFS.
      if (!configuredPath && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return { status: 'not_configured' }
      return { status: 'token_unreadable' }
    }
    if (!token) return { status: 'token_unreadable' }
  }
  const scopes = decodeRuntimeJwtScopes(token)
  if (!scopes) return { status: 'token_undecodable' }
  if (
    !scopes.every((scope): scope is GfsToolScope => scope === 'gfs.read' || scope === 'gfs.write')
  )
    return { status: 'scope_outside_allowlist' }
  return { status: 'ok', scopes: new Set(scopes) }
}

/**
 * The scopes that advertise native GFS tools, or null when there are none.
 * This is deliberately fail-closed: every status other than `ok` with at least
 * one scope is null.
 */
export function getGfsToolScopes(env: GfsRuntimeEnv): ReadonlySet<GfsToolScope> | null {
  try {
    const inspection = inspectGfsToolScopes(env)
    return inspection.status === 'ok' && inspection.scopes.size > 0 ? inspection.scopes : null
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
   * retry, for any call. Each call is further bounded by its own
   * `GfscCallOptions.deadlineMs`, the time left in the tool call that issued
   * it: a delay that does not fit in the smaller of the two fails at once
   * instead of sleeping into the caller's timeout.
   */
  maxRetryWaitMs: number
  /**
   * Source of the retry jitter, a number in [0, 1). Parallel agents denied in
   * the same second would otherwise all retry in the same instant.
   */
  random?: () => number
}

// gfsc's agent limiter answers with these scopes (serve.ts). Its other 429s,
// such as the upload-session quotas, are not cleared by waiting a few
// seconds, so they are surfaced at once.
const RETRYABLE_SCOPES = new Set(['agent_reads', 'agent_writes'])
const MAX_RETRY_AFTER_SECONDS = 3600
const MAX_JITTER_MS = 1000
const JITTER_FRACTION = 0.2

// A Retry-After outside 1..3600 whole seconds is treated as absent: the 429 is
// surfaced with no retry and no hint, so an absurd value never reaches the model.
function retryAfterHeader(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')?.trim()
  if (raw === undefined || !/^[1-9][0-9]{0,3}$/.test(raw)) return undefined
  const seconds = Number(raw)
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const wait = () =>
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    })
  if (!signal) return wait()
  return withAbort(wait, signal).finally(() => clearTimeout(timer))
}

export function createGfscClient(env: GfsRuntimeEnv, options: GfscClientOptions): GfscWriteClient {
  const { maxRetryWaitMs, random = Math.random } = options
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

  async function send(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
    return fetchFn(`${baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        ...headers,
        [AUTH_HEADER]: `${AUTH_SCHEME} ${await accessValue()}`,
      },
    })
  }

  async function httpError(res: Response, boundedSignal?: AbortSignal): Promise<GfscHttpError> {
    const body = boundedSignal
      ? await boundedGfsErrorDetail(res, boundedSignal)
      : await res.text().catch(() => '')
    const retryAfter = res.status === 429 ? retryAfterHeader(res) : undefined
    return new GfscHttpError(res.status, body || res.statusText, retryAfter)
  }

  async function decode(res: Response): Promise<unknown> {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) return res.json()
    return res.text()
  }

  // A 429 from gfsc's agent limiter that states a delay is retried once, after
  // that delay plus a bounded jitter. The limiter answers before the permission
  // store and the executor run, so the denied attempt had no effect and
  // repeating a write is safe. Any other 429 scope, a 429 without a delay, a
  // delay that does not fit in the caller's remaining budget, or a second
  // denial fails at once. The caller's signal cancels both requests and the
  // sleep between them.
  async function responseWithRetry(
    baseUrl: string,
    path: string,
    init: RequestInit = {},
    call: GfscCallOptions = {},
    boundedError = false
  ): Promise<Response> {
    const attempt: RequestInit = call.signal ? { ...init, signal: call.signal } : init
    const first = await send(baseUrl, path, attempt)
    if (first.ok) return first
    const denied = await httpError(first, boundedError ? call.signal : undefined)
    const retryAfterMs =
      denied.retryAfterSeconds === undefined ? undefined : denied.retryAfterSeconds * 1000
    const budgetMs = Math.min(
      maxRetryWaitMs,
      call.deadlineMs === undefined ? Number.POSITIVE_INFINITY : call.deadlineMs - Date.now()
    )
    if (
      denied.status !== 429 ||
      !RETRYABLE_SCOPES.has(first.headers.get('x-gfs-ratelimit-scope') ?? '') ||
      retryAfterMs === undefined ||
      retryAfterMs > budgetMs
    ) {
      throw denied
    }
    const jitterMs = Math.floor(random() * Math.min(MAX_JITTER_MS, JITTER_FRACTION * retryAfterMs))
    await sleep(Math.min(retryAfterMs + jitterMs, budgetMs), call.signal)
    const second = await send(baseUrl, path, attempt)
    if (second.ok) return second
    throw await httpError(second, boundedError ? call.signal : undefined)
  }

  async function request(
    baseUrl: string,
    path: string,
    init: RequestInit = {},
    call: GfscCallOptions = {}
  ): Promise<unknown> {
    return decode(await responseWithRetry(baseUrl, path, init, call))
  }

  return {
    accessible: ({ drive, cursor }, call) => {
      const q = new URLSearchParams({ drive })
      if (cursor) q.set('cursor', cursor)
      return request(readerBase, `/v1/accessible?${q}`, {}, call)
    },
    list: ({ drive, resourceId, cursor }, call) => {
      const q = new URLSearchParams({ drive })
      if (cursor) q.set('cursor', cursor)
      return request(
        readerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}/children?${q}`,
        {},
        call
      )
    },
    read: (args, options = {}) =>
      readGfsContent(
        (path, init, deadlineMs) =>
          responseWithRetry(
            readerBase,
            path,
            init,
            { signal: init.signal as AbortSignal, deadlineMs },
            true
          ),
        args,
        options
      ),
    stat: ({ drive, resourceId }, call) =>
      request(
        readerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}?drive=${encodeURIComponent(drive)}`,
        {},
        call
      ),
    resolve: ({ uri }, call) =>
      request(readerBase, `/v1/resolve?uri=${encodeURIComponent(uri)}`, {}, call),
    write: ({ drive, resourceId, content, ifMatch }, call) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}/content?drive=${encodeURIComponent(drive)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, ifMatch }),
        },
        call
      ),
    createFile: ({ drive, parentResourceId, name, content }, call) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(parentResourceId)}/children?drive=${encodeURIComponent(drive)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, kind: 'file', content }),
        },
        call
      ),
    createFolder: ({ drive, parentResourceId, name }, call) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(parentResourceId)}/children?drive=${encodeURIComponent(drive)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, kind: 'directory' }),
        },
        call
      ),
    rename: ({ drive, resourceId, newName, ifMatch }, call) =>
      request(
        writerBase,
        `/v1/resources/${encodeURIComponent(resourceId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ drive, newName, ifMatch }),
        },
        call
      ),
    copy: (args, call) =>
      request(
        writerBase,
        '/v1/copy',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        },
        call
      ),
  }
}
