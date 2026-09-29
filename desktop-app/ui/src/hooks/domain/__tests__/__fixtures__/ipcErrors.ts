import { ApiError } from '../../../../../../src/httpClient'
import { RpcProxyClient } from '../../../../../../src/rpcProxyClient'

/**
 * Renderer-side error fixtures built from the REAL main-process producers.
 *
 * A main-process rejection never reaches the renderer as the producer's own
 * Error: `ipcRenderer.invoke` rejects with a new Error whose message is
 * `Error invoking remote method '<channel>': <String(error)>`. Every
 * classifier in `lib/format.ts` therefore parses that wrapped string, and a
 * fixture written by hand without the prefix (or with a message no producer
 * emits) certifies a parser that production never exercises (R2-B1).
 *
 * Each builder below drives the real producer (`RpcProxyClient` over a stubbed
 * `fetch`, `ApiError`, the `AppService` availability mapping) and wraps the
 * result exactly the way Electron does.
 */

const RPC_TOKEN = 'rpc-token'

/** rpc-proxy's own Host-access denial body (cross-layer contract, R1-M6). */
const HOST_ACCESS_DENIAL_ERROR = 'Forbidden: user cannot access this host'

export type RpcChannel =
  | 'rpc:listSessions'
  | 'rpc:loadSessionMessages'
  | 'rpc:renameSession'
  | 'rpc:invokeHostMessage'
  | 'rpc:getTaskResult'

/** The rejection `ipcRenderer.invoke` produces for a main-process throw. */
export function wrapLikeElectronIpc(channel: string, error: Error): Error {
  return new Error(`Error invoking remote method '${channel}': ${String(error)}`)
}

function jsonResponse(status: number, statusText: string, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Run one RpcProxyClient call against a single canned response and return the
 * Error it throws. Fails loudly when the producer resolves instead: a fixture
 * builder that silently returned nothing would hand the test an `undefined`.
 */
async function rejectionOf(
  response: Response,
  call: (client: RpcProxyClient) => Promise<unknown>
): Promise<Error> {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return response.clone()
  }) as typeof fetch
  try {
    await call(new RpcProxyClient())
  } catch (error) {
    if (fetchCalls === 0) {
      throw new Error(`producer rejected before calling fetch: ${String(error)}`)
    }
    if (!(error instanceof Error)) throw new Error(`producer threw a non-Error: ${String(error)}`)
    return error
  } finally {
    globalThis.fetch = originalFetch
  }
  throw new Error(`producer resolved for HTTP ${response.status}; expected a rejection`)
}

function callFor(channel: RpcChannel): (client: RpcProxyClient) => Promise<unknown> {
  switch (channel) {
    case 'rpc:listSessions':
      return client => client.listSessions(RPC_TOKEN, 'agent-x', { agent: 'agent-x', limit: 1 })
    case 'rpc:loadSessionMessages':
      return client => client.loadSessionMessages(RPC_TOKEN, 'agent-x', 'agent-x', 'chat-1')
    case 'rpc:renameSession':
      return client => client.renameSession(RPC_TOKEN, 'agent-x', 'agent-x', 'chat-1', 'Title')
    case 'rpc:invokeHostMessage':
      return client =>
        client.invokeHostMessage(RPC_TOKEN, 'agent-x', { content: 'hello' }, { async: true })
    case 'rpc:getTaskResult':
      return client => client.getTaskResult(RPC_TOKEN, 'agent-x', 'task-1')
  }
}

/**
 * rpc-proxy's own authorization denial for a user whose access was removed
 * (`code: 'host_access_revoked'`), as the real RpcProxyClient projects it for
 * `channel`, wrapped by IPC.
 */
export async function ipcHostAccessRevoked(channel: RpcChannel): Promise<Error> {
  const error = await rejectionOf(
    jsonResponse(403, 'Forbidden', {
      error: HOST_ACCESS_DENIAL_ERROR,
      code: 'host_access_revoked',
    }),
    callFor(channel)
  )
  return wrapLikeElectronIpc(channel, error)
}

/**
 * rpc-proxy's own denial that is NOT a removal (`code: 'host_access_denied'`,
 * e.g. a disabled Host). The renderer must treat it as an uncertain 403.
 */
export async function ipcHostAccessDenied(channel: RpcChannel): Promise<Error> {
  const error = await rejectionOf(
    jsonResponse(403, 'Forbidden', {
      error: HOST_ACCESS_DENIAL_ERROR,
      code: 'host_access_denied',
    }),
    callFor(channel)
  )
  return wrapLikeElectronIpc(channel, error)
}

/**
 * A 403 that does not confirm revocation: an arbitrary upstream 403 body
 * (for example a scope denial passed through from mcp-host).
 */
export async function ipcGenericForbidden(channel: RpcChannel): Promise<Error> {
  const error = await rejectionOf(
    jsonResponse(403, 'Forbidden', { error: 'missing send scope' }),
    callFor(channel)
  )
  return wrapLikeElectronIpc(channel, error)
}

/** A plain HTTP failure through the real producer for `channel`. */
export async function ipcHttpError(
  channel: RpcChannel,
  status: number,
  statusText: string,
  body: unknown
): Promise<Error> {
  const error = await rejectionOf(jsonResponse(status, statusText, body), callFor(channel))
  return wrapLikeElectronIpc(channel, error)
}

/**
 * The "503 body mentions 403" case: a server error whose body text carries an
 * authorization status. Only the response status may classify it.
 */
export function ipcServerErrorMentioning403(channel: RpcChannel): Promise<Error> {
  return ipcHttpError(channel, 503, 'Service Unavailable', {
    error: 'upstream returned 403 Forbidden',
  })
}

/**
 * The exact `AppService.toHostAvailabilityError` text for a waking Host whose
 * name contains a status-looking number (R1-M16: `support-401 is waking`).
 * `AppService` pulls in Electron main-process modules, so the mapping's text
 * is reproduced here; `appService.hostWaking.test.ts` pins the producer side.
 */
export function ipcHostWaking(channel: RpcChannel, hostRef: string): Error {
  const cause = new ApiError(
    '503 Service Unavailable: Host is waking up',
    503,
    JSON.stringify({ code: 'host_waking', hostRef, retryAfterMs: 2000 })
  )
  if (!cause.bodyText.includes('"host_waking"')) throw new Error('fixture lost its code')
  return wrapLikeElectronIpc(
    channel,
    new Error(`host_waking: agent host "${hostRef}" is waking up — retry shortly`)
  )
}
