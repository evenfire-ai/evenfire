'use client'

import {
  DEFAULT_MCP_SERVER_SECRET_NAMESPACE,
  DEFAULT_SANDBOX_SECRET_NAMESPACE,
  type RecipeSecretNamespaces,
} from './recipeSecretNamespaces'

export type AnyRecord = Record<string, unknown>

// Global error handler for 401s - managed by AuthContext
let globalHandleAuthError: (() => void) | null = null

export function setGlobalAuthErrorHandler(handler: () => void) {
  globalHandleAuthError = handler
}

function getGlobalAuthErrorHandler() {
  return globalHandleAuthError
}

export class AuthExpiredError extends Error {
  status = 401
  silent = true

  constructor() {
    super('Session expired')
    this.name = 'AuthExpiredError'
  }
}

export function isSilentApiError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { silent?: unknown }).silent)
}

function handleUnauthorized(): never {
  clearAdminAuthToken()
  const handler = getGlobalAuthErrorHandler()
  handler?.()
  throw new AuthExpiredError()
}

export type Metadata = {
  name?: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  /**
   * Server-assigned version of the read. Carried back on save as the AP-6
   * optimistic-concurrency precondition (docs/architecture/stateless-invariants.md).
   */
  resourceVersion?: string
}

const API_BASE = process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL || '/control-api'
const ADMIN_TOKEN_STORAGE_KEY = 'controlUiAdminToken'
const API_REQUEST_TIMEOUT_MS = 30000
// Legacy JSON GFS uploads send file bytes base64-encoded inside a request body. The
// v2 path uses binary indexed parts and does not use this timeout/body contract;
// this constant remains only for the compatibility helper and old API callers.
export const GFS_UPLOAD_TIMEOUT_MS = 300000
const inFlightGetRequests = new Map<string, Promise<unknown>>()
let sessionEpoch = 0
type ApiRequestOptions = {
  silentUnauthorized?: boolean
  signal?: AbortSignal
}

function qs(params: Record<string, string | undefined>) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') search.set(k, v)
  })
  const value = search.toString()
  return value ? `?${value}` : ''
}

function authHeaders(): HeadersInit {
  return {}
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

export function formatApiError(res: Response, text: string): Error {
  let detail = text
  let parsedBody: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    if (parsed && typeof parsed === 'object') parsedBody = parsed as Record<string, unknown>
    detail = String(parsed.message || parsed.error || text)
  } catch {
    detail = text
  }
  const friendlyDetail =
    detail === 'duplicate_username'
      ? 'That username is already taken.'
      : detail === 'duplicate_email'
        ? 'That email is already registered.'
        : detail === 'invalid_invitation'
          ? 'This admin invitation is invalid or expired.'
          : detail === 'member password must be between 8 and 256 characters'
            ? 'Desktop App password must be between 8 and 256 characters.'
            : detail === 'password must be between 8 and 256 characters'
              ? 'Password must be between 8 and 256 characters.'
              : detail === 'precondition_failed'
                ? 'This item changed since it was loaded. Reload the page, review the latest state, and try again.'
                : detail === 'agent_grant_precondition_required'
                  ? 'Agent access could not be updated because the page did not include its current access state. Reload the page and try again.'
                  : detail === 'deleted_agent_history_limit_exceeded'
                    ? 'Agent access was not updated because the deleted-agent history limit was reached. No existing history was removed. Reload the page, review the current access, and try again.'
                    : // Exact match is correct HERE: control-ui calls control-api directly,
                      // so a member-registration 503 arrives as the bare { error: '<code>' }
                      // body. profile-ui reaches these same codes through external-rest-api,
                      // whose error middleware wraps any 5xx into { message: '...: <code>' },
                      // so it must use .includes() instead — the two matchers differ on purpose.
                      detail === 'member_registration_unavailable'
                      ? "Invitations are unavailable — the member-registration service isn't configured or can't be reached. Check the server logs for details."
                      : detail === 'member_registration_misconfigured'
                        ? 'Invitations are unavailable — member registration is misconfigured. Check the server logs for details.'
                        : detail
  const error = new Error(`${res.status} ${res.statusText} - ${friendlyDetail}`)
  ;(error as Error & { status?: number }).status = res.status
  // Preserve the machine-readable error code and full JSON body so callers can
  // render structured, actionable errors (e.g. unpriced_models, price_in_use_by_budget)
  // instead of the generic message string.
  if (parsedBody) {
    ;(error as Error & { code?: string }).code =
      typeof parsedBody.error === 'string' ? (parsedBody.error as string) : undefined
    ;(error as Error & { body?: Record<string, unknown> }).body = parsedBody
  }
  return error
}

async function apiPublicPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text()
      throw formatApiError(res, text)
    }
    return (await parseJsonResponse(res)) as T
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error(
        'Request timed out. Check that Control API and member-registration-service are running.'
      )
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = API_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  // A non-positive or non-finite override means "use the default", never "abort
  // immediately" — this matches the server proxy's resolveProxyTimeoutMs semantics.
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : API_REQUEST_TIMEOUT_MS
  const timeoutId = window.setTimeout(() => controller.abort(), effectiveTimeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  try {
    return await fetch(input, {
      ...init,
      credentials: init.credentials || 'include',
      signal,
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      if (init.signal?.aborted) throw error
      throw new Error('Request timed out. Check that Control API is reachable.')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export async function apiGet(
  path: string,
  query: Record<string, string | undefined> = {},
  options: ApiRequestOptions = {}
) {
  const url = `${API_BASE}${path}${qs(query)}`
  const headers = { ...authHeaders() }
  const cacheKey = `${url}|${sessionEpoch}`
  const existing = options.signal ? undefined : inFlightGetRequests.get(cacheKey)
  if (existing) return existing

  const request = (async () => {
    const res = await fetchWithTimeout(url, {
      cache: 'no-store',
      headers,
      signal: options.signal,
    })
    if (!res.ok) {
      if (res.status === 401) {
        if (options.silentUnauthorized) {
          clearAdminAuthToken()
          throw new AuthExpiredError()
        }
        handleUnauthorized()
      }
      // Prefer a server-provided human-safe `message` (e.g. the 503
      // registry_unavailable body) so callers surface the clear text instead of
      // a bare "<status> <statusText>". Bodies carrying only a machine `error`
      // code (or no JSON) keep the existing status-text message. Also attach the
      // machine code, mirroring how registryCodedRequest surfaces `.code`.
      const text = await res.text().catch(() => '')
      let message = `${res.status} ${res.statusText}`
      let code: string | undefined
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.message === 'string' && parsed.message.trim()) {
            message = parsed.message
          }
          if (typeof parsed.error === 'string') code = parsed.error
        }
      } catch {
        /* non-JSON error body: keep the status-text message */
      }
      const error = new Error(message) as Error & { status?: number; code?: string }
      error.status = res.status
      if (code) error.code = code
      throw error
    }
    return parseJsonResponse(res)
  })()
  if (!options.signal) {
    inFlightGetRequests.set(cacheKey, request)
    request.then(
      () => inFlightGetRequests.delete(cacheKey),
      () => inFlightGetRequests.delete(cacheKey)
    )
  }
  return request
}

export async function apiSend(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  query: Record<string, string | undefined> = {},
  extraHeaders: Record<string, string> = {},
  options: { timeoutMs?: number } = {}
) {
  const res = await fetchWithTimeout(
    `${API_BASE}${path}${qs(query)}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    options.timeoutMs
  )
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 401) {
      handleUnauthorized()
    }
    throw formatApiError(res, text)
  }
  return parseJsonResponse(res)
}

// ── Global File System operator delegation (grant/share) ────────────────────
// Like registryKeysRequest: unlike apiSend (friendly-remaps the message), these
// routes need the machine-readable error CODE (e.g. escalation_rejected,
// resource_invalid) so the operator panel can surface the precise verdict.
export type GfsUserSubjectInput = { type: 'user'; id: string }
export type GfsTeamSubjectInput = { type: 'team'; id: string }
export type GfsHostSubjectInput = { type: 'host'; id: string }
export type GfsOperatorSubjectInput = { type: 'operator' }
export type GfsContextSubjectInput = { type: 'context'; id: string }

export type GfsBulkGrantSubjectInput =
  | GfsUserSubjectInput
  | GfsTeamSubjectInput
  | GfsHostSubjectInput
export type GfsBulkShareSubjectInput = GfsUserSubjectInput | GfsTeamSubjectInput
export type GfsSubjectInput =
  | GfsBulkGrantSubjectInput
  | GfsOperatorSubjectInput
  | GfsContextSubjectInput

type GfsSubjectMutationInput<TBulkSubject extends GfsSubjectInput> =
  | { subject: GfsSubjectInput; subjects?: never }
  | { subject?: never; subjects: TBulkSubject[] }

type GfsMutationRequestBody = {
  drive?: string
  resourceId: string
  permissions: string[]
}

export type GfsGrantRequestBody = GfsMutationRequestBody &
  GfsSubjectMutationInput<GfsBulkGrantSubjectInput> & {
    inherit?: boolean
  }

export type GfsShareRequestBody = GfsMutationRequestBody &
  GfsSubjectMutationInput<GfsBulkShareSubjectInput> & {
    includeDescendants?: boolean
  }

export type GfsMutationResponse = {
  ok: true
  resourceId: string
  updated: GfsSubjectInput[]
  count: number
}

export type GfsGrantListItem = {
  id: string
  drive: string
  resourceId: string
  subject: GfsSubjectInput
  permissions: string[]
  inherit: boolean
}

export type GfsShareListItem = {
  id: string
  drive: string
  resourceId: string
  subject: GfsSubjectInput
  permissions: string[]
  includeDescendants: boolean
}

export type GfsGrantListResponse = { items: GfsGrantListItem[] }
export type GfsShareListResponse = { items: GfsShareListItem[] }

export type GfsGrantError = Error & {
  status?: number
  code?: string
  serverMessage?: string
  invalidIndexes?: number[]
}

async function gfsMutate(
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized()
    let code = ''
    let serverMessage = ''
    let invalidIndexes: number[] | undefined
    try {
      const parsed = (await res.json()) as {
        error?: string
        message?: unknown
        invalidIndexes?: unknown
      }
      code = parsed?.error ?? ''
      if (typeof parsed?.message === 'string') serverMessage = parsed.message
      if (Array.isArray(parsed?.invalidIndexes)) {
        invalidIndexes = parsed.invalidIndexes.filter(
          (index): index is number =>
            typeof index === 'number' && Number.isInteger(index) && index >= 0
        )
      }
    } catch {
      /* no body */
    }
    const detail =
      code && serverMessage && serverMessage !== code
        ? `${code}: ${serverMessage}`
        : serverMessage || code || res.statusText
    const error = new Error(`${res.status} ${detail}`) as GfsGrantError
    error.status = res.status
    error.code = code
    error.serverMessage = serverMessage
    error.invalidIndexes = invalidIndexes
    throw error
  }
  if (res.status === 204) return undefined
  return parseJsonResponse(res)
}

/** Operator grants a Layer-1/2 folder grant (PUT /api/v1/gfs/grants). */
export async function putGfsGrant(body: GfsGrantRequestBody): Promise<GfsMutationResponse> {
  return (await gfsMutate('PUT', '/api/v1/gfs/grants', body)) as GfsMutationResponse
}

/** Lists direct grants configured on one resource. Inherited effective access is not expanded. */
export async function getGfsGrants(
  resourceId: string,
  drive = 'main',
  signal?: AbortSignal
): Promise<GfsGrantListResponse> {
  return (await apiGet(
    '/api/v1/gfs/grants',
    { drive, resourceId },
    { signal }
  )) as GfsGrantListResponse
}

export async function deleteGfsGrant(id: string): Promise<void> {
  await gfsMutate('DELETE', `/api/v1/gfs/grants/${encodeURIComponent(id)}`)
}

/** Operator creates a URI share (POST /api/v1/gfs/shares). */
export async function postGfsShare(body: GfsShareRequestBody): Promise<GfsMutationResponse> {
  return (await gfsMutate('POST', '/api/v1/gfs/shares', body)) as GfsMutationResponse
}

/** Lists direct URI shares configured on one resource. */
export async function getGfsShares(
  resourceId: string,
  drive = 'main',
  signal?: AbortSignal
): Promise<GfsShareListResponse> {
  return (await apiGet(
    '/api/v1/gfs/shares',
    { drive, resourceId },
    { signal }
  )) as GfsShareListResponse
}

export async function deleteGfsShare(id: string): Promise<void> {
  await gfsMutate('DELETE', `/api/v1/gfs/shares/${encodeURIComponent(id)}`)
}

export type AdminLoginResponse = {
  me: { id: string; username?: string; email?: string | null; role: 'admin' }
}

export function clearAdminAuthToken(): void {
  sessionEpoch += 1
  inFlightGetRequests.clear()
  if (typeof window === 'undefined') return
  // Remove the legacy browser-readable admin JWT if it exists. Active admin
  // sessions now live in an HttpOnly cookie set by control-api.
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY)
}

export async function loginControlUI(
  username: string,
  password: string
): Promise<AdminLoginResponse> {
  const res = await fetch(`${API_BASE}/api/v1/admin/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText} - ${text}`)
  }
  const data = (await res.json()) as AdminLoginResponse
  clearAdminAuthToken()
  return data
}

export async function logoutControlUI(): Promise<void> {
  try {
    await apiSend('POST', '/api/v1/admin/auth/logout')
  } catch {
    // Logout is best-effort: a stale token or backend revoke failure should not
    // keep the local admin session alive or surface a dev/runtime overlay.
  } finally {
    clearAdminAuthToken()
  }
}

export async function getControlUIAuthMe(): Promise<{
  me: { id?: string; username?: string; email?: string | null; role?: string }
  namespaces?: { sandbox?: string; mcpServer?: string }
}> {
  return apiGet('/api/v1/admin/auth/me', {}, { silentUnauthorized: true }) as Promise<{
    me: { id?: string; username?: string; email?: string | null; role?: string }
    namespaces?: { sandbox?: string; mcpServer?: string }
  }>
}

export type ControlAdminProfile = {
  id: string
  username: string
  email: string | null
  role: 'admin'
  pendingEmailChange?: {
    email: string
    expiresAt: string
    createdAt: string
  } | null
}

export type ControlAdminBridgeStatus = {
  admin: {
    id: string
    username: string
    email: string | null
    emailConfirmed: boolean
    pendingEmailChange?: {
      email: string
      expiresAt: string
      createdAt: string
    } | null
  }
  member: { id: string; email: string } | null
}

export type ControlAdminListItem = {
  id: string
  username: string
  email: string | null
  memberId?: string | null
  status: 'active' | 'disabled' | 'pending_password'
  passwordPending?: boolean
  invitationId?: string
  gfsOperatorLink?: {
    desktopUserId: string
    controlAdminId: string
    source: 'initial_setup' | 'unknown'
    createdAt: string | null
    status: 'active' | 'inactive_admin' | 'revoked' | 'error'
    generation?: number | null
    rowVersion?: number | null
    revocationReason?: string | null
  } | null
  gfsOperatorLinkStatus?: 'none' | 'active' | 'inactive_admin' | 'revoked' | 'error'
  lastLoginAt: string | null
  createdAt: string
}

export type ControlAdminInvitationItem = {
  id: string
  email: string
  status: 'pending' | 'accepted' | 'revoked'
  expiresAt: string
  createdAt: string
  acceptedAt?: string | null
}

export type ControlAdminEmailConfirmationItem = {
  id: string
  email: string
  status: 'pending' | 'confirmed' | 'revoked'
  expiresAt: string
  createdAt: string
}

export async function getControlUISettingsMe(): Promise<{ me: ControlAdminProfile }> {
  return apiGet('/api/v1/admin/settings/me') as Promise<{ me: ControlAdminProfile }>
}

export async function getControlAdminBridgeStatus(): Promise<ControlAdminBridgeStatus> {
  return apiGet('/api/v1/admin/settings/bridge-status') as Promise<ControlAdminBridgeStatus>
}

export async function updateControlUISettingsUsername(username: string): Promise<{
  me: ControlAdminProfile
}> {
  return apiSend('PATCH', '/api/v1/admin/settings/username', { username }) as Promise<{
    me: ControlAdminProfile
  }>
}

export async function requestControlUISettingsEmailChange(email: string): Promise<{
  confirmation: ControlAdminEmailConfirmationItem
}> {
  return apiSend('POST', '/api/v1/admin/settings/email-change', { email }) as Promise<{
    confirmation: ControlAdminEmailConfirmationItem
  }>
}

export async function updateControlUISettingsPassword(payload: {
  currentPassword: string
  newPassword: string
}): Promise<{ updated: true }> {
  return apiSend('POST', '/api/v1/admin/settings/password', payload) as Promise<{ updated: true }>
}

export async function getControlAdmins(): Promise<{
  admins: ControlAdminListItem[]
  invitations: ControlAdminInvitationItem[]
}> {
  return apiGet('/api/v1/admin/control-admins') as Promise<{
    admins: ControlAdminListItem[]
    invitations: ControlAdminInvitationItem[]
  }>
}

export async function inviteControlAdmin(
  email: string,
  options?: { createDesktopAccess?: boolean; teams?: Array<{ teamId: string; role: TeamRole }> }
): Promise<{
  invitation: ControlAdminInvitationItem
}> {
  return apiSend('POST', '/api/v1/admin/control-admin-invitations', {
    email,
    createDesktopAccess: options?.createDesktopAccess === true,
    teams: options?.teams || [],
  }) as Promise<{ invitation: ControlAdminInvitationItem }>
}

export async function cancelControlAdminInvitation(invitationId: string): Promise<{
  revoked: true
}> {
  return apiSend('DELETE', `/api/v1/admin/control-admin-invitations/${invitationId}`) as Promise<{
    revoked: true
  }>
}

export async function deleteControlAdmin(adminId: string): Promise<{ deleted: true }> {
  return apiSend('DELETE', `/api/v1/admin/control-admins/${adminId}`) as Promise<{
    deleted: true
  }>
}

export async function revokeControlAdminGfsOperatorLink(
  adminId: string,
  payload: { rowVersion?: number | null; reason?: string } = {}
): Promise<{
  revoked: boolean
  gfsOperatorLinkStatus: 'revoked'
  controlAdminId: string
  desktopUserId: string | null
  generation?: number | null
  rowVersion?: number | null
}> {
  return apiSend(
    'DELETE',
    `/api/v1/admin/control-admins/${encodeURIComponent(adminId)}/gfs-operator-link`,
    payload
  ) as Promise<{
    revoked: boolean
    gfsOperatorLinkStatus: 'revoked'
    controlAdminId: string
    desktopUserId: string | null
    generation?: number | null
    rowVersion?: number | null
  }>
}

export async function reactivateControlAdminGfsOperatorLink(
  adminId: string,
  payload: { rowVersion: number; reason: string }
): Promise<{
  reactivated: boolean
  gfsOperatorLinkStatus: 'active' | 'revoked'
  controlAdminId: string
  desktopUserId: string | null
  generation?: number | null
  rowVersion?: number | null
}> {
  return apiSend(
    'POST',
    `/api/v1/admin/control-admins/${encodeURIComponent(adminId)}/gfs-operator-link/reactivate`,
    payload
  ) as Promise<{
    reactivated: boolean
    gfsOperatorLinkStatus: 'active' | 'revoked'
    controlAdminId: string
    desktopUserId: string | null
    generation?: number | null
    rowVersion?: number | null
  }>
}

export async function createMemberFromControlAdmin(
  adminId: string,
  payload: { reusePassword: boolean; teams: Array<{ teamId: string; role: TeamRole }> }
): Promise<{ created: boolean; user: { id: string; email: string; name: string | null } }> {
  return apiSend('POST', `/api/v1/admin/control-admins/${encodeURIComponent(adminId)}/member`, {
    reusePassword: payload.reusePassword,
    teams: payload.teams,
  }) as Promise<{ created: boolean; user: { id: string; email: string; name: string | null } }>
}

export async function validateControlAdminInvitation(token: string): Promise<{
  valid: true
  email: string
  invitationUuid: string
}> {
  return apiPublicPost('/api/v1/admin/auth/control-admin-invitations/validate', { token })
}

export async function completeControlAdminInvitation(payload: {
  token: string
  email: string
  username: string
  password: string
  useSameMemberPassword?: boolean
  memberPassword?: string
}): Promise<{ completed: true; desktopAccessCompleted?: boolean; login: { username: string } }> {
  return apiPublicPost('/api/v1/admin/auth/control-admin-invitations/complete', payload)
}

export async function validateControlAdminEmailConfirmation(token: string): Promise<{
  valid: true
  email: string
  confirmationUuid: string
}> {
  return apiPublicPost('/api/v1/admin/auth/control-admin-email-confirmations/validate', { token })
}

export async function completeControlAdminEmailConfirmation(payload: {
  token: string
  email?: string
}): Promise<{ completed: true; alreadyConfirmed?: boolean; login: { username: string } }> {
  return apiPublicPost('/api/v1/admin/auth/control-admin-email-confirmations/complete', payload)
}

export async function requestControlAdminPasswordReset(username: string): Promise<{
  requested: true
}> {
  return apiPublicPost('/api/v1/admin/auth/password-reset/request', { username })
}

export async function validateControlAdminPasswordReset(token: string): Promise<{
  valid: true
  email: string
  resetUuid: string
}> {
  return apiPublicPost('/api/v1/admin/auth/password-reset/validate', { token })
}

export async function completeControlAdminPasswordReset(payload: {
  token: string
  email: string
  password: string
}): Promise<{ completed: true; login: { username: string } }> {
  return apiPublicPost('/api/v1/admin/auth/password-reset/complete', payload)
}

/**
 * Resolve the recipe-secret namespaces this control-api enforces. In an MCC
 * per-tenant deployment these are suffixed (sandbox-recipes-<slug> /
 * mcp-server-<slug>); control-ui must write recipe secrets to them rather than
 * the bare defaults. Sourced from GET /admin/auth/me (the UI already calls it).
 * Falls back to the bare single-tenant defaults if the field is absent (older
 * control-api) or the request fails, so single-tenant behavior is unchanged.
 */
export async function getControlUINamespaces(): Promise<RecipeSecretNamespaces> {
  try {
    const res = await getControlUIAuthMe()
    return {
      sandbox: res.namespaces?.sandbox || DEFAULT_SANDBOX_SECRET_NAMESPACE,
      mcpServer: res.namespaces?.mcpServer || DEFAULT_MCP_SERVER_SECRET_NAMESPACE,
    }
  } catch (err) {
    console.warn(
      'getControlUINamespaces: could not resolve recipe-secret namespaces from control-api; ' +
        'falling back to single-tenant defaults (sandbox-recipes/mcp-server). In a per-tenant ' +
        'deployment, recipe secret writes may then 400 until control-api is reachable.',
      err
    )
    return {
      sandbox: DEFAULT_SANDBOX_SECRET_NAMESPACE,
      mcpServer: DEFAULT_MCP_SERVER_SECRET_NAMESPACE,
    }
  }
}

export type TeamRole = 'admin' | 'inviter' | 'member'
export type InviteRole = TeamRole

export type TeamSummary = {
  id: string
  name: string
  role: TeamRole
}
export type TeamListItem = { id: string; name: string; memberCount: number }
export type SharedFileSystemSpec = {
  size?: string
  storageClassName?: string
  accessModes?: string[]
  annotations?: Record<string, string>
  directories?: string[]
  security?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number }
  retainOnDelete?: boolean
}
export type SharedFileSystemStatus = {
  phase?: 'Provisioning' | 'Initializing' | 'Ready' | 'Degraded' | 'Failed'
  pvcName?: string
  capacity?: string
  storageClassName?: string
  serviceName?: string
  mountedByContexts?: Array<{ namespace: string; name: string }>
  lastInitJob?: { name?: string; completedAt?: string; error?: string }
  conditions?: Array<{
    type: string
    status: 'True' | 'False' | 'Unknown'
    reason?: string
    message?: string
    lastTransitionTime?: string
  }>
}
export type SharedFileSystemResource = {
  metadata?: Metadata
  spec?: SharedFileSystemSpec
  status?: SharedFileSystemStatus
}
export type ContextSharedFileSystemRef = {
  name: string
  mountPath: string
}
export type ContextSharedFileSystemStatus = {
  name: string
  mountPath: string
  phase: 'Resolving' | 'Mounted' | 'MissingTarget' | 'Failed'
  pvcName?: string
  message?: string
}
export type ContextSpec = {
  contextId: string
  // Editable, human-visible name (free text). Optional/new: existing contexts
  // won't have it, so consumers fall back to `metadata.name`.
  displayName?: string
  description?: string
  mcpServers: string[]
  sharedFileSystems?: ContextSharedFileSystemRef[]
}
export type ContextResource = {
  metadata?: Metadata
  spec?: ContextSpec
  status?: { sharedFileSystems?: ContextSharedFileSystemStatus[] }
}
export type HostLifecycleSpec = { stateless?: boolean }
export type HostStatusCondition = {
  type?: string
  status?: string
  reason?: string
  message?: string
}
export type HostResource = {
  metadata?: Metadata
  spec?: AnyRecord & {
    contextRef?: string
    model?: { provider?: string; name?: string }
    lifecycle?: HostLifecycleSpec
  }
  status?: AnyRecord & {
    lifecycle?: { state?: string; reason?: string }
    conditions?: HostStatusCondition[]
  }
}
/**
 * Condition entry on `status.conditions[]` of the McpServer CRD, as written by
 * the HCC reconciler (host-context-controller/src/reconciler.ts). `status` is
 * the K8s-standard string tri-state, not a boolean. `lastTransitionTime` only
 * advances when `status` itself changes (writeStatusCondition) — the UI relies
 * on that to tell "this rollout" apart from a stale prior condition (issue #223,
 * Fase 3 requisito 6).
 */
export type McpServerCondition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason: string
  message: string
  lastTransitionTime: string
}

export type McpServerResource = {
  metadata?: Metadata
  spec?: AnyRecord
  status?: { conditions?: McpServerCondition[] }
}
export type ContextUser = {
  id: string
  email: string
  name: string | null
  displayName: string | null
}
export type ContextTeam = {
  id: string
  name: string
}
export type AgentUser = ContextUser
export type AgentTeam = ContextTeam
export type UserContextAccess = {
  userId: string
  contextIds: string[]
  deletedContextIds?: string[]
}
export type TeamContextAccess = {
  teamId: string
  contextIds: string[]
  deletedContextIds?: string[]
}
export type UserAgentAccess = {
  userId: string
  agentNames: string[]
  deletedAgentNames: string[]
  deletedHistoryLimit: number
}
export type TeamAgentAccess = {
  teamId: string
  agentNames: string[]
  deletedAgentNames: string[]
  deletedHistoryLimit: number
}
export type TeamMember = {
  id: string
  email: string
  name?: string
  role: TeamRole
  status?: string
  display_name?: string | null
}

export type AdminTeamPendingInvitation = {
  id: string
  team_id: string | null
  teamId?: string | null
  email: string
  role: InviteRole
  teams?: Array<{ id: string; name: string; role: InviteRole }>
  status: 'pending'
  created_at: string
  expires_at?: string
}

/** Pending invite with team name (admin home list). */
export type AdminPendingInvitationListItem = AdminTeamPendingInvitation & {
  team_name: string | null
}
export type AdminUser = {
  id: string
  email: string
  name: string | null
  picture: string | null
  displayName: string | null
  controlAdminId?: string | null
  activeTeamCount: number
  teams?: Array<{ id: string; name: string; role: TeamRole }>
  passwordPendingFromAcceptedInvitation?: boolean
}
// `keys` are the Secret's data-key NAMES only (never values); the detail bundle
// populates them via listHostSecrets. Optional for compat with older payloads.
export type HostSecretResource = { name: string; keys?: string[] }

/**
 * Host/LLM Secret metadata only. `keys` are Kubernetes data-key names; values
 * are never returned. SDK target editors use this rather than recipe-scoped
 * sandbox secrets because promptBridge credentials resolve from host Secrets.
 */
export async function listLlmHostSecrets() {
  return apiGet('/api/v1/admin/secrets') as Promise<{ items?: HostSecretResource[] }>
}

export type HostDetailBundle = {
  host: HostResource
  contexts: ContextResource[]
  secrets: HostSecretResource[]
  users: AdminUser[]
  teams: TeamListItem[]
  agentUsers: AgentUser[]
  agentTeams: AgentTeam[]
}
export type ProfileAdminOverview = {
  teams: TeamListItem[]
  users: AdminUser[]
  pendingInvitations: AdminPendingInvitationListItem[]
  teamAgentCounts: Record<string, number>
  teamContextCounts: Record<string, number>
}
export type AdminUserChannels = {
  emails: string[]
  slackUserNames: string[]
  telegramIds: string[]
}
export type AdminUserContext = {
  id: string
  email: string
  name: string | null
  picture: string | null
  displayName: string | null
  channels: AdminUserChannels
}

export async function getAdminUsers(q = '') {
  return apiGet('/api/v1/admin/users', { q }) as Promise<{ items?: AdminUser[] }>
}

export async function getHostDetailBundle(name: string) {
  return apiGet(
    `/api/v1/admin/hosts/${encodeURIComponent(name)}/detail`
  ) as Promise<HostDetailBundle>
}

export async function getProfileAdminOverview() {
  return apiGet('/api/v1/admin/profile-admin/overview') as Promise<ProfileAdminOverview>
}

export async function createAdminUserApi(email: string, name: string) {
  return apiSend('POST', '/api/v1/admin/users', { email, name }) as Promise<{
    id: string
    email: string
    name: string | null
  }>
}

export async function getContexts() {
  return apiGet('/api/v1/admin/contexts') as Promise<{ items?: ContextResource[] }>
}

export async function getHosts() {
  return apiGet('/api/v1/admin/hosts') as Promise<{ items?: HostResource[] }>
}

export async function getHost(name: string) {
  return apiGet(`/api/v1/admin/hosts/${encodeURIComponent(name)}`) as Promise<HostResource>
}

export type HostPersonalization = {
  identity: string
  soul: string
  agents: string
  user: string
  resourceVersion: string
}

export async function getHostPersonalization(name: string): Promise<HostPersonalization> {
  return apiGet(
    `/api/v1/admin/hosts/${encodeURIComponent(name)}/personalization`
  ) as Promise<HostPersonalization>
}

export async function updateHostPersonalization(
  name: string,
  payload: {
    identity?: string
    soul?: string
    agents?: string
    user?: string
    resourceVersion: string
  }
): Promise<{ resourceVersion: string }> {
  return apiSend(
    'PUT',
    `/api/v1/admin/hosts/${encodeURIComponent(name)}/personalization`,
    payload
  ) as Promise<{ resourceVersion: string }>
}

export async function getContext(name: string) {
  return apiGet(`/api/v1/admin/contexts/${encodeURIComponent(name)}`) as Promise<ContextResource>
}

export async function createContext(payload: { metadata: { name: string }; spec: ContextSpec }) {
  return apiSend('POST', '/api/v1/admin/contexts', payload) as Promise<ContextResource>
}

export async function updateContext(
  name: string,
  payload: { metadata: { resourceVersion: string }; spec: ContextSpec }
) {
  return apiSend(
    'PUT',
    `/api/v1/admin/contexts/${encodeURIComponent(name)}`,
    payload
  ) as Promise<ContextResource>
}

export async function deleteContext(name: string) {
  return apiSend('DELETE', `/api/v1/admin/contexts/${encodeURIComponent(name)}`)
}

export async function getMcpServers() {
  return apiGet('/api/v1/admin/mcp-servers') as Promise<{ items?: McpServerResource[] }>
}

// ── SharedFileSystem CRD admin + per-SFS file browsing ──────────────────

export async function getSharedFileSystems() {
  return apiGet('/api/v1/admin/shared-filesystems') as Promise<{
    items?: SharedFileSystemResource[]
  }>
}

export async function getSharedFileSystem(name: string) {
  return apiGet(
    `/api/v1/admin/shared-filesystems/${encodeURIComponent(name)}`
  ) as Promise<SharedFileSystemResource>
}

export type CreateSharedFileSystemInput = {
  name: string
  size?: string
  accessModes?: string[]
  storageClassName?: string
  directories?: string[]
  retainOnDelete?: boolean
  security?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number }
}

export async function createSharedFileSystem(input: CreateSharedFileSystemInput) {
  return apiSend(
    'POST',
    '/api/v1/admin/shared-filesystems',
    input as unknown as Record<string, unknown>
  ) as Promise<SharedFileSystemResource>
}

export async function deleteSharedFileSystem(name: string) {
  return apiSend('DELETE', `/api/v1/admin/shared-filesystems/${encodeURIComponent(name)}`)
}

/**
 * Below: file-browsing endpoints. They proxy through control-api's
 * /admin/shared-filesystems/:name/proxy/v1/* to the per-SFS wfc Service.
 * The control-api proxy substitutes the admin JWT for a fresh wfc browsing
 * token before forwarding, so these helpers just need the standard admin
 * Authorization header (which apiGet/apiSend already attach).
 */
export type WfcDirEntry = {
  name: string
  kind: 'file' | 'directory' | 'other'
  size: number
  mtime: string
}
export type WfcListResponse = {
  ok: true
  data: { path: string; entries: WfcDirEntry[]; truncated: boolean }
}
export type WfcStatResponse = {
  ok: true
  data: { path: string; kind: 'file' | 'directory' | 'other'; size: number; mtime: string }
}

function sfsProxyUrl(name: string, subPath: string): string {
  const base = `/api/v1/admin/shared-filesystems/${encodeURIComponent(name)}/proxy/v1/files`
  return subPath ? `${base}${subPath}` : base
}

export async function sfsListFiles(sfsName: string, relPath: string) {
  return apiGet(sfsProxyUrl(sfsName, ''), { path: relPath }) as Promise<WfcListResponse>
}

export async function sfsStat(sfsName: string, relPath: string) {
  return apiGet(sfsProxyUrl(sfsName, '/stat'), { path: relPath }) as Promise<WfcStatResponse>
}

export function sfsDownloadUrl(sfsName: string, relPath: string): string {
  const base = process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL || '/control-api'
  const q = relPath ? `?path=${encodeURIComponent(relPath)}` : ''
  return `${base}${sfsProxyUrl(sfsName, '/download')}${q}`
}

async function fetchAuthenticatedFileBlob(url: string): Promise<Blob> {
  const resp = await fetch(url, { credentials: 'include' })
  if (!resp.ok) {
    if (resp.status === 401) handleUnauthorized()
    let msg = `Download failed (${resp.status})`
    try {
      const body = (await resp.json()) as {
        error?: string | { message?: string; code?: string }
      }
      if (typeof body.error === 'string') msg = body.error
      else if (body.error?.message || body.error?.code) {
        msg = body.error.message || body.error.code || msg
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return resp.blob()
}

async function sfsFetchFileBlob(sfsName: string, relPath: string): Promise<Blob> {
  return fetchAuthenticatedFileBlob(sfsDownloadUrl(sfsName, relPath))
}

function sfsFileName(relPath: string): string {
  return relPath.split('/').pop() || 'download'
}

function sfsBrowserCanPreview(blob: Blob, fileName: string): boolean {
  const mime = blob.type.split(';')[0].toLowerCase()
  if (
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'application/pdf'
  ) {
    return true
  }

  const ext = fileName.split('.').pop()?.toLowerCase()
  return Boolean(
    ext &&
    [
      'csv',
      'gif',
      'htm',
      'html',
      'jpeg',
      'jpg',
      'json',
      'log',
      'md',
      'pdf',
      'png',
      'svg',
      'txt',
      'webp',
    ].includes(ext)
  )
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Free the Blob after the click is processed.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Trigger a browser download of a single file. The download endpoint sits
 * behind the admin auth gate. We fetch with the HttpOnly session cookie,
 * materialize a Blob, and click a temporary anchor pointing at the object URL.
 */
export async function sfsDownload(sfsName: string, relPath: string): Promise<void> {
  const blob = await sfsFetchFileBlob(sfsName, relPath)
  triggerBlobDownload(blob, sfsFileName(relPath))
}

export async function sfsOpenOrDownload(
  sfsName: string,
  relPath: string,
  targetWindow?: Window | null
): Promise<void> {
  const blob = await sfsFetchFileBlob(sfsName, relPath)
  const fileName = sfsFileName(relPath)

  if (!targetWindow || targetWindow.closed || !sfsBrowserCanPreview(blob, fileName)) {
    if (targetWindow && !targetWindow.closed) targetWindow.close()
    triggerBlobDownload(blob, fileName)
    return
  }

  const url = URL.createObjectURL(blob)
  targetWindow.location.href = url
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function sfsMkdir(sfsName: string, relPath: string) {
  return apiSend('POST', sfsProxyUrl(sfsName, '/mkdir'), { path: relPath })
}

export async function sfsMove(sfsName: string, fromPath: string, toPath: string) {
  return apiSend('POST', sfsProxyUrl(sfsName, '/move'), { from: fromPath, to: toPath })
}

export async function sfsDelete(sfsName: string, relPath: string, recursive = false) {
  const q = new URLSearchParams({ path: relPath })
  if (recursive) q.set('recursive', 'true')
  return apiSend('DELETE', `${sfsProxyUrl(sfsName, '')}?${q.toString()}`)
}

/**
 * Multipart upload (or replace). The browser sends the admin JWT; control-api
 * mints a wfc browsing token before forwarding. mode='create' uses POST
 * /upload (409 on conflict); mode='replace' uses PUT /replace (404 if missing).
 */
export async function sfsUpload(
  sfsName: string,
  relPath: string,
  file: File,
  mode: 'create' | 'replace' = 'create'
): Promise<{ ok: true; data: { path: string; kind: 'file'; size: number; mtime: string } }> {
  const base = process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL || '/control-api'
  const url = `${base}${sfsProxyUrl(sfsName, mode === 'create' ? '/upload' : '/replace')}`
  const fd = new FormData()
  fd.append('path', relPath)
  fd.append('file', file)
  const res = await fetch(url, {
    method: mode === 'create' ? 'POST' : 'PUT',
    credentials: 'include',
    body: fd,
  })
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 401) {
      clearAdminAuthToken()
      const handler = getGlobalAuthErrorHandler()
      handler?.()
      throw new Error('401 Unauthorized - session expired, please sign in again')
    }
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } }
      detail = parsed.error?.message || parsed.error?.code || text
    } catch {
      detail = text
    }
    throw new Error(`${res.status} ${res.statusText} - ${detail}`)
  }
  return res.json()
}

// ── Global File System file download (operator content proxy) ────────────────
// Mirrors sfsDownload: the operator proxy streams raw bytes from
// GET /api/v1/gfs/proxy/v1/resources/:rid/content (gfsc serveContent). gfsc does
// NOT set Content-Disposition, so the browser can't infer the filename — callers
// pass child.name explicitly. Auth is the same HttpOnly admin cookie the rest of
// control-ui sends (credentials: 'include'); it cannot be a plain <a href>.
export function gfsDownloadUrl(rid: string): string {
  const base = process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL || '/control-api'
  return `${base}/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(rid)}/content`
}

export async function gfsFetchFileBlob(rid: string): Promise<Blob> {
  return fetchAuthenticatedFileBlob(gfsDownloadUrl(rid))
}

/**
 * Trigger a browser download of a single GFS file. Fetches the raw content
 * through the operator-scoped GFS proxy with the admin session cookie,
 * materializes a Blob, and clicks a temporary anchor pointing at the object URL.
 */
export async function gfsDownload(rid: string, fileName: string): Promise<void> {
  const blob = await gfsFetchFileBlob(rid)
  triggerBlobDownload(blob, fileName)
}

export type EnvVar = { name: string; value: string }
export type EnvSecretKeyMapping = { secretKey: string; envVar: string }
export type EnvSecret = { name: string; keys: EnvSecretKeyMapping[] }
export type EgressBinding = {
  egressClass?: 'exact-host' | 'public-web'
  dns?: string
  cidr?: string
  port?: number
  protocol?: 'TCP' | 'UDP'
}

export async function createMcpServer(payload: {
  metadata: { name: string }
  spec: {
    image: string
    contextRef: string
    description?: string
    enabled?: boolean
    managed?: boolean
    transport: {
      type: 'streamableHttp' | 'sse' | 'stdio'
      port?: number
      url?: string
    }
    env?: EnvVar[]
    envSecret?: EnvSecret
    egressBindings?: EgressBinding[]
    command?: string[]
    args?: string[]
  }
}) {
  return apiSend('POST', '/api/v1/admin/mcp-servers', payload) as Promise<McpServerResource>
}

export async function getMcpServer(name: string) {
  return apiGet(
    `/api/v1/admin/mcp-servers/${encodeURIComponent(name)}`
  ) as Promise<McpServerResource>
}

export async function updateMcpServer(name: string, payload: { spec: Record<string, unknown> }) {
  return apiSend(
    'PUT',
    `/api/v1/admin/mcp-servers/${encodeURIComponent(name)}`,
    payload
  ) as Promise<McpServerResource>
}

export async function createMcpSecret(name: string, data: Record<string, string>) {
  return apiSend('POST', '/api/v1/admin/mcp-secrets', { name, data }) as Promise<{
    name: string
    namespace: string
  }>
}

/**
 * Deletes a Secret in the MCP-servers namespace (hardcoded server-side to
 * `config.mcpServersNamespace`). Used by the Create MCP Server flow to roll
 * back a just-created Secret when the subsequent McpServer CRD creation fails,
 * so we never leave orphan Secrets behind.
 */
export async function deleteMcpSecret(name: string) {
  return apiSend('DELETE', `/api/v1/admin/mcp-secrets/${encodeURIComponent(name)}`) as Promise<{
    name: string
    namespace: string
  }>
}

/**
 * Rotates one or more keys on an EXISTING MCP Server Secret (issue #223).
 * `data` carries only the keys the operator wants to rotate — every other key
 * already on the Secret survives untouched (server-side merge-patch). The
 * response is names-only: `keys` lists the resulting key names (never
 * values), and `affectedConnectors` names every McpServer whose
 * `spec.envSecret.name` matches this Secret, so the UI can tell the operator
 * exactly what is about to restart. Saving does NOT restart anything itself —
 * the HCC's SecretInformer reacts to the Secret change and rolls the affected
 * Deployments; the caller must poll getMcpServer() for DeploymentReady to know
 * whether the rollout actually landed (see control-ui/components/UpdateConnectorCredentials).
 */
export async function updateMcpSecret(name: string, data: Record<string, string>) {
  return apiSend('PUT', `/api/v1/admin/mcp-secrets/${encodeURIComponent(name)}`, {
    data,
  }) as Promise<{
    name: string
    namespace: string
    keys: string[]
    affectedConnectors: string[]
  }>
}

export type RecipeSecretOwnership =
  | { kind: 'shared' }
  | { kind: 'owner-recipe'; recipeName: string }
  | { kind: 'unlabeled' }

export type RecipeSecretItem = {
  name: string
  namespace: string
  keys: string[]
  ownership: RecipeSecretOwnership
}

export async function getRecipeSecrets() {
  return apiGet('/api/v1/admin/recipe-secrets') as Promise<{ items?: RecipeSecretItem[] }>
}

export async function createRecipeSecret(
  name: string,
  data: Record<string, string>,
  ownership: Exclude<RecipeSecretOwnership, { kind: 'unlabeled' }>,
  targetNamespace?: string
) {
  return apiSend('POST', '/api/v1/admin/recipe-secrets', {
    name,
    data,
    ownership,
    ...(targetNamespace ? { targetNamespace } : {}),
  }) as Promise<{
    name: string
    namespace: string
    ownership: RecipeSecretOwnership
    created: boolean
  }>
}

export async function updateRecipeSecret(
  name: string,
  data: Record<string, string>,
  removeKeys: string[] = [],
  targetNamespace?: string
) {
  return apiSend('PUT', '/api/v1/admin/recipe-secrets', {
    name,
    data,
    removeKeys,
    ...(targetNamespace ? { targetNamespace } : {}),
  })
}

export async function deleteRecipeSecret(name: string, targetNamespace?: string) {
  const qs = targetNamespace ? `?targetNamespace=${encodeURIComponent(targetNamespace)}` : ''
  return apiSend('DELETE', `/api/v1/admin/recipe-secrets/${encodeURIComponent(name)}${qs}`)
}

// ── LLM model prices (token-budgets P0b) ──────────────────────────────────
// Per-model LLM pricing that backs cost-unit token budgets. Prices are stored
// per 1,000,000 tokens. control-api returns NUMERIC as numbers (mapped server
// side). See control-api/src/services/llmPrices.ts.

export type LlmModelPrice = {
  id: string
  provider: string
  model: string
  input_token_price: number
  output_token_price: number
  cache_read_token_price: number
  cache_write_token_price: number
  currency: string
  effective_from: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export type UnpricedModel = {
  // `null` when the budget scope pins a model but not a provider — the guard
  // reports the model with no specific provider. The UI must accept it.
  provider: string | null
  model: string
}

// Minimal budget reference returned by the 409 price_in_use_by_budget error.
export type BudgetRef = {
  id: string
  name: string
}

function apiErrorBody(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof Error)) return null
  const body = (err as Error & { body?: unknown }).body
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
}

function coerceUnpricedModels(raw: unknown): UnpricedModel[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m): m is UnpricedModel => {
      if (!m || typeof m !== 'object') return false
      const provider = (m as UnpricedModel).provider
      // control-api sends provider: null when the scope pins a model but not a
      // provider — accept null OR string, reject anything else.
      return (
        (provider === null || typeof provider === 'string') &&
        typeof (m as UnpricedModel).model === 'string'
      )
    })
    .map(m => ({ provider: m.provider, model: m.model }))
}

/**
 * When a create/update budget request is rejected with 400 `unpriced_models`
 * (a cost budget whose scope pins model(s) that have no active price), returns
 * the offending models. Returns null for any other error so callers can fall
 * back to a generic message.
 */
export function getUnpricedModelsError(err: unknown): UnpricedModel[] | null {
  const body = apiErrorBody(err)
  if (!body || body.error !== 'unpriced_models') return null
  const models = coerceUnpricedModels(body.models)
  // A matched code with an empty/malformed list would leave both the structured
  // and generic banners hidden — fall through to the generic error instead.
  return models.length ? models : null
}

/**
 * When deleting/disabling/re-keying an active price is rejected with 409
 * `price_in_use_by_budget`, returns the cost budgets still pinning it. Returns
 * null for any other error.
 */
export function getBudgetsUsingPrice(err: unknown): BudgetRef[] | null {
  const body = apiErrorBody(err)
  if (!body || body.error !== 'price_in_use_by_budget') return null
  const raw = body.budgets
  if (!Array.isArray(raw)) return null
  const budgets = raw
    .filter(
      (b): b is BudgetRef =>
        Boolean(b) &&
        typeof (b as BudgetRef).id === 'string' &&
        typeof (b as BudgetRef).name === 'string'
    )
    .map(b => ({ id: b.id, name: b.name }))
  // Empty/malformed list → fall through to the generic error banner.
  return budgets.length ? budgets : null
}

export type CreateLlmPriceInput = {
  provider: string
  model: string
  input_token_price: number
  output_token_price: number
  cache_read_token_price: number
  cache_write_token_price: number
  currency: string
  enabled: boolean
}

export type UpdateLlmPriceInput = Partial<CreateLlmPriceInput>

export async function getLlmPrices() {
  return apiGet('/api/v1/admin/llm-prices') as Promise<{ rows: LlmModelPrice[] }>
}

export async function getUnpricedModels() {
  return apiGet('/api/v1/admin/llm-prices/unpriced') as Promise<{ rows: UnpricedModel[] }>
}

export async function getLlmPrice(id: string) {
  return apiGet(`/api/v1/admin/llm-prices/${encodeURIComponent(id)}`) as Promise<LlmModelPrice>
}

export async function createLlmPrice(input: CreateLlmPriceInput) {
  return apiSend('POST', '/api/v1/admin/llm-prices', input) as Promise<LlmModelPrice>
}

export async function updateLlmPrice(id: string, input: UpdateLlmPriceInput) {
  return apiSend(
    'PUT',
    `/api/v1/admin/llm-prices/${encodeURIComponent(id)}`,
    input
  ) as Promise<LlmModelPrice>
}

export async function deleteLlmPrice(id: string) {
  return apiSend('DELETE', `/api/v1/admin/llm-prices/${encodeURIComponent(id)}`)
}

// ── LLM allowed models (allowlist, spec §3-R3) ────────────────────────────
// Operator-declared allowlist of usable models per provider. Source of truth
// is the control-api `llm_allowed_models` table; a mutation also materializes
// the `clerum-llm-allowed-models` ConfigMap consumed by mcp-host/WRC at runtime.
// This replaces the former static `LLM_MODELS_BY_PROVIDER` catalog in lib/llm.ts.
// See control-api/src/routes/admin/llmModels.ts.

export type LlmAllowedModel = {
  id: string
  provider: string
  model: string
  vendor: string | null
  display_name: string | null
  context_window_tokens: number | null
  enabled: boolean
  // Catalog-lifecycle metadata (spec 09 §7, F1). `source` distinguishes an
  // operator-added row ('manual') from one seeded by discovery ('discovery').
  // `stale` marks a discovery row that vanished from the provider's list but is
  // kept (never auto-removed). Older / not-yet-migrated APIs omit these — the
  // fetch layer normalizes them to 'manual' / false so callers never see undefined.
  source: 'manual' | 'discovery'
  stale: boolean
  discovered_at?: string | null
  last_seen_at?: string | null
  created_at: string
  updated_at: string
}

/**
 * Normalizes a raw allowlist row so the catalog-lifecycle fields are always
 * present (spec 09 §7 F1). Tolerates a pre-migration API that omits `source` /
 * `stale`: defaults to `source:'manual', stale:false` so the table renders the
 * same before and after the backend change. Defensive on the wire value too —
 * any non-'discovery' source collapses to 'manual'.
 */
function normalizeLlmAllowedModel(row: LlmAllowedModel): LlmAllowedModel {
  return {
    ...row,
    source: row.source === 'discovery' ? 'discovery' : 'manual',
    stale: row.stale === true,
    discovered_at: row.discovered_at ?? null,
    last_seen_at: row.last_seen_at ?? null,
  }
}

export type CreateLlmModelInput = {
  provider: string
  model: string
  // `null` explicitly clears the optional column; `undefined` omits it.
  vendor?: string | null
  display_name?: string | null
  context_window_tokens?: number | null
  enabled?: boolean
}

export type UpdateLlmModelInput = Partial<CreateLlmModelInput>

/**
 * True when a create/update/delete was rejected with 503 `configmap_write_failed`.
 * The row was persisted (spec §3-R3.4): only the ConfigMap propagation to the
 * cluster is delayed — surface this as a warning, not a save failure.
 *
 * Matches ONLY the machine-readable code. A bare infra 503 (gateway/pod
 * unavailable, no JSON body → no `code`) means the request may never have
 * reached control-api and the row was NOT saved — that must stay a failure.
 */
export function isLlmModelConfigMapDeferred(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (err as Error & { code?: string }).code === 'configmap_write_failed'
}

export async function getLlmModels() {
  const res = (await apiGet('/api/v1/admin/llm-models')) as { rows: LlmAllowedModel[] }
  return { rows: (res.rows ?? []).map(normalizeLlmAllowedModel) }
}

export async function getLlmModel(id: string) {
  const row = (await apiGet(
    `/api/v1/admin/llm-models/${encodeURIComponent(id)}`
  )) as LlmAllowedModel
  return normalizeLlmAllowedModel(row)
}

export async function createLlmModel(input: CreateLlmModelInput) {
  return apiSend('POST', '/api/v1/admin/llm-models', input) as Promise<LlmAllowedModel>
}

// A disable (PUT enabled→false) or delete of a referenced model is gated by
// control-api (Fase 3): without `?force` it answers 409 `model_in_use` with the
// impact. Passing `{ force: true }` appends `?force=true`, which the operator
// confirms only after seeing that impact — never automatically.
export async function updateLlmModel(
  id: string,
  input: UpdateLlmModelInput,
  opts: { force?: boolean } = {}
) {
  return apiSend(
    'PUT',
    `/api/v1/admin/llm-models/${encodeURIComponent(id)}`,
    input,
    opts.force ? { force: 'true' } : {}
  ) as Promise<LlmAllowedModel>
}

export async function deleteLlmModel(id: string, opts: { force?: boolean } = {}) {
  return apiSend(
    'DELETE',
    `/api/v1/admin/llm-models/${encodeURIComponent(id)}`,
    undefined,
    opts.force ? { force: 'true' } : {}
  )
}

// ── Model references, 409 impact + operator attention feed ─────────────────
// See control-api/src/services/llmAttention.ts and llmModelImpact.ts. The 409
// `model_in_use` impact body (Fase 3) and each attention item (Fase 5, Pieza C)
// carry the SAME `hostsAffected`/`grantsAffected` shape, so both surfaces render
// the references identically.

/** A Host CR that references a (provider, model) pair, with the matched roles. */
export type ModelHostReference = {
  namespace: string
  name: string
  // 'primary' | 'allowedModels' | 'fallback' — kept as string[] so an unknown
  // role from a newer backend renders rather than being dropped.
  roles: string[]
}

/** A capability grant that references a (provider, model) pair. */
export type ModelGrantReference = {
  id: string
  recipeNamespace: string
  recipeName: string
  capabilityFamily: string
}

/** Live references to a (provider, model) pair, shared by both surfaces. */
export type ModelReferences = {
  hostsAffected: ModelHostReference[]
  grantsAffected: ModelGrantReference[]
}

/**
 * One actionable operator-attention item. `kind` is an OPEN string union — today
 * only `'stale_model_referenced'`; the banner switches on it and ignores kinds
 * it does not recognize. `displayName` is optional (omitted, not null).
 */
export type AdminAttentionItem = ModelReferences & {
  kind: string
  provider: string
  model: string
  displayName?: string
}

/** The `GET /admin/attention` response contract consumed by the banner. */
export type AdminAttentionReport = {
  items: AdminAttentionItem[]
  generatedAt: string
}

/** The 409 `model_in_use` impact body (Fase 3): the model plus its references. */
export type ModelInUseImpact = ModelReferences & {
  provider: string
  model: string
}

function coerceModelHostReferences(raw: unknown): ModelHostReference[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const rec = entry as Record<string, unknown>
    if (typeof rec.namespace !== 'string' || typeof rec.name !== 'string') return []
    const roles = Array.isArray(rec.roles)
      ? rec.roles.filter((r): r is string => typeof r === 'string')
      : []
    return [{ namespace: rec.namespace, name: rec.name, roles }]
  })
}

function coerceModelGrantReferences(raw: unknown): ModelGrantReference[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const rec = entry as Record<string, unknown>
    if (
      typeof rec.id !== 'string' ||
      typeof rec.recipeNamespace !== 'string' ||
      typeof rec.recipeName !== 'string' ||
      typeof rec.capabilityFamily !== 'string'
    ) {
      return []
    }
    return [
      {
        id: rec.id,
        recipeNamespace: rec.recipeNamespace,
        recipeName: rec.recipeName,
        capabilityFamily: rec.capabilityFamily,
      },
    ]
  })
}

// Keep every item whose (kind, provider, model) are strings — including unknown
// kinds, so the banner (not the fetch layer) decides what to render. Malformed
// items are dropped rather than tumbling the whole feed.
function coerceAttentionItem(raw: unknown): AdminAttentionItem[] {
  if (!raw || typeof raw !== 'object') return []
  const rec = raw as Record<string, unknown>
  if (
    typeof rec.kind !== 'string' ||
    typeof rec.provider !== 'string' ||
    typeof rec.model !== 'string'
  ) {
    return []
  }
  const item: AdminAttentionItem = {
    kind: rec.kind,
    provider: rec.provider,
    model: rec.model,
    hostsAffected: coerceModelHostReferences(rec.hostsAffected),
    grantsAffected: coerceModelGrantReferences(rec.grantsAffected),
  }
  if (typeof rec.displayName === 'string') item.displayName = rec.displayName
  return [item]
}

export async function getAdminAttention(): Promise<AdminAttentionReport> {
  const raw = (await apiGet('/api/v1/admin/attention')) as {
    items?: unknown
    generatedAt?: unknown
  }
  return {
    items: Array.isArray(raw.items) ? raw.items.flatMap(coerceAttentionItem) : [],
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
  }
}

/**
 * When a disable (PUT enabled→false) or delete is rejected with 409
 * `model_in_use` — the model is still referenced and `?force` was not sent —
 * returns the impact so the caller can show it and offer a forced retry. Returns
 * null for any other error. Mirrors `getBudgetsUsingPrice`: reads the structured
 * `.body` `formatApiError` preserves.
 */
export function getModelInUseImpact(err: unknown): ModelInUseImpact | null {
  if ((err as { status?: number })?.status !== 409) return null
  const body = apiErrorBody(err)
  if (!body || body.error !== 'model_in_use') return null
  const impact = body.impact
  if (!impact || typeof impact !== 'object') return null
  const rec = impact as Record<string, unknown>
  const hostsAffected = coerceModelHostReferences(rec.hostsAffected)
  const grantsAffected = coerceModelGrantReferences(rec.grantsAffected)
  // A matched code with an empty/malformed impact would open the "still in use"
  // confirm with no references to show — fall through to the generic error
  // banner instead, matching getBudgetsUsingPrice/getUnpricedModelsError.
  if (hostsAffected.length === 0 && grantsAffected.length === 0) return null
  return {
    provider: typeof rec.provider === 'string' ? rec.provider : '',
    model: typeof rec.model === 'string' ? rec.model : '',
    hostsAffected,
    grantsAffected,
  }
}

// ── Catalog discovery (spec 09 §7, F2) ────────────────────────────────────
// Discovery pulls the public models.dev catalog into `llm_allowed_models` as
// `source='discovery', enabled=false`. The operator reviews and enables from a
// fresh catalog. These wrappers drive the Discovery Review section on the
// unified /llm-models surface; enable/disable/delete of discovered rows reuse
// the existing update/delete routes above (no dedicated discovery mutation
// endpoint).

// `live` = fetched from the upstream catalog; `vendored` = served from the
// bundled snapshot fallback (upstream unreachable).
export type LlmDiscoverySource = 'live' | 'vendored'

// Result of a sync run: what the reconciliation did to `llm_allowed_models`.
export type LlmDiscoverySyncResult = {
  source: LlmDiscoverySource
  // Catalog acquisition time (when models.dev was fetched/loaded).
  fetchedAt: string
  // DB commit time of this run — matches the status endpoint's `ranAt`, so the
  // "last synced" label is stable across a reload.
  ranAt: string
  added: number
  updated: number
  staled: number
}

// Last-run summary from the optional status endpoint. `null` when discovery has
// never run or the endpoint is not deployed.
export type LlmDiscoveryStatus = {
  ranAt: string
  source: LlmDiscoverySource
  added: number
  updated: number
  staled: number
}

// Runs the catalog sync. Rows are inserted disabled — this never changes what
// the runtime serves; it only refreshes the review queue.
export async function syncDiscovery() {
  return apiSend(
    'POST',
    '/api/v1/admin/llm-models/discovery/sync'
  ) as Promise<LlmDiscoverySyncResult>
}

// Reads the last sync run. The endpoint is optional (spec 09 §7 F2): a missing
// route (404) or an empty body means "never run" — surfaced as `null` rather
// than an error so the page renders without a prior run.
export async function getDiscoveryStatus(): Promise<LlmDiscoveryStatus | null> {
  try {
    // control-api wraps the run in `{ lastRun }` (null when never run).
    const res = (await apiGet('/api/v1/admin/llm-models/discovery/status')) as {
      lastRun: LlmDiscoveryStatus | null
    } | null
    return res?.lastRun ?? null
  } catch (e) {
    if (isSilentApiError(e)) throw e
    if ((e as { status?: number })?.status === 404) return null
    throw e
  }
}

// ── Token budgets (token-budgets P0c) ─────────────────────────────────────
// Budget policies that cap LLM consumption per dimension. In P0c they ship in
// observation mode: the create form defaults new budgets to enforcement 'warn'
// (the server/DB column default stays 'block' per spec). The list/detail
// endpoints attach live `spent`/`remaining`/`unpriced` computed from usage
// rollups; the create/update/patch responses return the bare row (absent).
// See control-api/src/services/budgets/* and routes/admin/budgets.ts.

export type BudgetUnit = 'cost' | 'tokens'
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly'
export type BudgetEnforcement = 'block' | 'warn'

// Mirrors usageReader's `UsageFilters` shape: keys AND, values within a key OR,
// `{}` = global. Keys are restricted server-side to the allowed dimensions.
export type BudgetScope = Record<string, string[]>

export type TokenBudget = {
  id: string
  name: string
  enabled: boolean
  scope: BudgetScope
  unit: BudgetUnit
  currency: string | null
  limit_amount: number
  period: BudgetPeriod
  timezone: string
  min_start_amount: number
  max_task_amount: number | null
  enforcement: BudgetEnforcement
  created_at: string
  updated_at: string
  // Present on list/detail (withSpend); absent on create/update/patch responses.
  spent?: number
  remaining?: number
  unpriced?: UnpricedModel[]
}

export type CreateTokenBudgetInput = {
  name: string
  enabled?: boolean
  scope?: BudgetScope
  unit: BudgetUnit
  currency?: string | null
  limit_amount: number
  period: BudgetPeriod
  timezone?: string
  min_start_amount?: number
  max_task_amount?: number | null
  enforcement?: BudgetEnforcement
}

export type UpdateTokenBudgetInput = Partial<CreateTokenBudgetInput>

export async function getTokenBudgets() {
  return apiGet('/api/v1/admin/budgets') as Promise<{ rows: TokenBudget[] }>
}

export async function getTokenBudget(id: string) {
  return apiGet(`/api/v1/admin/budgets/${encodeURIComponent(id)}`) as Promise<TokenBudget>
}

export async function createTokenBudget(input: CreateTokenBudgetInput) {
  return apiSend('POST', '/api/v1/admin/budgets', input) as Promise<TokenBudget>
}

export async function updateTokenBudget(id: string, input: UpdateTokenBudgetInput) {
  return apiSend(
    'PUT',
    `/api/v1/admin/budgets/${encodeURIComponent(id)}`,
    input
  ) as Promise<TokenBudget>
}

export async function setTokenBudgetEnabled(id: string, enabled: boolean) {
  return apiSend('PATCH', `/api/v1/admin/budgets/${encodeURIComponent(id)}`, {
    enabled,
  }) as Promise<TokenBudget>
}

export async function deleteTokenBudget(id: string) {
  return apiSend('DELETE', `/api/v1/admin/budgets/${encodeURIComponent(id)}`)
}

export async function getContextUsers(contextId: string) {
  return apiGet(`/api/v1/admin/contexts/${encodeURIComponent(contextId)}/users`) as Promise<{
    items?: ContextUser[]
  }>
}

export async function getContextTeams(contextId: string) {
  return apiGet(`/api/v1/admin/contexts/${encodeURIComponent(contextId)}/teams`) as Promise<{
    items?: ContextTeam[]
  }>
}

export async function getAgentUsers(agentName: string) {
  return apiGet(`/api/v1/admin/agents/${encodeURIComponent(agentName)}/users`) as Promise<{
    items?: AgentUser[]
  }>
}

export async function getAgentTeams(agentName: string) {
  return apiGet(`/api/v1/admin/agents/${encodeURIComponent(agentName)}/teams`) as Promise<{
    items?: AgentTeam[]
  }>
}

/**
 * Replace the full set of users authorized for an agent in a single atomic call.
 * Used when creating or editing an agent. Prefer this over looping
 * updateAdminUserAgents() for each user — it's atomic, idempotent, and
 * avoids race conditions with concurrent admins.
 */
export async function updateAgentUsers(agentName: string, userIds: string[]) {
  return apiSend('PUT', `/api/v1/admin/agents/${encodeURIComponent(agentName)}/users`, {
    userIds,
  }) as Promise<{ agentName: string; userIds: string[] }>
}

/**
 * Replace the full set of teams authorized for an agent in a single atomic call.
 * Mirrors updateAgentUsers for team-level access.
 */
export async function updateAgentTeams(agentName: string, teamIds: string[]) {
  return apiSend('PUT', `/api/v1/admin/agents/${encodeURIComponent(agentName)}/teams`, {
    teamIds,
  }) as Promise<{ agentName: string; teamIds: string[] }>
}

export async function getAdminUserContexts(userId: string) {
  return apiGet(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/contexts`
  ) as Promise<UserContextAccess>
}

export async function updateAdminUserContexts(userId: string, contextIds: string[]) {
  return apiSend('PUT', `/api/v1/admin/users/${encodeURIComponent(userId)}/contexts`, {
    contextIds,
  }) as Promise<UserContextAccess>
}

export async function getAdminUserAgents(userId: string) {
  return apiGet(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/agents`
  ) as Promise<UserAgentAccess>
}

export async function updateAdminUserAgents(
  userId: string,
  agentNames: string[],
  expectedCurrentAgentNames: string[]
) {
  return apiSend('PUT', `/api/v1/admin/users/${encodeURIComponent(userId)}/agents`, {
    agentNames,
    expectedCurrentAgentNames,
  }) as Promise<UserAgentAccess>
}

export async function getAdminUserTeams(userId: string) {
  return apiGet(`/api/v1/admin/users/${encodeURIComponent(userId)}/teams`) as Promise<{
    currentTeamId?: string
    items?: TeamSummary[]
  }>
}

export async function getAdminTeams() {
  return apiGet('/api/v1/admin/teams') as Promise<{ items?: TeamListItem[] }>
}

export async function getAdminTeam(teamId: string) {
  return apiGet(`/api/v1/admin/teams/${encodeURIComponent(teamId)}`) as Promise<{
    id: string
    name: string
  }>
}

export async function getAdminTeamContexts(teamId: string) {
  return apiGet(
    `/api/v1/admin/teams/${encodeURIComponent(teamId)}/contexts`
  ) as Promise<TeamContextAccess>
}

export async function updateAdminTeamContexts(teamId: string, contextIds: string[]) {
  return apiSend('PUT', `/api/v1/admin/teams/${encodeURIComponent(teamId)}/contexts`, {
    contextIds,
  }) as Promise<TeamContextAccess>
}

export async function getAdminTeamAgents(teamId: string) {
  return apiGet(
    `/api/v1/admin/teams/${encodeURIComponent(teamId)}/agents`
  ) as Promise<TeamAgentAccess>
}

export async function updateAdminTeamAgents(
  teamId: string,
  agentNames: string[],
  expectedCurrentAgentNames: string[]
) {
  return apiSend('PUT', `/api/v1/admin/teams/${encodeURIComponent(teamId)}/agents`, {
    agentNames,
    expectedCurrentAgentNames,
  }) as Promise<TeamAgentAccess>
}

export async function getAdminUserContext(userId: string) {
  return apiGet(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/context`
  ) as Promise<AdminUserContext>
}

export async function updateAdminUserContext(
  userId: string,
  payload: { email: string; name?: string; channels: AdminUserChannels }
) {
  return apiSend(
    'PUT',
    `/api/v1/admin/users/${encodeURIComponent(userId)}/context`,
    payload
  ) as Promise<AdminUserContext>
}

export async function getAdminTeamMembers(teamId: string) {
  return apiGet(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/members`) as Promise<{
    items?: TeamMember[]
  }>
}

export async function getAdminTeamPendingInvitations(teamId: string) {
  return apiGet(`/api/v1/admin/teams/${encodeURIComponent(teamId)}/invitations`) as Promise<{
    items?: AdminTeamPendingInvitation[]
  }>
}

export async function getAdminAllPendingInvitations() {
  return apiGet('/api/v1/admin/pending-invitations') as Promise<{
    items?: AdminPendingInvitationListItem[]
  }>
}

export async function revokeAdminTeamInvitation(
  teamId: string | null | undefined,
  invitationId: string
) {
  if (!teamId) {
    return apiSend(
      'DELETE',
      `/api/v1/admin/invitations/${encodeURIComponent(invitationId)}`
    ) as Promise<{ revoked: boolean; id: string; email: string }>
  }
  return apiSend(
    'DELETE',
    `/api/v1/admin/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(invitationId)}`
  ) as Promise<{ revoked: boolean; id: string; email: string }>
}

export async function createAdminTeam(name: string) {
  return apiSend('POST', '/api/v1/admin/teams', { name }) as Promise<{
    id: string
    name: string
  }>
}

export async function addAdminTeamMember(teamId: string, userId: string, role: TeamRole) {
  return apiSend('POST', `/api/v1/admin/teams/${encodeURIComponent(teamId)}/members`, {
    userId,
    role,
  })
}

export async function renameAdminTeam(teamId: string, name: string) {
  return apiSend('PUT', `/api/v1/admin/teams/${encodeURIComponent(teamId)}/name`, { name })
}

export async function inviteAdminTeamMember(
  teamId: string | null | undefined,
  payload: {
    name: string
    email: string
    role: InviteRole
    teams?: Array<{ teamId: string; role: InviteRole }>
  }
) {
  if (!teamId) {
    return apiSend('POST', '/api/v1/admin/invitations', payload) as Promise<{
      id: string
      team_id: string | null
      invitee_name: string | null
      email: string
      role: InviteRole
      token: string
      status: 'pending'
      created_at: string
    }>
  }
  return apiSend(
    'POST',
    `/api/v1/admin/teams/${encodeURIComponent(teamId)}/invitations`,
    payload
  ) as Promise<{
    id: string
    team_id: string | null
    invitee_name: string | null
    email: string
    role: InviteRole
    token: string
    status: 'pending'
    created_at: string
  }>
}

export async function resendAdminTeamInvitation(
  teamId: string | null | undefined,
  invitationId: string
) {
  if (!teamId) {
    return apiSend(
      'POST',
      `/api/v1/admin/invitations/${encodeURIComponent(invitationId)}/resend`
    ) as Promise<{ sent: true; id: string; email: string }>
  }
  return apiSend(
    'POST',
    `/api/v1/admin/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(invitationId)}/resend`
  ) as Promise<{ sent: true; id: string; email: string }>
}

export async function resendAdminUserPasswordSetupInvitation(userId: string) {
  return apiSend(
    'POST',
    `/api/v1/admin/users/${encodeURIComponent(userId)}/invitations/password-setup/resend`
  ) as Promise<{ sent: true; id: string; email: string; teamId: string | null }>
}

export async function updateAdminMemberRole(teamId: string, userId: string, role: TeamRole) {
  return apiSend(
    'PATCH',
    `/api/v1/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/role`,
    { role }
  )
}

export async function deleteAdminMember(teamId: string, userId: string) {
  return apiSend(
    'DELETE',
    `/api/v1/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`
  )
}

/** Hard-deletes the team and cascades memberships, invitations, team context/agent links. */
export async function deleteAdminTeam(teamId: string) {
  return apiSend('DELETE', `/api/v1/admin/teams/${encodeURIComponent(teamId)}`) as Promise<{
    deleted: boolean
    id: string
  }>
}

export type DeleteAdminUserRequest = {
  /** Persisted with the governed retirement operation for its audit trail. */
  reason?: string
  /** Reuse this on a transport retry of the same user action. */
  idempotencyKey?: string
  /** Connects the browser request to the Control API retirement audit row. */
  correlationId?: string
}

const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function generateRetirementRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // The Control API accepts a correlation header only when it is UUID-shaped.
  // This compatibility branch keeps embedded/legacy browser retries traceable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, marker => {
    const nibble = Math.floor(Math.random() * 16)
    return (marker === 'x' ? nibble : (nibble & 0x3) | 0x8).toString(16)
  })
}

/** Creates one stable request identity for all transport retries in a UI operation. */
export function createDeleteAdminUserRequest(
  reason = 'control_ui_user_retirement'
): Required<DeleteAdminUserRequest> {
  return {
    reason,
    idempotencyKey: generateRetirementRequestId(),
    correlationId: generateRetirementRequestId(),
  }
}

/**
 * Retires the user through the governed lifecycle contract. A caller may retain
 * the supplied key when retrying the same action; an ordinary UI action gets a
 * new request identity and an explicit audit reason.
 */
export async function deleteAdminUser(userId: string, request: DeleteAdminUserRequest = {}) {
  const idempotencyKey = request.idempotencyKey?.trim() || generateRetirementRequestId()
  const providedCorrelationId = request.correlationId?.trim() || ''
  const correlationId = UUID_ANY_RE.test(providedCorrelationId)
    ? providedCorrelationId.toLowerCase()
    : generateRetirementRequestId()
  const reason = request.reason?.trim() || 'control_ui_user_retirement'
  return apiSend(
    'DELETE',
    `/api/v1/admin/users/${encodeURIComponent(userId)}`,
    { reason },
    {},
    {
      'Idempotency-Key': idempotencyKey,
      'x-correlation-id': correlationId,
    }
  ) as Promise<{
    deleted: boolean
    id: string
  }>
}

// ── WorkflowRecipe types ─────────────────────────────────────────────────────

export type WorkflowRecipePhase =
  | 'candidate'
  | 'pending-approval'
  | 'approved'
  | 'pending'
  | 'pending-operator-input'
  | 'deploying'
  | 'testing'
  | 'active'
  | 'degraded'
  | 'rolling-back'
  | 'failed'
  | 'deprecated'
  | 'rollback-failed'

export type WorkflowExecutionPhase =
  | 'pending'
  | 'initializing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovering'

export type WorkflowRecipeStatus = {
  phase?: WorkflowRecipePhase
  workloads?: Array<{ id: string; ready: boolean; replicas?: number }>
  message?: string
  workflowExecution?: { phase?: WorkflowExecutionPhase; [key: string]: unknown }
  [key: string]: unknown
}

export type WorkflowRecipeResource = {
  apiVersion?: string
  kind?: string
  metadata?: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
  }
  spec?: Record<string, unknown>
  status?: WorkflowRecipeStatus
}

export type PendingWorkflowCredentialRef = {
  kind: string
  secretName: string
  namespace: string
  keys: string[]
  field: string
  fields?: string[]
}

export type WorkflowRecipeMutationResponse = WorkflowRecipeResource & {
  pendingCredentials?: PendingWorkflowCredentialRef[]
}

// ── WorkflowRecipe API functions ──────────────────────────────────────────────

export async function getRecipes() {
  return apiGet('/api/v1/admin/recipes') as Promise<{ items?: WorkflowRecipeResource[] }>
}

export async function getRecipe(name: string) {
  return apiGet(
    `/api/v1/admin/recipes/${encodeURIComponent(name)}`
  ) as Promise<WorkflowRecipeResource>
}

export async function createRecipe(payload: {
  metadata: { name: string; namespace?: string }
  spec: Record<string, unknown>
}) {
  return apiSend(
    'POST',
    '/api/v1/admin/recipes',
    payload
  ) as Promise<WorkflowRecipeMutationResponse>
}

export type ServerValidationError = {
  field: string
  message: string
  // Set for policy/invariant violations (e.g. agenticWorkflowContextRefBlocked).
  // Undefined for structural errors from validateRecipeBody.
  rule?: string
}

export type ServerValidationResult =
  | { valid: true; pendingCredentials?: PendingWorkflowCredentialRef[] }
  | { valid: false; errors: ServerValidationError[] }

// Server-side recipe validation (distinct from the client-side parser in
// `lib/recipeValidator.ts` which only checks JSON shape). Runs the same
// structural checks as `POST /recipes` plus policy invariants that require
// cluster state (e.g. matching WorkflowRecipePolicy existence).
//
// Uses `fetch` directly (NOT `apiSend`) because 422 is a legitimate business
// response — the backend returns `{ valid: false, errors }` at 422 for both
// structural and policy rejections. `apiSend` would throw on any non-2xx,
// forcing callers into try/catch for the normal "invalid recipe" path.
// Other HTTP errors (401, 5xx) still throw so the editor can soft-fail and
// let the reconciler catch at L4.
export async function validateRecipeServer(
  recipe: {
    metadata: { name: string; namespace?: string }
    spec: Record<string, unknown>
  },
  opts: { mode?: 'create' | 'edit' } = {}
): Promise<ServerValidationResult> {
  // `mode=edit` tells the server to skip the name-collision check — the
  // recipe is expected to exist. Default 'create' is the stricter path.
  const mode = opts.mode === 'edit' ? 'edit' : 'create'
  const res = await fetch(`${API_BASE}/api/v1/admin/recipes/validate?mode=${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(recipe),
  })
  if (res.status === 200 || res.status === 422) {
    return (await res.json()) as ServerValidationResult
  }
  if (res.status === 401) {
    handleUnauthorized()
  }
  const text = await res.text()
  throw new Error(`${res.status} ${res.statusText} - ${text}`)
}

export async function updateRecipe(name: string, payload: { spec: Record<string, unknown> }) {
  return apiSend(
    'PUT',
    `/api/v1/admin/recipes/${encodeURIComponent(name)}`,
    payload
  ) as Promise<WorkflowRecipeMutationResponse>
}

export async function deleteRecipe(name: string) {
  return apiSend('DELETE', `/api/v1/admin/recipes/${encodeURIComponent(name)}`)
}

export async function retryRecipe(name: string) {
  return apiSend('POST', `/api/v1/admin/recipes/${encodeURIComponent(name)}/retry`) as Promise<{
    name: string
    phase: string
  }>
}

export async function getRecipeStatus(name: string) {
  return apiGet(
    `/api/v1/admin/recipes/${encodeURIComponent(name)}/status`
  ) as Promise<WorkflowRecipeStatus>
}

// ── Recipe OAuth (Path B — background OAuth) ─────────────────────────────────
//
// Admin-only "connect for the recipe" surface. The connect route mints a
// `service` authorize URL the operator opens in a browser; status/disconnect
// inspect and revoke the recipe-owned grant.

export async function getRecipeOauthStatus(
  recipeName: string,
  oauthClientId: string
): Promise<{ connected: boolean }> {
  return apiGet(
    `/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/oauth/${encodeURIComponent(oauthClientId)}/status`
  ) as Promise<{ connected: boolean }>
}

export async function connectRecipeOauth(
  recipeName: string,
  oauthClientId: string
): Promise<{ authorizeUrl: string }> {
  return apiSend(
    'POST',
    `/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/oauth/${encodeURIComponent(oauthClientId)}/connect`
  ) as Promise<{ authorizeUrl: string }>
}

// DELETE returns 204 with no body — apiSend's res.json() would throw on the
// empty response, so this one calls fetch directly.
export async function disconnectRecipeOauth(
  recipeName: string,
  oauthClientId: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/oauth/${encodeURIComponent(oauthClientId)}/grant`,
    { method: 'DELETE', headers: { ...authHeaders() } }
  )
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized()
    const text = await res.text()
    const error = new Error(`${res.status} ${res.statusText} - ${text}`)
    ;(error as Error & { status?: number }).status = res.status
    throw error
  }
}

// ── Per-user grant oversight (admin read-only list + force-revoke) ────────────
//
// Lists individual user grants for a specific background OAuth client, and lets
// an admin force-revoke any user's grant. Additive — does not change the
// existing service-grant connect/disconnect surface.

export type UserGrant = { userId: string; background: boolean; updatedAt: string }

export async function adminListUserGrants(
  recipeName: string,
  oauthClientId: string
): Promise<{ users: UserGrant[] }> {
  return apiGet(
    `/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/oauth/${encodeURIComponent(oauthClientId)}/user-grants`
  ) as Promise<{ users: UserGrant[] }>
}

// DELETE returns 204 with no body — call fetch directly (same pattern as disconnectRecipeOauth).
export async function adminRevokeUserGrant(
  recipeName: string,
  oauthClientId: string,
  userId: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/oauth/${encodeURIComponent(oauthClientId)}/user-grants/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { ...authHeaders() } }
  )
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized()
    const text = await res.text()
    const error = new Error(`${res.status} ${res.statusText} - ${text}`)
    ;(error as Error & { status?: number }).status = res.status
    throw error
  }
}

export type RecipePodContainer = {
  name: string
  ready: boolean
  state: 'waiting' | 'terminated' | 'running'
  reason: string | null
  message: string | null
  restartCount: number
}

export type RecipePod = {
  name: string
  namespace: string
  workloadId: string | null
  phase: string
  reason: string | null
  message: string | null
  restarts: number
  createdAt: string | null
  containers: RecipePodContainer[]
}

export async function getRecipePods(name: string): Promise<{ pods: RecipePod[] }> {
  return apiGet(`/api/v1/admin/recipes/${encodeURIComponent(name)}/pods`) as Promise<{
    pods: RecipePod[]
  }>
}

export type ArtifactInfo = {
  name: string
  format: string
  sizeBytes: number
  path?: string
  createdAt: string
}

export async function getRecipeArtifacts(name: string) {
  return apiGet(`/api/v1/admin/recipes/${encodeURIComponent(name)}/artifacts`) as Promise<{
    artifacts: ArtifactInfo[]
  }>
}

export function getArtifactDownloadUrl(recipeName: string, artifactName: string): string {
  return `${API_BASE}/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/artifacts/${encodeURIComponent(artifactName)}/download`
}

export function getWorkflowRunArtifactDownloadUrl(
  namespace: string,
  name: string,
  runId: string,
  artifactName: string
): string {
  return `${API_BASE}/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`
}

export async function getWorkflowRunArtifacts(
  namespace: string,
  name: string,
  runId: string
): Promise<{ artifacts: ArtifactInfo[] }> {
  return apiGet(
    `/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts`
  ) as Promise<{ artifacts: ArtifactInfo[] }>
}

// ── Workflow runs (admin-only) ─────────────────────────────────────────────
// Per-recipe list of WorkflowRun rows, ordered newest-first. Backed by
// `GET /api/v1/admin/workflows/:ns/:name/runs?limit=N`. Combines live DB rows
// with audit-only rows for runs that finished and got purged from the live
// table — server-side dedup happens by run_id.

export type WorkflowRunSummary = {
  id: string
  source: 'live' | 'audit' | 'status' | string
  approvalRequestId?: string | null
  phase: string
  triggeredAt: string | null
  startedAt: string | null
  completedAt: string | null
  message: string | null
  actor: { type?: string; userId?: string; adminUserId?: string; hostRef?: string } | null
  executionRef: { namespace: string; name: string } | null

  // Legacy/older UI callers tolerated these fields before Control API moved
  // workflow run reads to the canonical DTO. Keep them optional so current API
  // responses type-check while older fixtures still render.
  recipeNamespace?: string
  recipeName?: string
  triggerSource?: 'onDemand' | 'schedule' | 'autonomous' | string
  finalPhase?: string | null
  errorMessage?: string | null
  triggerer?: { kind?: string; userId?: string; hostRef?: string } | null
}

export async function getWorkflowRuns(
  namespace: string,
  name: string,
  limit = 20
): Promise<{ items: WorkflowRunSummary[]; count: number }> {
  return apiGet(
    `/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/runs?limit=${limit}`
  ) as Promise<{ items: WorkflowRunSummary[]; count: number }>
}

export async function getWorkflowRun(
  namespace: string,
  name: string,
  runId: string,
  signal?: AbortSignal
): Promise<WorkflowRunSummary> {
  return apiGet(
    `/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}`,
    {},
    { signal }
  ) as Promise<WorkflowRunSummary>
}

// ── Workflow grants (admin-only) ───────────────────────────────────────────
// Per-recipe list of users authorized to trigger the workflow from the
// Desktop App. Backed by `PUT /api/v1/admin/workflows/:ns/:name/grants`
// with bulk-replace semantics (mirrors `/admin/agents/:agentName/users`).
// See .ralph/plans/whimsical-mixing-pine.md for context.

export type WorkflowGrantUser = {
  id: string
  email: string
  name: string | null
  displayName: string | null
}

export type WorkflowGrantTeam = {
  id: string
  name: string
}

export type WorkflowApprovalAllowedTeam = {
  id: string
  name: string
  createdAt: string
}

export async function listWorkflowGrants(ns: string, name: string) {
  return apiGet(
    `/api/v1/admin/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/grants`
  ) as Promise<{ items: WorkflowGrantUser[] }>
}

export async function setWorkflowGrants(ns: string, name: string, userIds: string[]) {
  return apiSend(
    'PUT',
    `/api/v1/admin/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/grants`,
    { userIds }
  ) as Promise<{ userIds: string[] }>
}

export async function listWorkflowTeamGrants(ns: string, name: string) {
  return apiGet(
    `/api/v1/admin/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/team-grants`
  ) as Promise<{ items: WorkflowGrantTeam[] }>
}

export async function setWorkflowTeamGrants(ns: string, name: string, teamIds: string[]) {
  return apiSend(
    'PUT',
    `/api/v1/admin/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/team-grants`,
    { teamIds }
  ) as Promise<{ teamIds: string[]; added: string[]; removed: string[] }>
}

export async function listWorkflowApprovalAllowedTeams(ns: string, name: string) {
  return apiGet(
    `/api/v1/admin/workflow-recipes/${encodeURIComponent(ns)}/${encodeURIComponent(
      name
    )}/allowed-teams`
  ) as Promise<{ items: WorkflowApprovalAllowedTeam[] }>
}

export async function allowWorkflowApprovalTeam(ns: string, name: string, teamId: string) {
  return apiSend(
    'PUT',
    `/api/v1/admin/workflow-recipes/${encodeURIComponent(ns)}/${encodeURIComponent(
      name
    )}/allowed-teams/${encodeURIComponent(teamId)}`
  ) as Promise<{ teamId: string }>
}

export async function revokeWorkflowApprovalTeam(ns: string, name: string, teamId: string) {
  return apiSend(
    'DELETE',
    `/api/v1/admin/workflow-recipes/${encodeURIComponent(ns)}/${encodeURIComponent(
      name
    )}/allowed-teams/${encodeURIComponent(teamId)}`
  ) as Promise<{ teamId: string }>
}

export async function deleteRecipeArtifact(recipeName: string, artifactName: string) {
  const url = `${API_BASE}/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/artifacts/${encodeURIComponent(artifactName)}`
  const resp = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!resp.ok) {
    const errBody = await resp.text()
    throw new Error(`${resp.status}: ${errBody}`)
  }
}

export async function deleteAllRecipeArtifacts(recipeName: string) {
  const url = `${API_BASE}/api/v1/admin/recipes/${encodeURIComponent(recipeName)}/artifacts`
  const resp = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!resp.ok) {
    const errBody = await resp.text()
    throw new Error(`${resp.status}: ${errBody}`)
  }
}

export async function deleteWorkflowRunArtifact(
  namespace: string,
  name: string,
  runId: string,
  artifactName: string
) {
  const url = `${API_BASE}/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}`
  const resp = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!resp.ok) {
    const errBody = await resp.text()
    throw new Error(`${resp.status}: ${errBody}`)
  }
}

export async function deleteWorkflowRunArtifacts(namespace: string, name: string, runId: string) {
  const url = `${API_BASE}/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts`
  const resp = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!resp.ok) {
    const errBody = await resp.text()
    throw new Error(`${resp.status}: ${errBody}`)
  }
}

// ── Host (chat mode) artifact API functions ───────────────────────────────────

export type HostArtifactInfo = {
  name: string
  format: string
  sizeBytes: number
  createdAt: string
}
export type WorkflowOutputRow = {
  recipeName: string
  namespace: string
  runId: string
  fileName: string
  format: string
  sizeBytes?: number
  completedAt: string
}
export type ChatArtifactOutputRow = {
  hostRef: string
  fileName: string
  format: string
  sizeBytes: number
  createdAt: string
}
export type AdminOutputsOverview = {
  workflowOutputs: WorkflowOutputRow[]
  chatArtifacts: ChatArtifactOutputRow[]
  warnings?: string[]
}

export async function getHostArtifacts(hostRef: string) {
  return apiGet(`/api/v1/admin/hosts/${encodeURIComponent(hostRef)}/artifacts`) as Promise<{
    artifacts: HostArtifactInfo[]
    hostRef: string
    podName: string
  }>
}

export function getHostArtifactDownloadUrl(hostRef: string, artifactName: string): string {
  return `${API_BASE}/api/v1/admin/hosts/${encodeURIComponent(hostRef)}/artifacts/${encodeURIComponent(artifactName)}/download`
}

export async function getAdminOutputsOverview() {
  return apiGet('/api/v1/admin/outputs') as Promise<AdminOutputsOverview>
}

export function safeJson(value: unknown): string {
  return JSON.stringify(
    value,
    (key, val) => {
      const k = key.toLowerCase()
      if (
        k.includes('secret') ||
        k.includes('token') ||
        k.includes('password') ||
        k.includes('stringdata') ||
        k === 'data' ||
        k === 'stringData'
      ) {
        return '[REDACTED]'
      }
      return val
    },
    2
  )
}

// ────────────────────────────────────────────────────────────────────
// Registry — BFF client for /api/v1/admin/registry/* on control-api
// Mirrors snake_case shapes returned by the Clerum Registry service
// (see control-api/src/services/registryClient.ts and the unified
// spec in MiVault: projects/clerum/wro/clerum-registry-unified-specification.md).
// ────────────────────────────────────────────────────────────────────

export type RegistryEntry = {
  id: string
  name: string
  version: string
  entry_type: string // "mcp-server" | "recipe"
  description: string
  author: string
  origin: string
  category: string
  tags: string[]
  trust_level: string // "high" | "mid" | "low"
  quality_tier: string // "verified" | "unverified"
  visibility?: 'public' | 'private' // present on full registry rows; absent on older/partial rows
  status: string // "published" | "deprecated" | "removed"
  server_mode: string | null // "local" | "remote" (mcp-server entries)
  transport: string | null // "streamableHttp" | "sse" | "stdio"
  recipe_type: string | null // "workflow" | "only-workloads"
  mcp_server_meta:
    | (Record<string, unknown> & {
        credentialSchema?: CredentialSchema
        tools?: string[]
        remoteEndpoints?: Array<{ url: string; region?: string; description?: string }>
        egressSummary?: { domains?: string[]; ports?: number[]; wideCidr?: boolean }
        authHeaders?: Record<string, string>
      })
    | null
  recipe_meta:
    | (Record<string, unknown> & {
        recipeYaml?: string
        stepCount?: number
      })
    | null
  artifact_refs: Record<string, unknown> | null
  downloads: number
  installs: number
  created_at: string
}

export type CredentialKey = {
  name: string // e.g. "API_KEY"
  label: string // human-readable label
  kind: string // "api-key" | "oauth-token" | "connection-string" | "password" | "text"
  semanticType?: string
  description?: string
  enumValues?: string[]
}

export type CredentialSchema = {
  required: boolean
  authType: string // "api-key" | "bearer-token" | "connection-string" | "platform-credentials" | "none"
  keys: CredentialKey[]
}

export type RegistrySearchParams = {
  q?: string
  entryType?: string
  category?: string
  serverMode?: string
  transport?: string
  trustLevel?: string
  sort?: string
  limit?: string
  offset?: string
}

export type RegistryEntryListResponse = {
  data: RegistryEntry[]
  // `meta` is optional; when present, only `total` is guaranteed. `limit` and
  // `offset` are only returned when the BFF paginates explicitly — keeping them
  // optional matches the real wire contract and avoids forcing callers to
  // fabricate pagination state they don't use (e.g. RegistryCatalog reads only
  // `meta.total` for the "X of Y" counter).
  meta?: { total: number; limit?: number; offset?: number }
}
export type RegistryInstalledState = {
  catalogKeys: string[]
  serverNames: string[]
  recipeKeys: string[]
}
export type RegistryCatalogResponse = RegistryEntryListResponse & {
  categories: string[]
  installed: RegistryInstalledState
}

// The registry's `tags` column is nullable, so an entry can arrive with
// `tags: null`. RegistryCatalog and the entry detail page call
// entry.tags.length / .some / .map directly, so a null crashes the whole page
// with "Cannot read properties of null (reading 'length')". Coerce tags to a
// real array at the wrapper boundary so RegistryEntry.tags is always the
// string[] its type claims.
function normalizeRegistryEntry(entry: RegistryEntry): RegistryEntry {
  return Array.isArray(entry.tags) ? entry : { ...entry, tags: [] }
}

export async function getRegistryEntries(
  params: RegistrySearchParams = {}
): Promise<RegistryEntryListResponse> {
  const res = (await apiGet('/api/v1/admin/registry/entries', params)) as RegistryEntryListResponse
  return { ...res, data: (res?.data ?? []).map(normalizeRegistryEntry) }
}

export async function getRegistryCatalog(
  params: RegistrySearchParams = {}
): Promise<RegistryCatalogResponse> {
  const res = (await apiGet('/api/v1/admin/registry/catalog', params)) as RegistryCatalogResponse
  return { ...res, data: (res?.data ?? []).map(normalizeRegistryEntry) }
}

export async function getRegistryEntryVersion(
  name: string,
  version: string
): Promise<RegistryEntry> {
  const entry = (await apiGet(
    `/api/v1/admin/registry/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
  )) as RegistryEntry
  return normalizeRegistryEntry(entry)
}

export async function getRegistryCategories(): Promise<{ data: string[] }> {
  return apiGet('/api/v1/admin/registry/categories') as Promise<{ data: string[] }>
}

export async function getRegistryCredentialSchema(
  name: string,
  version: string
): Promise<CredentialSchema> {
  return apiGet(
    `/api/v1/admin/registry/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/credential-schema`
  ) as Promise<CredentialSchema>
}

export type InstallFromRegistryRequest = {
  serverName?: string
  namespace?: string
  contextRef: string
  registryEntryName: string
  registryEntryVersion: string
  credentials?: Record<string, string>
  egressBindings?: EgressBinding[]
}

export type InstallFromRegistryResponse = {
  installed: boolean
  serverName: string
  namespace: string
  contextRef: string
  // The saga endpoint returns additional fields (correlationId, addedToContext, etc.)
  // — we keep it open so callers can read whatever the BFF chooses to surface.
  [key: string]: unknown
}

export async function installFromRegistry(
  req: InstallFromRegistryRequest
): Promise<InstallFromRegistryResponse> {
  return apiSend(
    'POST',
    '/api/v1/admin/registry/install',
    req
  ) as Promise<InstallFromRegistryResponse>
}

export type InstallRecipeFromRegistryRequest = {
  recipeName?: string
  registryEntryName: string
  registryEntryVersion: string
  recipeManifest?: string
  inputValues?: Record<string, unknown>
}

export type InstallRecipeFromRegistryResponse = {
  recipeName: string
  registryEntry: string
  registryVersion: string
  correlationId: string
  pendingCredentials?: PendingWorkflowCredentialRef[]
}

export async function installRecipeFromRegistry(
  req: InstallRecipeFromRegistryRequest
): Promise<InstallRecipeFromRegistryResponse> {
  return apiSend(
    'POST',
    '/api/v1/admin/registry/install-recipe',
    req
  ) as Promise<InstallRecipeFromRegistryResponse>
}

export type TriggerWorkflowRequest = {
  inputs?: Record<string, unknown>
  intermediateParameters?: Record<string, unknown>
  outputOverrides?: Record<string, unknown>
}

// Mirrors mapDbRun in control-api/src/routes/admin/workflows.ts. The server
// can return additional fields, so we keep this open via index signature.
export type WorkflowRunRow = {
  runId: string
  recipeNamespace: string
  recipeName: string
  triggeredAt: string | null
  startedAt?: string | null
  completedAt?: string | null
  finalPhase?: string | null
  errorMessage?: string | null
  [key: string]: unknown
}

export async function triggerWorkflow(
  ns: string,
  name: string,
  body: TriggerWorkflowRequest,
  idempotencyKey: string
): Promise<WorkflowRunRow> {
  return apiSend(
    'POST',
    `/api/v1/admin/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/trigger`,
    body,
    {},
    { 'Idempotency-Key': idempotencyKey }
  ) as Promise<WorkflowRunRow>
}

export async function publishToRegistry(payload: Record<string, unknown>): Promise<RegistryEntry> {
  return apiSend('POST', '/api/v1/admin/registry/entries', payload) as Promise<RegistryEntry>
}

// Resolved publish target for the current caller, sourced from control-api
// (which asks the registry's whoami/discovery — registry stays authoritative).
// `scope` is the org scope this client publishes under (e.g. "newtenantwf"),
// or null when the caller publishes into the curated public catalog. `curator`
// is true for the curated-catalog machine client. `orgName` is the human-facing
// org label when bound to an org. The publish form only DISPLAYS this — the bare
// `name` input and the submitted payload are unchanged; control-api applies the
// scope to the name server-side.
export type PublishScope = {
  scope: string | null
  curator: boolean
  orgName: string | null
  // Static config value (not registry-derived); absent/undefined is treated as
  // enabled for backward compat with a control-api that doesn't send it yet.
  publisherUiEnabled?: boolean
}

export async function getPublishScope(): Promise<PublishScope> {
  return apiGet('/api/v1/admin/registry/publish-scope') as Promise<PublishScope>
}

// ─── Publisher — owned entries, cross-org grants, granted-to-me ────────────
// Contract built by the parallel control-api session; mocked in tests here.
// Owned entries use a dedicated /owned-entries route (the existing /entries is
// the general catalog — reusing it would collide). Grant create/revoke go
// through registryCodedRequest so the typed { error: <code> } body is surfaced
// on `.code` for inline rendering (grantee_not_found / self_grant / plugin_public …).

export type OwnedRegistryEntry = {
  name: string // scoped "@org/name" or bare "name"
  version: string
  visibility: 'public' | 'private'
  status: string // "published" | "deprecated" | "removed"
  entry_type?: string // "mcp-server" | "recipe"
  // Present ("local"/"remote") for mcp-servers, null/absent for recipes. The
  // registry's /org/:org/entries returns this but NOT entry_type, so the
  // Publisher's Type column infers Connector/Plugin from it (see OwnedEntries).
  serverMode?: string | null
}
export type OwnedRegistryEntriesResponse = {
  data: OwnedRegistryEntry[]
  meta?: { total: number }
}
export type OrgGrant = {
  id: string
  pluginName: string // scoped "@org/name"
  granteeOrg: string // grantee org slug
  createdAt?: string
}
export type CreateOrgGrantInput = {
  pluginName: string
  granteeOrg: string
}
export type GrantedToMeItem = {
  pluginName: string // scoped "@ownerOrg/name"
  ownerOrg: string
  createdAt?: string
}

// The control-api proxy forwards the registry's grant / granted-to-me items
// verbatim, and the registry's catalog rows are snake_case (entry_type,
// created_at, …). The grant item field naming is not pinned by either side's
// tests, so normalize defensively here — accept camelCase OR snake_case — and
// hand components one canonical camelCase shape. This keeps the mocked→live
// transition safe regardless of which the registry emits, and avoids silent
// empty lists (GrantAccessModal filters on pluginName) or "@undefined" rows.
type RawOrgGrant = {
  id?: string
  pluginName?: string
  plugin_name?: string
  granteeOrg?: string
  grantee_org?: string
  createdAt?: string
  created_at?: string
}
type RawGrantedToMeItem = {
  pluginName?: string
  plugin_name?: string
  ownerOrg?: string
  owner_org?: string
  createdAt?: string
  created_at?: string
}
function normalizeOrgGrant(r: RawOrgGrant): OrgGrant {
  return {
    id: r.id ?? '',
    pluginName: r.pluginName ?? r.plugin_name ?? '',
    granteeOrg: r.granteeOrg ?? r.grantee_org ?? '',
    createdAt: r.createdAt ?? r.created_at,
  }
}
function normalizeGrantedToMeItem(r: RawGrantedToMeItem): GrantedToMeItem {
  return {
    pluginName: r.pluginName ?? r.plugin_name ?? '',
    ownerOrg: r.ownerOrg ?? r.owner_org ?? '',
    createdAt: r.createdAt ?? r.created_at,
  }
}

export async function getOwnedRegistryEntries(): Promise<OwnedRegistryEntriesResponse> {
  // The registry's /org/:org/entries returns { entries: [...] } — its real wire
  // shape — and control-api forwards that body verbatim. This wrapper's contract
  // (and OwnedEntries, which reads response.data) expects { data: [...] }, so
  // tolerate either key and ALWAYS return a { data } array. Without this the
  // component does setEntries(undefined) and crashes on `entries.length`.
  // Owned-entry fields (name/version/visibility/status) are naming-neutral and
  // entry_type is not rendered, so no per-item normalization is needed here.
  const raw = (await apiGet('/api/v1/admin/registry/owned-entries')) as {
    data?: OwnedRegistryEntry[]
    entries?: OwnedRegistryEntry[]
    meta?: { total: number }
  }
  return { data: raw?.data ?? raw?.entries ?? [], meta: raw?.meta }
}

export async function listOrgGrants(pluginName?: string): Promise<{ grants: OrgGrant[] }> {
  const raw = (await apiGet('/api/v1/admin/registry/grants', { pluginName })) as {
    grants?: RawOrgGrant[]
  }
  return { grants: (raw?.grants ?? []).map(normalizeOrgGrant) }
}

export async function createOrgGrant(input: CreateOrgGrantInput): Promise<OrgGrant> {
  const raw = (await registryCodedRequest('POST', '/api/v1/admin/registry/grants', input)) as
    | RawOrgGrant
    | undefined
  return normalizeOrgGrant(raw ?? {})
}

export async function revokeOrgGrant(id: string): Promise<void> {
  await registryCodedRequest('DELETE', `/api/v1/admin/registry/grants/${encodeURIComponent(id)}`)
}

export async function listGrantedToMe(): Promise<{ grants: GrantedToMeItem[] }> {
  const raw = (await apiGet('/api/v1/admin/registry/granted-to-me')) as {
    grants?: RawGrantedToMeItem[]
  }
  return { grants: (raw?.grants ?? []).map(normalizeGrantedToMeItem) }
}

export type UpdateRegistryEntryFields = {
  description?: string
  tags?: string[]
  visibility?: string
  mcpServer?: {
    egressSummary?: { domains?: string[]; ports?: number[]; wideCidr?: boolean } | null
  }
}

export async function updateRegistryEntry(
  name: string,
  version: string,
  fields: UpdateRegistryEntryFields
): Promise<RegistryEntry> {
  const entry = (await apiSend(
    'PUT',
    `/api/v1/admin/registry/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    fields
  )) as RegistryEntry
  return normalizeRegistryEntry(entry)
}

export async function deleteRegistryEntry(
  name: string,
  version: string
): Promise<{ deleted: boolean }> {
  return apiSend(
    'DELETE',
    `/api/v1/admin/registry/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
  ) as Promise<{ deleted: boolean }>
}

// ─── Per-Host env vars ─────────────────────────────────────────────────────

export type HostEnvEntry = {
  key: string
  secret: boolean
  updatedAt?: string
}

export type HostEnvWriteEntry = {
  key: string
  value: string
  secret: boolean
}

export type HostEnvWriteResult = {
  keys: HostEnvEntry[]
  /** Plaintext echo for secrets created/updated in this PUT only. */
  showOnce: Record<string, string>
}

export async function listHostEnv(hostRef: string): Promise<{ items: HostEnvEntry[] }> {
  return apiGet(`/api/v1/admin/hosts/${encodeURIComponent(hostRef)}/env`) as Promise<{
    items: HostEnvEntry[]
  }>
}

export async function putHostEnv(
  hostRef: string,
  entries: HostEnvWriteEntry[]
): Promise<HostEnvWriteResult> {
  return apiSend(
    'PUT',
    `/api/v1/admin/hosts/${encodeURIComponent(hostRef)}/env`,
    entries
  ) as Promise<HostEnvWriteResult>
}

export async function deleteHostEnvKey(hostRef: string, key: string): Promise<void> {
  // Direct fetch (not apiSend): 204 No Content has no JSON body.
  const path = `/api/v1/admin/hosts/${encodeURIComponent(hostRef)}/env/${encodeURIComponent(key)}`
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  })
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 401) {
      handleUnauthorized()
    }
    throw new Error(`${res.status} ${res.statusText} - ${text}`)
  }
}

// ─── Usage tracking ───────────────────────────────────────────────────────

export type UsageInterval = '5min' | 'hour' | 'day'

export type UsageGroupBy =
  | 'model'
  | 'provider'
  | 'host_ref'
  | 'team_id'
  | 'recipe_name'
  | 'llm_secret_name'
  | 'user_id'
  | 'sender'
  | 'channel_type'
  | 'source_kind'

export type UsageFilters = Partial<Record<UsageGroupBy, string[]>>

export type UsageSeriesRow = {
  bucket: string
  group: string | null
  input_tokens: number
  output_tokens: number
  total_tokens: number
  request_count: number
}

export type UsageTotalsRow = {
  group: string | null
  input_tokens: number
  output_tokens: number
  total_tokens: number
  request_count: number
}

export type UsageSeriesResponse = {
  from: string
  to: string
  interval: UsageInterval
  groupBy: UsageGroupBy
  rows: UsageSeriesRow[]
}

export type UsageTotalsResponse = {
  from: string
  to: string
  interval: UsageInterval
  groupBy: UsageGroupBy
  rows: UsageTotalsRow[]
}

function buildUsageQuery(params: {
  from: string
  to: string
  interval: UsageInterval
  groupBy: UsageGroupBy
  filters?: UsageFilters
  limit?: number
}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    from: params.from,
    to: params.to,
    interval: params.interval,
    groupBy: params.groupBy,
  }
  if (params.filters && Object.keys(params.filters).length > 0) {
    out.filters = JSON.stringify(params.filters)
  }
  if (params.limit !== undefined) out.limit = String(params.limit)
  return out
}

export async function fetchUsageSeries(params: {
  from: string
  to: string
  interval: UsageInterval
  groupBy: UsageGroupBy
  filters?: UsageFilters
}): Promise<UsageSeriesResponse> {
  return apiGet('/api/v1/admin/usage/llm', buildUsageQuery(params)) as Promise<UsageSeriesResponse>
}

export async function fetchUsageTotals(params: {
  from: string
  to: string
  interval: UsageInterval
  groupBy: UsageGroupBy
  filters?: UsageFilters
  limit?: number
}): Promise<UsageTotalsResponse> {
  return apiGet(
    '/api/v1/admin/usage/llm/totals',
    buildUsageQuery(params)
  ) as Promise<UsageTotalsResponse>
}

// ─── Plugin Workload SDK (admin) ────────────────────────────────────────

export type PluginWorkloadSdkFamily = 'promptBridge' | 'clientNotifications'

export type PluginWorkloadSdkModelPolicy = {
  provider: string
  model: string
  temperature?: number
  maxCostUsd?: number
}

export type PluginWorkloadSdkPromptTarget = {
  targetRef: string
  provider: string
  model: string
  // Identity of a provider-owned secret data key; never a secret value.
  credentialSlot: string
}

export type PluginWorkloadSdkQuotaLimits = {
  maxRequestsPerRun?: number
  maxNotificationsPerRun?: number
  maxInvocationsPerMinute?: number
  maxNotificationsPerMinute?: number
  maxOutputTokens?: number
}

export type PluginWorkloadSdkGrant = {
  id: string
  recipeNamespace: string
  recipeName: string
  capabilityFamily: PluginWorkloadSdkFamily
  // Explicit provider bound to a promptBridge grant (R1). `null` for older
  // grants written before the column existed (and for clientNotifications).
  // Null promptBridge grants are legacy/unreviewed; the editor must require an
  // explicit operator resave and never infer a routable provider from models.
  provider: string | null
  allowedModels: string[]
  allowedEventTypes: string[]
  allowedTargetRefs: string[]
  allowedUserRefs: string[]
  allowedCallers: string[]
  quotaLimits: PluginWorkloadSdkQuotaLimits
  modelPolicies: Record<string, PluginWorkloadSdkModelPolicy>
  promptTargets: PluginWorkloadSdkPromptTarget[]
  defaultTargetRef: string | null
  policyState: 'active' | 'legacy_unreviewed' | 'revoking' | 'disabled'
  revocationId: string | null
  policyRevision: number
  createdAt: string
  updatedAt: string
}

export type PluginWorkloadSdkLegacyGrantInventoryItem = {
  id: string
  recipeNamespace: string
  recipeName: string
  policyState: string
  policyRevision: number
  providerPresent: boolean
  promptTargetsCount: number
  defaultTargetRefPresent: boolean
  reasons: string[]
}

export type PluginWorkloadSdkLegacyGrantInventory = {
  totalPromptBridgeGrants: number
  legacyPromptBridgeGrants: number
  activationReady: boolean
  items: PluginWorkloadSdkLegacyGrantInventoryItem[]
}

export type PluginWorkloadSdkGrantInput = {
  recipeNamespace: string
  recipeName: string
  capabilityFamily: PluginWorkloadSdkFamily
  // Required for promptBridge grants; omitted for clientNotifications.
  provider?: string
  allowedModels?: string[]
  allowedEventTypes?: string[]
  allowedTargetRefs?: string[]
  allowedUserRefs?: string[]
  allowedCallers?: string[]
  quotaLimits?: PluginWorkloadSdkQuotaLimits
  modelPolicies?: Record<string, PluginWorkloadSdkModelPolicy>
  promptTargets?: PluginWorkloadSdkPromptTarget[]
  defaultTargetRef?: string
}

export type PluginWorkloadSdkQuotaCounter = {
  recipeNamespace: string
  recipeName: string
  periodStart: string
  promptBridgeCount: number
  notificationCount: number
  lastUpdated: string
}

export type PluginWorkloadSdkInvocationStatus =
  | 'in_progress'
  | 'complete'
  | 'failed'
  | 'provider_unavailable'
  | 'accepted'
  | 'delivered'

export type PluginWorkloadSdkInvocation = {
  id: string
  recipeNamespace: string
  recipeName: string
  callerRef: string
  correlationId: string | null
  method: PluginWorkloadSdkFamily
  detail: string
  purpose: string | null
  status: PluginWorkloadSdkInvocationStatus
  quotaConsumed: boolean
  authorizationDecision: string
  createdAt: string
  completedAt: string | null
}

export async function listPluginWorkloadSdkGrants(filter?: {
  recipeNamespace?: string
  recipeName?: string
}): Promise<{ items?: PluginWorkloadSdkGrant[] }> {
  return apiGet('/api/v1/admin/plugin-workload-sdk/grants', {
    recipeNamespace: filter?.recipeNamespace,
    recipeName: filter?.recipeName,
  }) as Promise<{ items?: PluginWorkloadSdkGrant[] }>
}

export async function getPluginWorkloadSdkLegacyInventory(filter?: {
  recipeNamespace?: string
  recipeName?: string
}): Promise<PluginWorkloadSdkLegacyGrantInventory> {
  return apiGet('/api/v1/admin/plugin-workload-sdk/legacy-inventory', {
    recipeNamespace: filter?.recipeNamespace,
    recipeName: filter?.recipeName,
  }) as Promise<PluginWorkloadSdkLegacyGrantInventory>
}

export async function upsertPluginWorkloadSdkGrant(
  grant: PluginWorkloadSdkGrantInput
): Promise<{ grant: PluginWorkloadSdkGrant }> {
  return apiSend('POST', '/api/v1/admin/plugin-workload-sdk/grants', grant) as Promise<{
    grant: PluginWorkloadSdkGrant
  }>
}

export async function deletePluginWorkloadSdkGrant(
  id: string,
  recipeNamespace: string,
  recipeName: string
): Promise<{ deleted: boolean }> {
  return apiSend(
    'DELETE',
    `/api/v1/admin/plugin-workload-sdk/grants/${encodeURIComponent(id)}`,
    undefined,
    { recipeNamespace, recipeName }
  ) as Promise<{ deleted: boolean }>
}

export async function getPluginWorkloadSdkQuota(
  recipeNamespace: string,
  recipeName: string
): Promise<{ items?: PluginWorkloadSdkQuotaCounter[] }> {
  return apiGet(
    `/api/v1/admin/plugin-workload-sdk/quota/${encodeURIComponent(recipeNamespace)}/${encodeURIComponent(recipeName)}`
  ) as Promise<{ items?: PluginWorkloadSdkQuotaCounter[] }>
}

export async function searchPluginWorkloadSdkInvocations(filter?: {
  recipeNamespace?: string
  recipeName?: string
  method?: string
  status?: string
  limit?: string
}): Promise<{ items?: PluginWorkloadSdkInvocation[] }> {
  return apiGet('/api/v1/admin/plugin-workload-sdk/invocations', {
    recipeNamespace: filter?.recipeNamespace,
    recipeName: filter?.recipeName,
    method: filter?.method,
    status: filter?.status,
    limit: filter?.limit,
  }) as Promise<{ items?: PluginWorkloadSdkInvocation[] }>
}

// ─── Org-scoped registry publish API keys (efrk_) ─────────────────────────

export type RegistryApiKey = {
  id: string
  key_prefix: string
  description: string | null
  scopes: string[]
  created_by_username: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
}
export type CreatedRegistryApiKey = {
  id: string
  key: string
  key_prefix: string
  scopes: string[]
  expires_at: string | null
  // Additive push-credential fields — present only when the minted key carries
  // registry:publish (parallel control-api/registry session). Absent pre-wiring.
  // (username is fixed to "_" by the registry, so the UI hardcodes it rather
  // than reading it back.)
  dockerconfigjson?: string
  registry?: string
}
export type CreateRegistryApiKeyInput = {
  description?: string
  scopes?: string[]
  expiresInDays?: number
}

// Dedicated wrapper: unlike apiGet (discards body) and apiSend (friendly-remaps),
// these routes need the machine-readable error CODE for the panel's state machine.
async function registryCodedRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let code = ''
    let org: string | undefined
    try {
      const parsed = (await res.json()) as { error?: string; org?: string }
      code = parsed?.error ?? ''
      org = parsed?.org
    } catch {
      /* no body */
    }
    // A 401 is a genuine session-expiry (→ force re-auth) UNLESS it carries the
    // connect-claim endpoint's `claim_rejected` overload: control-api maps the
    // registry's invalid_pop / invalid_claim_token to 401 { error:'claim_rejected' }
    // so the operator sees an inline "token was rejected" message instead of being
    // bounced to login. Every other 401 (Unauthorized / unauthorized) means the
    // session is gone. (Registry keys 401 → 502 server-side, so never reaches here.)
    if (res.status === 401 && code !== 'claim_rejected') handleUnauthorized()
    const error = new Error(`${res.status} ${code || res.statusText}`) as Error & {
      status?: number
      code?: string
      org?: string
    }
    error.status = res.status
    error.code = code
    if (org !== undefined) error.org = org
    throw error
  }
  if (res.status === 204) return undefined
  return parseJsonResponse(res)
}

export async function listRegistryApiKeys(): Promise<{ org: string; keys: RegistryApiKey[] }> {
  return registryCodedRequest('GET', '/api/v1/admin/registry/keys') as Promise<{
    org: string
    keys: RegistryApiKey[]
  }>
}
export async function createRegistryApiKey(
  body: CreateRegistryApiKeyInput
): Promise<CreatedRegistryApiKey> {
  return registryCodedRequest(
    'POST',
    '/api/v1/admin/registry/keys',
    body
  ) as Promise<CreatedRegistryApiKey>
}
export async function revokeRegistryApiKey(id: string): Promise<void> {
  await registryCodedRequest('DELETE', `/api/v1/admin/registry/keys/${encodeURIComponent(id)}`)
}

// ─── Org container images (real repos + tags from the registry) ────────────
export type OrgImage = {
  name: string
  visibility: string
  createdAt: string
  tags: string[]
}
export async function listOrgImages(): Promise<{ org: string; images: OrgImage[] }> {
  const raw = (await registryCodedRequest('GET', '/api/v1/admin/registry/images')) as {
    org?: string
    images?: OrgImage[]
  }
  return { org: raw?.org ?? '', images: raw?.images ?? [] }
}

// ─── Self-hosted registry connect flow (spec §6.1/§6.3) ───────────────────────
// Drives control-api's /api/v1/admin/registry/connect endpoints
// (control-api/src/routes/admin/registryConnect.ts). GET is READ-ONLY and polls
// the registry status endpoint, so state ∈ disconnected | pending | connecting |
// approved | rejected | connected — the panel renders one view per state.
//
// `connecting` means the registry AUTO-APPROVED (open registration) and the
// inline claim has not completed. It is finished by recoverRegistryConnection(),
// never by pasting a token — under auto-approval no operator ever sees one.
// `approved` keeps its original meaning: an operator approved and a human must
// paste the token they were given out of band.
//
// GET fields by state: connected → { deploymentId, org, authEnabled };
// connecting → { deploymentId, requestedOrgName, authEnabled, recoveryError? };
// pending/approved/rejected → { deploymentId, requestedOrgName };
// disconnected → {}. There is NO rejection_reason in the contract.
//
// Uses registryCodedRequest so callers can branch on err.code: not_self_hosted,
// already_connected, recovery_in_progress, not_pending, not_recoverable,
// org_name_taken, registration_capacity, rate_limited, invalid_contact_email,
// org_blocklisted, claim_expired, claim_rejected, already_claimed,
// deployment_suspended, client_unavailable, connection_superseded.

export type RegistryConnectionState =
  | 'disconnected'
  | 'pending'
  | 'connecting'
  | 'approved'
  | 'rejected'
  | 'connected'

export type RegistryRecoveryError =
  | 'already_claimed'
  | 'deployment_suspended'
  | 'client_unavailable'
  | 'connection_superseded'
  | 'claim_expired'

export type RegistryConnectionStatus = {
  state: RegistryConnectionState
  deploymentId?: string
  requestedOrgName?: string
  org?: string
  authEnabled?: boolean
  recoveryError?: RegistryRecoveryError
}

export async function getRegistryConnection(): Promise<RegistryConnectionStatus> {
  return registryCodedRequest(
    'GET',
    '/api/v1/admin/registry/connect'
  ) as Promise<RegistryConnectionStatus>
}

export async function requestRegistryConnection(input: {
  requestedOrgName: string
  contactEmail: string
}): Promise<RegistryConnectionStatus> {
  return registryCodedRequest('POST', '/api/v1/admin/registry/connect/request', {
    requested_org_name: input.requestedOrgName,
    contact_email: input.contactEmail,
  }) as Promise<RegistryConnectionStatus>
}

export async function submitRegistryClaim(input: {
  claimToken: string
}): Promise<{ state: 'connected'; org: string }> {
  return registryCodedRequest('POST', '/api/v1/admin/registry/connect/claim', {
    claim_token: input.claimToken,
  }) as Promise<{ state: 'connected'; org: string }>
}

export async function disconnectRegistryConnection(): Promise<void> {
  await registryCodedRequest('DELETE', '/api/v1/admin/registry/connect')
}

export async function recoverRegistryConnection(): Promise<RegistryConnectionStatus> {
  return registryCodedRequest(
    'POST',
    '/api/v1/admin/registry/connect/recover'
  ) as Promise<RegistryConnectionStatus>
}
