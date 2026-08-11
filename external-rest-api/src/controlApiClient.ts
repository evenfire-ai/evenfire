import { config } from './config.js'

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

// Response headers are an API contract only where a caller can safely act on
// them. In particular, never relay Set-Cookie, server identity, CORS, or
// arbitrary proxy headers from the internal control-api boundary.
const FORWARDABLE_RESPONSE_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
] as const

export class ControlApiError extends Error {
  status: number
  body: unknown
  headers: Record<string, string>
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ) {
    super(message)
    this.name = 'ControlApiError'
    this.status = status
    this.body = body
    this.headers = headers
  }
}

function forwardableResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of FORWARDABLE_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

function buildUrl(path: string, query?: Record<string, string | undefined>): string {
  const base = config.controlApiBaseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${base}${normalizedPath}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value)
      }
    }
  }
  return url.toString()
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    return error instanceof Error
      ? `Failed to read error body: ${error.message}`
      : 'Failed to read error body'
  }
}

export interface ControlApiResponse<T> {
  data: T
  status: number
}

export async function controlApiRequestWithStatus<T>(
  method: RequestMethod,
  path: string,
  options?: {
    query?: Record<string, string | undefined>
    body?: unknown
    userSessionToken?: string
    extraHeaders?: Record<string, string>
  }
): Promise<ControlApiResponse<T>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.controlApiServiceToken}`,
    'x-service-token': config.controlApiServiceName,
  }
  if (options?.userSessionToken) {
    headers['x-user-session-token'] = options.userSessionToken
  }
  if (options?.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }

  const response = await fetch(buildUrl(path, options?.query), {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  const raw = await response.text()
  let parsed: unknown = null
  let parseError = false
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      // Intermediate proxies (e.g. the profile-control-funnel nginx) can
      // return an HTML error body when a path is blocked. Surface it as a
      // structured 502 upstream error instead of propagating a raw
      // SyntaxError through Express' default error handler (which masks it
      // as an opaque 500).
      parseError = true
    }
  }

  if (parseError) {
    throw new ControlApiError(
      `Control API ${method} ${path} returned non-JSON body (status=${response.status})`,
      502,
      { error: 'Upstream returned non-JSON body', status: response.status },
      forwardableResponseHeaders(response)
    )
  }

  if (!response.ok) {
    const errorMessage =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : raw
    throw new ControlApiError(
      `Control API ${method} ${path} failed (${response.status}): ${errorMessage}`,
      response.status,
      parsed,
      forwardableResponseHeaders(response)
    )
  }

  return { data: parsed as T, status: response.status }
}

export async function controlApiRequest<T>(
  method: RequestMethod,
  path: string,
  options?: {
    query?: Record<string, string | undefined>
    body?: unknown
    userSessionToken?: string
    extraHeaders?: Record<string, string>
  }
): Promise<T> {
  const result = await controlApiRequestWithStatus<T>(method, path, options)
  return result.data
}

export async function controlApiBinaryRequestWithStatus(
  method: 'GET',
  path: string,
  options?: {
    query?: Record<string, string | undefined>
    userSessionToken?: string
    extraHeaders?: Record<string, string>
  }
): Promise<{ body: Buffer; status: number; headers: Record<string, string> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.controlApiServiceToken}`,
    'x-service-token': config.controlApiServiceName,
  }
  if (options?.userSessionToken) {
    headers['x-user-session-token'] = options.userSessionToken
  }
  if (options?.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }

  const response = await fetch(buildUrl(path, options?.query), { method, headers })
  if (!response.ok) {
    let parsed: unknown = null
    const raw = await readResponseText(response)
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = { error: raw || response.statusText }
    }
    throw new ControlApiError(
      `Control API ${method} ${path} failed (${response.status})`,
      response.status,
      parsed,
      forwardableResponseHeaders(response)
    )
  }

  const responseHeaders: Record<string, string> = {
    'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
  }
  const contentLength = response.headers.get('content-length')
  const contentDisposition = response.headers.get('content-disposition')
  if (contentLength) responseHeaders['content-length'] = contentLength
  if (contentDisposition) responseHeaders['content-disposition'] = contentDisposition

  return {
    body: Buffer.from(await response.arrayBuffer()),
    status: response.status,
    headers: responseHeaders,
  }
}

export async function controlApiStreamRequest(
  method: 'GET',
  path: string,
  options?: {
    query?: Record<string, string | undefined>
    userSessionToken?: string
    extraHeaders?: Record<string, string>
    signal?: AbortSignal
  }
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.controlApiServiceToken}`,
    'x-service-token': config.controlApiServiceName,
  }
  if (options?.userSessionToken) {
    headers['x-user-session-token'] = options.userSessionToken
  }
  if (options?.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }

  const response = await fetch(buildUrl(path, options?.query), {
    method,
    headers,
    signal: options?.signal,
  })
  if (!response.ok) {
    let parsed: unknown = null
    const raw = await readResponseText(response)
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = { error: raw || response.statusText }
    }
    throw new ControlApiError(
      `Control API ${method} ${path} failed (${response.status})`,
      response.status,
      parsed,
      forwardableResponseHeaders(response)
    )
  }
  return response
}

/**
 * PUBLIC passthrough GET to control-api. Unlike the other helpers this does NOT
 * parse JSON, attach a user session, or throw on a non-2xx status — it relays
 * control-api's response verbatim (status, content-type, body). Used by the OAuth
 * callback route, where the provider redirects the user's browser to a public,
 * state-authenticated control-api endpoint that returns an HTML page on success
 * or a JSON error otherwise. `rawQueryString` (leading '?') is appended as-is so
 * the signed `state` and `code` are never re-encoded.
 */
export async function controlApiPassthroughGet(
  path: string,
  rawQueryString: string
): Promise<{ status: number; contentType: string; body: string }> {
  const base = config.controlApiBaseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const response = await fetch(`${base}${normalizedPath}${rawQueryString}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${config.controlApiServiceToken}`,
      'x-service-token': config.controlApiServiceName,
    },
  })
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'text/plain; charset=utf-8',
    body: await response.text(),
  }
}
