import { apiGet, apiSend } from './api'

export const CODEX_SUBSCRIPTION_API_BASE = '/api/v1/admin/llm/providers/codex-subscription'

export type CodexConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reauth_required'
  | 'revoked'

export type CodexCatalogStatus = 'never_synced' | 'ready' | 'auth-rejected' | 'unavailable'

export type CodexOAuthIntent = 'connect' | 'reconnect' | 'replace'

export type CodexSubscriptionConnectionView = {
  connectionKey: 'deployment-default'
  status: CodexConnectionStatus
  credentialRevision: number
  catalogRevision: number
  accountFingerprint: string | null
  catalogStatus: CodexCatalogStatus
  catalogSyncedAt: string | null
  lastRefreshAt: string | null
  lastAuthAt: string | null
  refreshLockHeld: boolean
}

export type CodexBrowserStartView = {
  authorizeUrl: string
  state: string
  intent: CodexOAuthIntent
  expiresAt: string
}

export type CodexDeviceStartView = {
  userCode: string
  verificationUri: string
  intervalSeconds: number
  state: string
  intent: CodexOAuthIntent
}

export type CodexDevicePollView =
  | { status: 'pending' | 'slow_down'; intervalSeconds: number; state: string }
  | { status: 'connected'; connection: CodexSubscriptionConnectionView }
  | { status: 'expired' | 'denied' }

export type CodexCatalogSyncView = {
  outcome: string
  added: number
  refreshed: number
  staled: number
  connection: CodexSubscriptionConnectionView
}

const FORBIDDEN_KEY =
  /accessToken|refreshToken|deviceCode|authorization|set-cookie|cookie|proxyUrl|proxyURL|accountId|rawAccount|subject/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertNoForbiddenKeys(value: unknown, path = 'root'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`Codex subscription payload leaked forbidden field "${key}" at ${path}`)
    }
    assertNoForbiddenKeys(nested, `${path}.${key}`)
  }
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function pickNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pickBool(value: unknown): boolean {
  return value === true
}

export function sanitizeCodexConnection(raw: unknown): CodexSubscriptionConnectionView {
  assertNoForbiddenKeys(raw)
  if (!isPlainObject(raw)) {
    throw new Error('Codex subscription connection is not an object')
  }
  const status = raw.status
  if (
    status !== 'disconnected' &&
    status !== 'connecting' &&
    status !== 'connected' &&
    status !== 'reauth_required' &&
    status !== 'revoked'
  ) {
    throw new Error('Codex subscription connection status is invalid')
  }
  const catalogStatus = raw.catalogStatus
  const safeCatalog: CodexCatalogStatus =
    catalogStatus === 'ready' ||
    catalogStatus === 'auth-rejected' ||
    catalogStatus === 'unavailable' ||
    catalogStatus === 'never_synced'
      ? catalogStatus
      : 'never_synced'
  return {
    connectionKey: 'deployment-default',
    status,
    credentialRevision: pickNumber(raw.credentialRevision),
    catalogRevision: pickNumber(raw.catalogRevision),
    accountFingerprint: pickString(raw.accountFingerprint),
    catalogStatus: safeCatalog,
    catalogSyncedAt: pickString(raw.catalogSyncedAt),
    lastRefreshAt: pickString(raw.lastRefreshAt),
    lastAuthAt: pickString(raw.lastAuthAt),
    refreshLockHeld: pickBool(raw.refreshLockHeld),
  }
}

export function sanitizeCodexBrowserStart(raw: unknown): CodexBrowserStartView {
  assertNoForbiddenKeys(raw)
  if (!isPlainObject(raw)) throw new Error('Codex browser start is not an object')
  const authorizeUrl = pickString(raw.authorizeUrl)
  const state = pickString(raw.state)
  const expiresAt = pickString(raw.expiresAt)
  const intent = raw.intent
  if (!authorizeUrl || !state || !expiresAt) {
    throw new Error('Codex browser start is incomplete')
  }
  if (!authorizeUrl.startsWith('https://')) {
    throw new Error('Codex browser start authorizeUrl must be https')
  }
  return {
    authorizeUrl,
    state,
    intent: intent === 'reconnect' || intent === 'replace' ? intent : 'connect',
    expiresAt,
  }
}

export function sanitizeCodexDeviceStart(raw: unknown): CodexDeviceStartView {
  assertNoForbiddenKeys(raw)
  if (!isPlainObject(raw)) throw new Error('Codex device start is not an object')
  const userCode = pickString(raw.userCode)
  const verificationUri = pickString(raw.verificationUri)
  const state = pickString(raw.state)
  const intent = raw.intent
  if (!userCode || !verificationUri || !state) {
    throw new Error('Codex device start is incomplete')
  }
  return {
    userCode,
    verificationUri,
    intervalSeconds: Math.max(1, pickNumber(raw.intervalSeconds, 5)),
    state,
    intent: intent === 'reconnect' || intent === 'replace' ? intent : 'connect',
  }
}

export function sanitizeCodexDevicePoll(raw: unknown): CodexDevicePollView {
  assertNoForbiddenKeys(raw)
  if (!isPlainObject(raw)) throw new Error('Codex device poll is not an object')
  if (raw.status === 'connected') {
    return { status: 'connected', connection: sanitizeCodexConnection(raw.connection) }
  }
  if (raw.status === 'expired' || raw.status === 'denied') {
    return { status: raw.status }
  }
  if (raw.status === 'pending' || raw.status === 'slow_down') {
    return {
      status: raw.status,
      intervalSeconds: Math.max(1, pickNumber(raw.intervalSeconds, 5)),
      state: pickString(raw.state) ?? '',
    }
  }
  throw new Error('Codex device poll status is invalid')
}

export function sanitizeCodexCatalogSync(raw: unknown): CodexCatalogSyncView {
  assertNoForbiddenKeys(raw)
  if (!isPlainObject(raw)) throw new Error('Codex catalog sync is not an object')
  return {
    outcome: pickString(raw.outcome) ?? 'unknown',
    added: pickNumber(raw.added),
    refreshed: pickNumber(raw.refreshed),
    staled: pickNumber(raw.staled),
    connection: sanitizeCodexConnection(raw.connection),
  }
}

export async function getCodexSubscriptionConnection(): Promise<CodexSubscriptionConnectionView> {
  return sanitizeCodexConnection(await apiGet(`${CODEX_SUBSCRIPTION_API_BASE}/connection`))
}

export async function startCodexBrowserConnect(
  intent: CodexOAuthIntent
): Promise<CodexBrowserStartView> {
  return sanitizeCodexBrowserStart(
    await apiSend('POST', `${CODEX_SUBSCRIPTION_API_BASE}/browser/start`, { intent })
  )
}

export async function startCodexDeviceConnect(
  intent: CodexOAuthIntent
): Promise<CodexDeviceStartView> {
  return sanitizeCodexDeviceStart(
    await apiSend('POST', `${CODEX_SUBSCRIPTION_API_BASE}/device/start`, { intent })
  )
}

export async function pollCodexDevice(state: string): Promise<CodexDevicePollView> {
  return sanitizeCodexDevicePoll(
    await apiGet(`${CODEX_SUBSCRIPTION_API_BASE}/device/poll`, { state })
  )
}

export async function refreshCodexSubscriptionConnection(): Promise<CodexSubscriptionConnectionView> {
  return sanitizeCodexConnection(await apiSend('POST', `${CODEX_SUBSCRIPTION_API_BASE}/refresh`))
}

export async function syncCodexSubscriptionCatalog(): Promise<CodexCatalogSyncView> {
  return sanitizeCodexCatalogSync(
    await apiSend('POST', `${CODEX_SUBSCRIPTION_API_BASE}/catalog/sync`)
  )
}

export async function revokeCodexSubscription(): Promise<CodexSubscriptionConnectionView> {
  return sanitizeCodexConnection(await apiSend('POST', `${CODEX_SUBSCRIPTION_API_BASE}/revoke`))
}
