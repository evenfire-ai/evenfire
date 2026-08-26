import { config } from './config.js'
import { ApiError, requestJson, withTimeout } from './httpClient.js'
import { assertSafeRouteSegment } from './pathSafety.js'
import {
  ApprovalDecisionResult,
  ContextBreakdownResult,
  HostActivitySnapshot,
  HostMessageRequest,
  HostMessageResponse,
  HostModelsResult,
  HostRuntimeHealth,
  HostRuntimeStatus,
  MessageToolStep,
  PendingApprovalLite,
  RpcAllowedServersResult,
  RpcConnectorsResult,
  SandboxUiApp,
  SessionLifecycleState,
  SessionMessagesQuery,
  SessionMessagesResult,
  SessionTokensLite,
  SessionsListQuery,
  SessionsListResult,
  SetHostModelResult,
} from './types.js'

export type { SandboxUiApp } from './types.js'

/**
 * The runtime rejected a model that is not in the operator allowlist (R2/R3).
 * The `model_not_allowed` token is preserved in the message so the renderer can
 * distinguish it from a transport error after the value crosses the IPC bridge
 * (Error objects serialize to their message string) — mirrors the `404` token
 * convention used by {@link RpcProxyClient.loadSessionMessages}.
 */
const MODEL_NOT_ALLOWED = 'model_not_allowed'

function wireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function wireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  return value
}

function optionalWireString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return wireString(value, label)
}

function wireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  optional = false
): number | undefined {
  if (optional && (value === undefined || value === null)) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function optionalWireBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`)
  return value
}

function parseSessionState(value: unknown, label: string): SessionLifecycleState | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'idle' || value === 'processing' || value === 'awaiting_approval') return value
  if (typeof value === 'string') return undefined
  throw new Error(`Invalid ${label}`)
}

function parsePendingApproval(value: unknown, label: string): PendingApprovalLite | undefined {
  if (value === undefined || value === null) return undefined
  const record = wireObject(value, label)
  // U5 (mcp-oauth reactive consent): `reason`/`mcpServerName`/`provider` are
  // additive. They ride the same REST wire as the generic approval descriptor
  // and MUST be surfaced so the renderer can branch a `connect_required`
  // suspension into an OAuth "Connect <provider>" affordance instead of a
  // generic tool approval. An absent `reason` (or any value other than
  // `connect_required`) keeps the byte-identical generic-approval flow.
  const reason = optionalWireString(record.reason, `${label}.reason`)
  const mcpServerName = optionalWireString(record.mcpServerName, `${label}.mcpServerName`)
  const provider = optionalWireString(record.provider, `${label}.provider`)
  return {
    requestId: wireString(record.requestId, `${label}.requestId`),
    displayName: wireString(record.displayName, `${label}.displayName`),
    ...(reason !== undefined ? { reason } : {}),
    ...(mcpServerName !== undefined ? { mcpServerName } : {}),
    ...(provider !== undefined ? { provider } : {}),
  }
}

function parseTokens(value: unknown, label: string): SessionTokensLite | undefined {
  if (value === undefined || value === null) return undefined
  const record = wireObject(value, label)
  return {
    input: wireSafeInteger(record.input, `${label}.input`, 0)!,
    output: wireSafeInteger(record.output, `${label}.output`, 0)!,
    ...(record.cacheRead !== undefined
      ? { cacheRead: wireSafeInteger(record.cacheRead, `${label}.cacheRead`, 0)! }
      : {}),
    ...(record.cacheWrite !== undefined
      ? { cacheWrite: wireSafeInteger(record.cacheWrite, `${label}.cacheWrite`, 0)! }
      : {}),
  }
}

function parseToolSteps(value: unknown, label: string): MessageToolStep[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value.map((step, index) => {
    const stepLabel = `${label}[${index}]`
    const record = wireObject(step, stepLabel)
    const state = record.state
    if (state !== 'completed' && state !== 'error') {
      throw new Error(`Invalid ${stepLabel}.state`)
    }
    return {
      toolName: wireString(record.toolName, `${stepLabel}.toolName`),
      displayName: wireString(record.displayName, `${stepLabel}.displayName`),
      state,
      ...(record.durationMs !== undefined
        ? { durationMs: wireSafeInteger(record.durationMs, `${stepLabel}.durationMs`, 0)! }
        : {}),
      ...(record.errorSummary !== undefined
        ? { errorSummary: wireString(record.errorSummary, `${stepLabel}.errorSummary`) }
        : {}),
    }
  })
}

function parseSessionsListResult(value: unknown): SessionsListResult {
  const record = wireObject(value, 'sessions response')
  if (!Array.isArray(record.items)) throw new Error('Invalid sessions response.items')
  let firstItemError: unknown
  let droppedItemCount = 0
  const items = record.items.flatMap((item, index): SessionsListResult['items'] => {
    try {
      const entry = wireObject(item, `sessions response.items[${index}]`)
      const state = parseSessionState(entry.state, `sessions response.items[${index}].state`)
      return [
        {
          agent: wireString(entry.agent, `sessions response.items[${index}].agent`),
          chatId: wireString(entry.chatId, `sessions response.items[${index}].chatId`),
          turnCount: wireSafeInteger(
            entry.turnCount,
            `sessions response.items[${index}].turnCount`,
            0
          )!,
          ...(entry.messageCount != null
            ? {
                messageCount: wireSafeInteger(
                  entry.messageCount,
                  `sessions response.items[${index}].messageCount`,
                  0
                )!,
              }
            : {}),
          lastActivityAt: wireString(
            entry.lastActivityAt,
            `sessions response.items[${index}].lastActivityAt`
          ),
          ...(state !== undefined ? { state } : {}),
          ...(entry.activeTaskId != null
            ? {
                activeTaskId: optionalWireString(
                  entry.activeTaskId,
                  `sessions response.items[${index}].activeTaskId`
                ),
              }
            : {}),
          ...(entry.pendingApproval != null
            ? {
                pendingApproval: parsePendingApproval(
                  entry.pendingApproval,
                  `sessions response.items[${index}].pendingApproval`
                ),
              }
            : {}),
          ...(entry.tokens != null
            ? { tokens: parseTokens(entry.tokens, `sessions response.items[${index}].tokens`) }
            : {}),
        },
      ]
    } catch (error) {
      firstItemError ??= error
      droppedItemCount += 1
      // R1-H1: a tolerant partial parse must not lose a session silently. A single
      // corrupt entry should not blank the whole sidebar (we still return the valid
      // items), but the drop has to leave a trace — otherwise a user's chat vanishes
      // from "Latest sessions" with no signal. Log the index + item error so the loss
      // is traceable in main-process logs, and count it into `droppedItemCount` below
      // so the renderer can observe that `items` is shorter than the server sent.
      console.warn(
        `[RpcProxyClient] Dropped malformed session catalog item at index ${index}:`,
        error
      )
      return []
    }
  })
  if (record.items.length > 0 && items.length === 0 && firstItemError) throw firstItemError
  return {
    items,
    ...(droppedItemCount > 0 ? { droppedItemCount } : {}),
    ...(record.nextCursor != null
      ? { nextCursor: wireString(record.nextCursor, 'sessions response.nextCursor') }
      : {}),
  }
}

function parseSessionMessagesResult(
  value: unknown,
  expectedAgent: string,
  expectedChatId: string
): SessionMessagesResult {
  const record = wireObject(value, 'session messages response')
  const agent = wireString(record.agent, 'session messages response.agent')
  const chatId = wireString(record.chatId, 'session messages response.chatId')
  if (agent !== expectedAgent || chatId !== expectedChatId) {
    throw new Error('Invalid session messages response identity')
  }
  if (!Array.isArray(record.turns)) throw new Error('Invalid session messages response.turns')
  const state = parseSessionState(record.state, 'session messages response.state')
  return {
    agent,
    chatId,
    ...(record.totalTurns != null
      ? {
          totalTurns: wireSafeInteger(
            record.totalTurns,
            'session messages response.totalTurns',
            0
          )!,
        }
      : {}),
    ...(record.oldestTurnNumber != null
      ? {
          oldestTurnNumber: wireSafeInteger(
            record.oldestTurnNumber,
            'session messages response.oldestTurnNumber',
            0
          )!,
        }
      : {}),
    ...(record.latestTurnNumber != null
      ? {
          latestTurnNumber: wireSafeInteger(
            record.latestTurnNumber,
            'session messages response.latestTurnNumber',
            0
          )!,
        }
      : {}),
    ...(record.hasMoreBefore != null
      ? {
          hasMoreBefore: optionalWireBoolean(
            record.hasMoreBefore,
            'session messages response.hasMoreBefore'
          ),
        }
      : {}),
    ...(record.hasMoreAfter != null
      ? {
          hasMoreAfter: optionalWireBoolean(
            record.hasMoreAfter,
            'session messages response.hasMoreAfter'
          ),
        }
      : {}),
    ...(state !== undefined ? { state } : {}),
    ...(record.activeTaskId != null
      ? {
          activeTaskId: optionalWireString(
            record.activeTaskId,
            'session messages response.activeTaskId'
          ),
        }
      : {}),
    ...(record.pendingApproval != null
      ? {
          pendingApproval: parsePendingApproval(
            record.pendingApproval,
            'session messages response.pendingApproval'
          ),
        }
      : {}),
    ...(record.tokens != null
      ? { tokens: parseTokens(record.tokens, 'session messages response.tokens') }
      : {}),
    turns: record.turns.map((turn, index) => {
      const entry = wireObject(turn, `session messages response.turns[${index}]`)
      return {
        number: wireSafeInteger(
          entry.number,
          `session messages response.turns[${index}].number`,
          0
        )!,
        user_input: wireString(
          entry.user_input,
          `session messages response.turns[${index}].user_input`
        ),
        ...(entry.response != null
          ? {
              response: optionalWireString(
                entry.response,
                `session messages response.turns[${index}].response`
              ),
            }
          : {}),
        started_at: wireString(
          entry.started_at,
          `session messages response.turns[${index}].started_at`
        ),
        ...(entry.completed_at != null
          ? {
              completed_at: optionalWireString(
                entry.completed_at,
                `session messages response.turns[${index}].completed_at`
              ),
            }
          : {}),
        ...(entry.tokens != null
          ? {
              tokens: parseTokens(entry.tokens, `session messages response.turns[${index}].tokens`),
            }
          : {}),
        ...(entry.tool_steps != null
          ? {
              tool_steps: parseToolSteps(
                entry.tool_steps,
                `session messages response.turns[${index}].tool_steps`
              ),
            }
          : {}),
      }
    }),
  }
}

/**
 * mcp-host answers HTTP 200 with `{success:false, error}` when an approval was
 * already decided by another channel (spec-v2 §4.7.4). Parse the body into a
 * structured result; a genuine non-ok HTTP still throws upstream.
 */
async function parseApprovalDecisionResponse(response: Response): Promise<ApprovalDecisionResult> {
  const text = await response.text()
  if (!text) return { success: true }
  try {
    const parsed = JSON.parse(text) as { success?: unknown; error?: unknown }
    if (parsed && parsed.success === false) {
      return {
        success: false,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      }
    }
    return { success: true }
  } catch {
    // A 200 with a non-JSON body historically meant success.
    return { success: true }
  }
}

function url(path: string): string {
  return `${config.rpcProxyBaseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Status mapping used by the renderer:
 *   401 / 403 → re-auth or lost ACL
 *   404       → app removed
 *   409       → app is updating; try again
 *   500 / 502 → generic open failure
 */
export class SandboxUiSessionError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(`sandbox-ui session mint failed (${status}): ${body || '<empty body>'}`)
    this.status = status
    this.body = body
    this.name = 'SandboxUiSessionError'
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    return error instanceof Error
      ? `Failed to read error body: ${error.message}`
      : 'Failed to read error body'
  }
}

/**
 * Extracts the `error` code from a JSON error body (e.g. `model_not_allowed`),
 * used to disambiguate error sources that share an HTTP status. Returns null for
 * non-JSON or code-less bodies.
 */
function errorCodeFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    return typeof parsed?.error === 'string' ? parsed.error : null
  } catch {
    return null
  }
}

export class RpcProxyClient {
  async health(): Promise<{ status: string }> {
    return requestJson<{ status: string }>('GET', url('/health'))
  }

  async listServers(rpcAccessToken: string): Promise<RpcAllowedServersResult> {
    return requestJson<RpcAllowedServersResult>('GET', url('/api/v1/rpc/servers'), {
      token: rpcAccessToken,
    })
  }

  /**
   * Proactive connectors read-model (spec 11 U2/U1) — the per-agent classified
   * fleet (`authorized`/`requires_setup`/`no_oauth`). Reuses the `mcp:servers:list`
   * scope (catalog read), like {@link listServers}; rpc-proxy derives the
   * `userId` from `auth.sub` and enumerates the agents server-side, so the token
   * only needs a valid host binding for the scope gate. Throws `ApiError` so
   * `AppService.shouldRefreshRpcToken` can drive the retry-after-refresh.
   */
  async getConnectors(rpcAccessToken: string): Promise<RpcConnectorsResult> {
    return requestJson<RpcConnectorsResult>('GET', url('/api/v1/rpc/connectors'), {
      token: rpcAccessToken,
    })
  }

  /**
   * Disconnect (revoke) an mcp-server's OAuth grant (spec 11 U4). Mirrors the
   * authorize-URL mint route but as a `DELETE`; the `userId` is derived by
   * rpc-proxy from `auth.sub` and is NEVER sent in the body (invariant 3). The
   * optional `contextId` is only a hint for the `oauth-context` flavor — control
   * -api resolves the authoritative Context server-side. Idempotent: a missing
   * grant answers 204. Throws `ApiError` (401/403-missing-scope → refresh retry).
   */
  async deleteMcpOauthGrant(
    rpcAccessToken: string,
    mcpServerName: string,
    contextId?: string
  ): Promise<void> {
    await requestJson<unknown>(
      'DELETE',
      url(`/api/v1/mcp-oauth/${encodeURIComponent(mcpServerName)}/grant`),
      {
        token: rpcAccessToken,
        // Body is optional; only send `contextId` when present. `userId` is NEVER
        // sent — rpc-proxy derives it from the JWT sub.
        body: contextId ? { contextId } : {},
      }
    )
  }

  async invokeHostMessage(
    rpcAccessToken: string,
    hostRef: string,
    payload: HostMessageRequest,
    options?: { async?: boolean }
  ): Promise<HostMessageResponse> {
    const query = options?.async ? '?async=true' : ''
    return requestJson<HostMessageResponse>(
      'POST',
      url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/messages${query}`),
      {
        token: rpcAccessToken,
        body: payload,
      }
    )
  }

  async getTaskResult(
    rpcAccessToken: string,
    hostRef: string,
    taskId: string
  ): Promise<HostMessageResponse> {
    return requestJson<HostMessageResponse>(
      'GET',
      url(
        `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/tasks/${encodeURIComponent(taskId)}/result`
      ),
      { token: rpcAccessToken }
    )
  }

  async getHostStatus(rpcAccessToken: string, hostRef: string): Promise<HostRuntimeStatus> {
    return requestJson<HostRuntimeStatus>(
      'GET',
      url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/status`),
      {
        token: rpcAccessToken,
      }
    )
  }

  /**
   * Pre-warms a stateless host: asks rpc-proxy to scale the suspended pod
   * back up so it is Ready before the user's first message. Every response on
   * the wake contract is terminal — no polling, no retry:
   *   200 {status:'active'}          host already running
   *   202 {status:'wake-requested'}  scale-up triggered
   *   409 {status:'not-stateless'}   always-on host; nothing to wake
   * Anything else (401/403/404/5xx) is an error for the caller to log.
   */
  async prewarmHost(rpcAccessToken: string, hostRef: string): Promise<{ status: string }> {
    const response = await fetch(url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/wake`), {
      method: 'POST',
      headers: { authorization: `Bearer ${rpcAccessToken}` },
    })
    if (response.status === 200 || response.status === 202 || response.status === 409) {
      const payload = (await response.json()) as { status?: string }
      const status = payload?.status
      if (status !== 'active' && status !== 'wake-requested' && status !== 'not-stateless') {
        throw new ApiError(
          `Prewarm returned a contract-violating body (${response.status}): status=${String(status)}`,
          response.status,
          JSON.stringify(payload)
        )
      }
      return { status }
    }
    const body = await readErrorBody(response)
    throw new ApiError(`Prewarm failed (${response.status}): ${body}`, response.status, body)
  }

  async getHostHealth(rpcAccessToken: string, hostRef: string): Promise<HostRuntimeHealth> {
    return requestJson<HostRuntimeHealth>(
      'GET',
      url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/health`),
      {
        token: rpcAccessToken,
      }
    )
  }

  async getHostActivity(
    rpcAccessToken: string,
    hostRef: string,
    options?: { limit?: number; sinceEventId?: string }
  ): Promise<HostActivitySnapshot> {
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.sinceEventId) params.set('sinceEventId', options.sinceEventId)
    const query = params.toString()
    return requestJson<HostActivitySnapshot>(
      'GET',
      url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/activity${query ? `?${query}` : ''}`),
      { token: rpcAccessToken }
    )
  }

  /**
   * List every UI-bearing recipe the user is allowlisted on.
   * The RPC JWT must carry the `sandbox:ui:view` scope (issued by control-api
   * when the user appears in user_workflow_triggers for any recipe
   * with a `ui:` block). The recipe ACL is re-checked per recipe on session
   * mint — this list is purely the picker payload.
   */
  async listSandboxUiApps(rpcAccessToken: string): Promise<{ apps: SandboxUiApp[] }> {
    return requestJson<{ apps: SandboxUiApp[] }>('GET', url('/api/v1/sandbox-ui/apps'), {
      token: rpcAccessToken,
    })
  }

  /**
   * Mint the per-recipe UI session cookie.
   *
   * Returns the raw Set-Cookie header value so the main process can hand it
   * off to the WebContentsView's session.cookies.set() — rpc-proxy issues a
   * Path-scoped cookie that must be installed into the embed's per-recipe
   * partition before any view/* request.
   *
   * 204 → cookie minted; the Set-Cookie response header is non-empty.
   * Other → throws a typed error so the caller can decide whether to retry,
   *         show a toast, or refuse to mount the view.
   */
  async mintSandboxUiSession(
    rpcAccessToken: string,
    recipeNs: string,
    recipeName: string
  ): Promise<{ setCookie: string }> {
    const response = await fetch(
      url(
        `/api/v1/sandbox-ui/${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/session`
      ),
      {
        method: 'POST',
        headers: { authorization: `Bearer ${rpcAccessToken}` },
      }
    )
    if (response.status !== 204) {
      const body = await response.text()
      throw new SandboxUiSessionError(response.status, body)
    }
    const setCookie = response.headers.get('set-cookie') ?? ''
    if (!setCookie) {
      throw new SandboxUiSessionError(500, 'session minted without Set-Cookie header')
    }
    return { setCookie }
  }

  /**
   * Spec §9.9 — fetch the provider authorize URL for an embed-initiated
   * OAuth flow. The desktop main process calls this when the embed
   * navigates to `clerum://oauth?clientId=…`; the returned URL is opened
   * in the OS browser via `shell.openExternal`. rpc-proxy constructs the
   * redirect_uri (control-api's public callback) and forwards to
   * control-api's internal endpoint with the user identity asserted from
   * the JWT sub.
   */
  async requestSandboxUiOauthAuthorizeUrl(
    rpcAccessToken: string,
    recipeNs: string,
    recipeName: string,
    oauthClientId: string,
    background = false
  ): Promise<{ authorizeUrl: string }> {
    const response = await fetch(
      url(
        `/api/v1/sandbox-ui/${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/oauth/authorize-url`
      ),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rpcAccessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ oauthClientId, background }),
      }
    )
    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `sandbox-ui authorize-url request failed (${response.status}): ${body || '<empty>'}`
      )
    }
    const json = (await response.json()) as { authorizeUrl?: unknown }
    if (typeof json?.authorizeUrl !== 'string' || !json.authorizeUrl) {
      throw new Error('sandbox-ui authorize-url response missing authorizeUrl')
    }
    return { authorizeUrl: json.authorizeUrl }
  }

  /**
   * U5 (mcp-oauth reactive consent) — fetch the provider authorize URL for a
   * "Connect <server>" flow, initiated when a tool-call against an OAuth
   * mcp-server suspended with `connect_required`. Mirrors
   * `requestSandboxUiOauthAuthorizeUrl` but keyed by `mcpServerName` (never a
   * recipe): rpc-proxy derives the `userId` from `auth.sub` and forwards to
   * control-api's internal mint. The returned URL is opened via
   * `shell.openExternal`.
   *
   * Throws `ApiError` (not a bare Error) so `AppService.shouldRefreshRpcToken`
   * can see a 401/403-missing-scope status and drive the retry-after-refresh,
   * exactly like `approveToolCall`. A legitimate 403 (`context_membership_denied`),
   * 404 (`server_not_found`), 400 (`not_oauth_server`, …) or 502/503 propagates
   * verbatim in the message for the renderer to surface.
   */
  async requestMcpOauthAuthorizeUrl(
    rpcAccessToken: string,
    mcpServerName: string,
    contextId?: string
  ): Promise<{ authorizeUrl: string }> {
    const response = await fetch(
      url(`/api/v1/mcp-oauth/${encodeURIComponent(mcpServerName)}/authorize-url`),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rpcAccessToken}`,
          'content-type': 'application/json',
        },
        // Body is optional; only send `contextId` when present. The `userId` is
        // NEVER sent — rpc-proxy derives it from the JWT sub (invariant 3).
        body: JSON.stringify(contextId ? { contextId } : {}),
        signal: withTimeout(),
      }
    )
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(
        `mcp-oauth authorize-url request failed (${response.status}): ${body || '<empty>'}`,
        response.status,
        body
      )
    }
    const json = (await response.json()) as { authorizeUrl?: unknown }
    if (typeof json?.authorizeUrl !== 'string' || !json.authorizeUrl) {
      throw new Error('mcp-oauth authorize-url response missing authorizeUrl')
    }
    return { authorizeUrl: json.authorizeUrl }
  }

  private async openHostStream(
    rpcAccessToken: string,
    path: string,
    onEvent: (event: { event: string; data: unknown }) => void,
    signal: AbortSignal,
    // Invoked for SSE comment lines (e.g. `: keepalive`). These carry no data
    // and are normally dropped, but they prove the connection is alive — the
    // progress stream wires this to a heartbeat so the client watchdog doesn't
    // falsely time out during a long, semantically-silent tool run.
    onKeepalive?: () => void
  ): Promise<void> {
    const response = await fetch(url(path), {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${rpcAccessToken}`,
      },
      signal,
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Host stream failed (${response.status}): ${body || response.statusText}`)
    }
    if (!response.body) {
      throw new Error('Host stream missing response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const processChunk = (chunk: string) => {
      buffer += chunk
      while (true) {
        const separator = buffer.indexOf('\n\n')
        if (separator === -1) break
        const rawEvent = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const lines = rawEvent.split(/\r?\n/)
        let eventName = 'message'
        let sawComment = false
        const dataLines: string[] = []
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim() || 'message'
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim())
          } else if (line.startsWith(':')) {
            sawComment = true
          }
        }
        if (!dataLines.length) {
          // A bare comment block (`: keepalive`) — signal liveness, then skip.
          if (sawComment) onKeepalive?.()
          continue
        }
        const payloadText = dataLines.join('\n')
        try {
          const data = JSON.parse(payloadText) as unknown
          onEvent({ event: eventName, data })
        } catch {
          onEvent({ event: 'error', data: { message: 'Invalid stream payload' } })
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      processChunk(decoder.decode(value, { stream: true }))
    }
    const trailing = decoder.decode()
    if (trailing) processChunk(trailing)
  }

  async openHostStatusStream(
    rpcAccessToken: string,
    hostRef: string,
    onEvent: (event: { event: string; data: unknown }) => void,
    signal: AbortSignal
  ): Promise<void> {
    await this.openHostStream(
      rpcAccessToken,
      `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/status/stream`,
      onEvent,
      signal
    )
  }

  async openHostActivityStream(
    rpcAccessToken: string,
    hostRef: string,
    onEvent: (event: { event: string; data: unknown }) => void,
    signal: AbortSignal
  ): Promise<void> {
    await this.openHostStream(
      rpcAccessToken,
      `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/activity/stream`,
      onEvent,
      signal
    )
  }

  async openTaskProgressStream(
    rpcAccessToken: string,
    hostRef: string,
    taskId: string,
    onEvent: (event: { event: string; data: unknown }) => void,
    signal: AbortSignal
  ): Promise<void> {
    await this.openHostStream(
      rpcAccessToken,
      `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/tasks/${encodeURIComponent(taskId)}/progress/stream`,
      onEvent,
      signal,
      // Surface mcp-host's `: keepalive` comments as heartbeats so the renderer's
      // task watchdog treats the connection as alive during long silent tools.
      () => onEvent({ event: 'heartbeat', data: { taskId, iteration: 0, elapsedMs: 0 } })
    )
  }

  async approveToolCall(
    rpcToken: string,
    hostRef: string,
    taskId: string,
    toolCallId: string
  ): Promise<ApprovalDecisionResult> {
    const response = await fetch(
      url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/approvals/approve`),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${rpcToken}`,
        },
        body: JSON.stringify({ taskId, toolCallId }),
        signal: withTimeout(),
      }
    )
    if (!response.ok) {
      const body = await response.text()
      // ApiError (not a bare Error) so `AppService.shouldRefreshRpcToken` can see
      // the 401/403 status and drive the retry-after-refresh (§4.5-7).
      throw new ApiError(`Approve failed (${response.status}): ${body}`, response.status, body)
    }
    return parseApprovalDecisionResponse(response)
  }

  async denyToolCall(
    rpcToken: string,
    hostRef: string,
    taskId: string,
    toolCallId: string,
    reason: string
  ): Promise<ApprovalDecisionResult> {
    const response = await fetch(
      url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/approvals/deny`),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${rpcToken}`,
        },
        body: JSON.stringify({ taskId, toolCallId, reason }),
        signal: withTimeout(),
      }
    )
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(`Deny failed (${response.status}): ${body}`, response.status, body)
    }
    return parseApprovalDecisionResponse(response)
  }

  async cancelTask(rpcToken: string, hostRef: string, taskId: string): Promise<void> {
    const response = await fetch(
      url(
        `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/tasks/${encodeURIComponent(taskId)}/cancel`
      ),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${rpcToken}`,
        },
        signal: withTimeout(),
      }
    )
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(`cancelTask failed (${response.status}): ${body}`, response.status, body)
    }
  }

  async listArtifacts(
    rpcToken: string,
    hostRef: string
  ): Promise<{
    artifacts: Array<{ name: string; format: string; sizeBytes: number; createdAt: string }>
  }> {
    const response = await fetch(
      url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/artifacts`),
      {
        headers: { authorization: `Bearer ${rpcToken}` },
        signal: withTimeout(),
      }
    )
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(
        `List artifacts failed (${response.status}): ${body}`,
        response.status,
        body
      )
    }
    return response.json() as Promise<{
      artifacts: Array<{ name: string; format: string; sizeBytes: number; createdAt: string }>
    }>
  }

  async downloadArtifact(rpcToken: string, hostRef: string, filename: string): Promise<Buffer> {
    const response = await fetch(
      url(
        `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/artifacts/${encodeURIComponent(filename)}/download`
      ),
      {
        headers: { authorization: `Bearer ${rpcToken}` },
      }
    )
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Download artifact failed (${response.status}): ${body}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  async listSessions(
    rpcToken: string,
    hostRef: string,
    query: SessionsListQuery = {}
  ): Promise<SessionsListResult> {
    assertSafeRouteSegment('hostRef', hostRef)
    const requestUrl = new URL(url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/sessions`))
    if (query.agent) requestUrl.searchParams.set('agent', query.agent)
    if (query.limit !== undefined) requestUrl.searchParams.set('limit', String(query.limit))
    if (query.cursor) requestUrl.searchParams.set('cursor', query.cursor)
    const response = await fetch(requestUrl, {
      headers: { authorization: `Bearer ${rpcToken}` },
      signal: withTimeout(),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(
        `List sessions failed (${response.status}): ${body}`,
        response.status,
        body
      )
    }
    return parseSessionsListResult(await response.json())
  }

  async loadSessionMessages(
    rpcToken: string,
    hostRef: string,
    agent: string,
    chatId: string,
    query: SessionMessagesQuery = {}
  ): Promise<SessionMessagesResult> {
    assertSafeRouteSegment('hostRef', hostRef)
    assertSafeRouteSegment('agent', agent, { maxLength: 200, allowColon: false })
    assertSafeRouteSegment('chatId', chatId)
    const requestUrl = new URL(
      url(
        `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(chatId)}/messages`
      )
    )
    if (query.limit !== undefined) requestUrl.searchParams.set('limit', String(query.limit))
    if (query.beforeTurn !== undefined) {
      requestUrl.searchParams.set('beforeTurn', String(query.beforeTurn))
    }
    if (query.afterTurn !== undefined) {
      requestUrl.searchParams.set('afterTurn', String(query.afterTurn))
    }
    const response = await fetch(requestUrl, {
      headers: { authorization: `Bearer ${rpcToken}` },
      signal: withTimeout(),
    })
    if (response.status === 404) {
      // Keep the '404' token in the message: the renderer's `isHttp404` matches on
      // it to evict a stale local chat.
      throw new ApiError(`Session not found (404)`, 404, '')
    }
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(
        `Load session messages failed (${response.status}): ${body}`,
        response.status,
        body
      )
    }
    // F5: cast to the full wire shape — the server returns `state`/`activeTaskId`/
    // `pendingApproval` + per-turn `tool_steps`, and the renderer's recovery path
    // reads them. The previous cast dropped them, silently weakening the contract.
    return parseSessionMessagesResult(await response.json(), agent, chatId)
  }

  /**
   * On-demand snapshot of the active conversation's context-window composition.
   * Keyed by `(agent, chatId)` like {@link loadSessionMessages} — the server
   * derives the owning `userSub` from the verified caller token, never from the
   * path. Returns `{ breakdown: null }` when the session has no snapshot yet, and
   * also when the session is unknown to this user (the server replies with the
   * same anti-enumeration 404 in both cases) — the caller treats both as "no
   * breakdown to show" rather than an error.
   */
  async getContextBreakdown(
    rpcToken: string,
    hostRef: string,
    agent: string,
    chatId: string
  ): Promise<ContextBreakdownResult> {
    assertSafeRouteSegment('hostRef', hostRef)
    assertSafeRouteSegment('agent', agent, { maxLength: 200, allowColon: false })
    assertSafeRouteSegment('chatId', chatId)
    const response = await fetch(
      url(
        `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(chatId)}/context-breakdown`
      ),
      { headers: { authorization: `Bearer ${rpcToken}` }, signal: withTimeout() }
    )
    if (response.status === 404) {
      // Anti-enumeration 404 (no snapshot or session not owned by caller) — the
      // chip simply hides. NOT an error to surface to the user.
      return { breakdown: null }
    }
    if (!response.ok) {
      const body = await response.text()
      throw new ApiError(
        `Get context breakdown failed (${response.status}): ${body}`,
        response.status,
        body
      )
    }
    return response.json() as Promise<ContextBreakdownResult>
  }

  /**
   * Lists the models selectable for a host's active provider, plus the current
   * per-session selection and degraded/blocked flags (R2 model selector). The
   * server derives the owning user from the verified token; `chatId` scopes the
   * `sessionModel`/`sessionModelBlocked` projection to that conversation.
   *
   * Returns `null` when the host predates the endpoint (404/501) so the caller
   * hides the selector rather than surfacing a noisy error (compat, R2.6). A
   * genuine failure (5xx, auth) still throws.
   */
  async getHostModels(
    rpcToken: string,
    hostRef: string,
    chatId: string
  ): Promise<HostModelsResult | null> {
    // The model LIST is host-level (operator allowlist); `chatId` only scopes the
    // per-session `sessionModel`/`sessionModelBlocked` projection. A brand-new chat
    // has no id yet, so omit the query entirely — the server returns the host list
    // with `sessionModel: null` (R2 new-chat composer selector).
    const trimmedChatId = String(chatId || '').trim()
    const modelsPath = trimmedChatId
      ? `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/models?chatId=${encodeURIComponent(trimmedChatId)}`
      : `/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/models`
    const response = await fetch(url(modelsPath), {
      headers: { authorization: `Bearer ${rpcToken}` },
      signal: withTimeout(),
    })
    // 404 (host without the route) / 501 (route not implemented on this runtime)
    // → the feature is unavailable for this host; hide the selector silently.
    if (response.status === 404 || response.status === 501) {
      return null
    }
    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new ApiError(
        `Get host models failed (${response.status}): ${body}`,
        response.status,
        body
      )
    }
    return response.json() as Promise<HostModelsResult>
  }

  /**
   * Sets the per-session model for a host (R2.3). Applies to the next task only
   * (`effective: 'next-task'`). A model outside the operator allowlist is a 403
   * `{error:'model_not_allowed'}`, re-thrown with the {@link MODEL_NOT_ALLOWED}
   * token in the message so the renderer can show a targeted error and leave the
   * selection unchanged.
   */
  async setHostModel(
    rpcToken: string,
    hostRef: string,
    chatId: string,
    model: string
  ): Promise<SetHostModelResult> {
    const response = await fetch(url(`/api/v1/rpc/hosts/${encodeURIComponent(hostRef)}/model`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rpcToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chatId, model }),
      signal: withTimeout(),
    })
    if (!response.ok) {
      const body = await readErrorBody(response)
      // Disambiguate the two failure sources by the body's `error` code — NOT
      // by the 403 status alone. mcp-host rejects an off-allowlist model with
      // `{error:'model_not_allowed'}` (a policy decision — surface a targeted
      // message and leave the selection unchanged); rpc-proxy denies host access
      // with a plain 403 carrying a different code (a genuine access error).
      // mcp-host may answer 400 or 403 for the rejection, so key off the code,
      // not the status. Only the allowlist rejection embeds the token the
      // renderer detects.
      if (errorCodeFromBody(body) === MODEL_NOT_ALLOWED) {
        throw new ApiError(`Set host model rejected (${MODEL_NOT_ALLOWED})`, response.status, body)
      }
      throw new ApiError(
        `Set host model failed (${response.status}): ${body}`,
        response.status,
        body
      )
    }
    return response.json() as Promise<SetHostModelResult>
  }

  async getDesktopStatus(
    rpcAccessToken: string,
    hostRef: string
  ): Promise<{ hostRef: string; status: string; message?: string }> {
    return requestJson<{ hostRef: string; status: string; message?: string }>(
      'GET',
      url(`/api/v1/desktop/${encodeURIComponent(hostRef)}`),
      {
        token: rpcAccessToken,
      }
    )
  }

  /**
   * Exchanges JWT for a desktop session cookie.
   * Returns the raw Set-Cookie header value so the caller (main process)
   * can inject it into an Electron BrowserWindow's session.
   */
  async postDesktopSession(
    rpcAccessToken: string,
    hostRef: string
  ): Promise<{ ok: true; hostRef: string; setCookie: string[] }> {
    const res = await fetch(url(`/api/v1/desktop/${encodeURIComponent(hostRef)}/session`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rpcAccessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    if (!res.ok) {
      const text = await readErrorBody(res)
      throw new ApiError(
        `Desktop session exchange failed: ${res.status} ${text || res.statusText}`,
        res.status,
        text
      )
    }
    const body = (await res.json()) as { ok: true; hostRef: string }
    const cookies: string[] =
      typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : [res.headers.get('set-cookie') || ''].filter(Boolean)
    if (!cookies.length) {
      throw new Error('Desktop session response missing Set-Cookie header')
    }
    return { ...body, setCookie: cookies }
  }
}
