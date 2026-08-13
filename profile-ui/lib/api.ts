'use client'

import {
  EVENFIRE_RELEASES_URL,
  EXTERNAL_REST_API_BASE_URL,
  EXTERNAL_SESSION_TOKEN_EXPIRES_AT_KEY,
  EXTERNAL_SESSION_TOKEN_KEY,
} from '../app/constants/api'
import type {
  AcceptInvitationResponse,
  DesktopAuthorizationResponse,
  DesktopEnvironmentResponse,
  DesktopReleaseResponse,
  InvitationPreview,
  PasswordLoginResponse,
} from '../app/types/api'
import type {
  Channels,
  ManageableTeam,
  ManagedMember,
  ManagedPendingInvitation,
  Me,
  NotificationPreferences,
  ProfileUpdateResponse,
  Role,
  UpdateNotificationPreferencesInput,
} from '../app/types/profile'

export type { InvitationPreview } from '../app/types/api'

let globalHandleAuthError: (() => void) | null = null

type ApiRequestOptions = {
  silentUnauthorized?: boolean
}

export class AuthExpiredError extends Error {
  silent = true
  status = 401

  constructor() {
    super('Session expired')
    this.name = 'AuthExpiredError'
  }
}

export function setGlobalAuthErrorHandler(handler: () => void): void {
  globalHandleAuthError = handler
}

export function isSilentApiError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { silent?: unknown }).silent)
}

function query(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') s.set(k, v)
  })
  const value = s.toString()
  return value ? `?${value}` : ''
}

function handleUnauthorized(): never {
  clearToken()
  globalHandleAuthError?.()
  throw new AuthExpiredError()
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

export function clearToken(): void {
  if (typeof window === 'undefined') return
  // Clear legacy browser-readable storage for users upgrading from the old
  // token flow. The active profile session is now an HttpOnly cookie.
  window.localStorage.removeItem(EXTERNAL_SESSION_TOKEN_KEY)
  window.localStorage.removeItem(EXTERNAL_SESSION_TOKEN_EXPIRES_AT_KEY)
  document.cookie = `${EXTERNAL_SESSION_TOKEN_KEY}=; path=/; max-age=0; SameSite=Lax`
}

export async function apiGet(
  path: string,
  q: Record<string, string | undefined> = {},
  options: ApiRequestOptions = {}
) {
  const res = await fetch(`${EXTERNAL_REST_API_BASE_URL}${path}${query(q)}`, {
    cache: 'no-store',
    credentials: 'include',
  })
  if (!res.ok) {
    if (res.status === 401) {
      if (options.silentUnauthorized) {
        clearToken()
        throw new AuthExpiredError()
      }
      handleUnauthorized()
    }
    throw new Error(`${res.status} ${res.statusText}`)
  }
  return parseJsonResponse(res)
}

export async function apiSend(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  q: Record<string, string | undefined> = {}
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const res = await fetch(`${EXTERNAL_REST_API_BASE_URL}${path}${query(q)}`, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 401) handleUnauthorized()
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
      detail = String(parsed.message || parsed.error || text)
    } catch {
      detail = text
    }
    // Substring match is REQUIRED here (not === like control-ui): profile-ui reaches
    // control-api through external-rest-api, whose error middleware collapses any 5xx
    // into { message: "Control API ... failed (503): <code>" }, so the code arrives
    // embedded in a wrapper string rather than as the bare { error: '<code>' } body.
    if (detail.includes('member_registration_unavailable')) {
      throw new Error(
        "Invitations are unavailable — the member-registration service isn't configured or can't be reached. Check the server logs for details."
      )
    }
    if (detail.includes('member_registration_misconfigured')) {
      throw new Error(
        'Invitations are unavailable — member registration is misconfigured. Check the server logs for details.'
      )
    }
    throw new Error(`${res.status} ${res.statusText} - ${detail}`)
  }
  if (res.status === 204) {
    return null
  }
  return parseJsonResponse(res)
}

export async function loginWithPassword(
  email: string,
  password: string
): Promise<PasswordLoginResponse> {
  const res = await fetch(`${EXTERNAL_REST_API_BASE_URL}/api/v1/auth/password-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
      detail = String(parsed.message || parsed.error || text)
    } catch {
      detail = text
    }
    throw new Error(`${res.status} ${res.statusText} - ${detail}`)
  }
  clearToken()
  return (await res.json()) as PasswordLoginResponse
}

export async function logoutProfileUI(): Promise<void> {
  try {
    await fetch(`${EXTERNAL_REST_API_BASE_URL}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } finally {
    clearToken()
  }
}

export async function requestPasswordReset(email: string): Promise<{ requested: true }> {
  const res = await fetch(`${EXTERNAL_REST_API_BASE_URL}/api/v1/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<{ requested: true }>
}

export async function getInvitation(invitationUrlId: string): Promise<InvitationPreview> {
  return apiGet(
    `/api/v1/invitations/token/${encodeURIComponent(invitationUrlId)}`
  ) as Promise<InvitationPreview>
}

export async function acceptInvitation(
  invitationUrlId: string,
  email: string
): Promise<AcceptInvitationResponse> {
  const response = (await apiSend('POST', '/api/v1/invitations/accept', {
    token: invitationUrlId,
    email,
  })) as AcceptInvitationResponse
  clearToken()
  return response
}

export async function setupInvitationPassword(
  invitationId: string,
  password: string
): Promise<InvitationPreview & { passwordUpdated: boolean }> {
  return apiSend('POST', '/api/v1/invitations/password', { invitationId, password }) as Promise<
    InvitationPreview & { passwordUpdated: boolean }
  >
}

export async function setupInvitationPasswordWithToken(
  invitationUrlId: string,
  email: string,
  invitationId: string,
  password: string
): Promise<InvitationPreview & { passwordUpdated: boolean }> {
  const response = (await apiSend('POST', '/api/v1/invitations/password', {
    token: invitationUrlId,
    email,
    invitationId,
    password,
  })) as InvitationPreview & { passwordUpdated: boolean }
  clearToken()
  return response
}

export async function getMe(options: ApiRequestOptions = {}): Promise<Me> {
  return apiGet('/api/v1/me', {}, options) as Promise<Me>
}

export async function updateProfile(
  displayName: string,
  channels: Channels
): Promise<ProfileUpdateResponse> {
  return apiSend('PUT', '/api/v1/me/profile', {
    displayName,
    channels,
  }) as Promise<ProfileUpdateResponse>
}

export async function updatePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ updated: true }> {
  return apiSend('PUT', '/api/v1/me/password', {
    currentPassword,
    newPassword,
  }) as Promise<{ updated: true }>
}

export async function getManageableTeams(): Promise<{ items?: ManageableTeam[] }> {
  return apiGet('/api/v1/members/manageable-teams') as Promise<{ items?: ManageableTeam[] }>
}

export async function getManagedMembers(): Promise<{ items?: ManagedMember[] }> {
  return apiGet('/api/v1/members') as Promise<{ items?: ManagedMember[] }>
}

export async function getManagedMember(userId: string): Promise<ManagedMember> {
  return apiGet(`/api/v1/members/${encodeURIComponent(userId)}`) as Promise<ManagedMember>
}

export async function getManagedInvitations(): Promise<{ items?: ManagedPendingInvitation[] }> {
  return apiGet('/api/v1/members/invitations') as Promise<{ items?: ManagedPendingInvitation[] }>
}

export async function inviteManagedMember(
  email: string,
  name: string,
  teams: Array<{ teamId: string; role: Role }>
) {
  return apiSend('POST', '/api/v1/members/invite', { email, name, teams })
}

export async function updateManagedMemberRole(userId: string, teamId: string, role: Role) {
  return apiSend(
    'PATCH',
    `/api/v1/members/${encodeURIComponent(userId)}/teams/${encodeURIComponent(teamId)}/role`,
    { role }
  )
}

export async function deleteManagedMember(userId: string, teamId: string) {
  return apiSend(
    'DELETE',
    `/api/v1/members/${encodeURIComponent(userId)}/teams/${encodeURIComponent(teamId)}`
  )
}

export async function deleteManagedUser(userId: string) {
  return apiSend('DELETE', `/api/v1/members/${encodeURIComponent(userId)}`)
}

export async function resendManagedInvitation(invitationId: string) {
  return apiSend('POST', `/api/v1/members/invitations/${encodeURIComponent(invitationId)}/resend`)
}

export async function cancelManagedInvitation(invitationId: string) {
  return apiSend('DELETE', `/api/v1/members/invitations/${encodeURIComponent(invitationId)}`)
}

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  return apiGet('/api/v1/me/notification-preferences') as Promise<NotificationPreferences>
}

export async function updateNotificationPreferences(
  input: UpdateNotificationPreferencesInput
): Promise<NotificationPreferences> {
  return apiSend(
    'PUT',
    '/api/v1/me/notification-preferences',
    input
  ) as Promise<NotificationPreferences>
}

export async function createDesktopAuthorization(
  password: string
): Promise<DesktopAuthorizationResponse> {
  return apiSend('POST', '/api/v1/invitations/desktop-authorization', {
    password,
  }) as Promise<DesktopAuthorizationResponse>
}

export async function getDesktopEnvironment(): Promise<DesktopEnvironmentResponse> {
  return apiGet('/api/v1/desktop/environment') as Promise<DesktopEnvironmentResponse>
}

// silentUnauthorized on purpose: the release identity only feeds a label, so a
// 401 here must not run the global auth handler and bounce the user to login.
// The page's own getMe() call owns that decision.
export async function getDesktopRelease(): Promise<DesktopReleaseResponse> {
  return apiGet(
    '/api/v1/desktop/release',
    {},
    { silentUnauthorized: true }
  ) as Promise<DesktopReleaseResponse>
}

export function getConfiguredExternalRestApiBaseUrl(): string {
  if (typeof window === 'undefined') return EXTERNAL_REST_API_BASE_URL.replace(/\/+$/, '')
  try {
    return new URL(EXTERNAL_REST_API_BASE_URL, window.location.origin)
      .toString()
      .replace(/\/+$/, '')
  } catch {
    return EXTERNAL_REST_API_BASE_URL.replace(/\/+$/, '')
  }
}

export function getEvenfireDownloadUrl(): string {
  return EVENFIRE_RELEASES_URL
}
