import { requestJson, withTimeout } from '../httpClient.js'
import type { DesktopUploadTransport } from './upload.js'

/** Desktop Files always uses the signed-in user's GFS authority. */
export const GFS_USER_AUTHORITY_HEADER = { 'X-Evenfire-Gfs-Authority': 'user' } as const

function userAuthorityHeaders(headers?: Record<string, string>): Record<string, string> {
  const result = new Headers(headers)
  result.set('X-Evenfire-Gfs-Authority', 'user')
  return Object.fromEntries(result.entries())
}

export const requestGfsJson: typeof requestJson = (method, url, options) =>
  requestJson(method, url, {
    ...options,
    headers: userAuthorityHeaders(options?.headers),
  })

export const gfsUploadTransport: DesktopUploadTransport = {
  requestJson: requestGfsJson,
  requestPart: async (url, token, headers, body, timeoutMs, signal) => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: userAuthorityHeaders({ authorization: `Bearer ${token}`, ...headers }),
      body: body as unknown as BodyInit,
      // Node's fetch requires this opt-in for a streaming request body.
      duplex: 'half',
      signal: withTimeout(signal, timeoutMs),
    } as RequestInit & { duplex: 'half' })
    const text = await response.text()
    return {
      status: response.status,
      text,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    }
  },
}
