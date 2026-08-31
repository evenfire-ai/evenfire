import { apiGet, apiSend } from './api'

export const CODEX_SUBSCRIPTION_API_BASE = '/api/v1/admin/llm/providers/codex-subscription'

/** Canonical ChatGPT device verification page. Reject any other href from device/start. */
export const CODEX_DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device'

export type CodexConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'reauth_required' | 'revoked'

export type CodexCatalogStatus = 'never_synced' | 'ready' | 'auth-rejected' | 'unavailable'

export type CodexOAuthIntent = 'connect' | 'reconnect' | 'replace'

export type CodexAssignedHost = { name: string }

export type CodexAssignableHost = {
  name: string
  connectionRef: string
  displayName?: string
  provider?: string
  model?: string
}

export const CODEX_UNASSIGNED_CONNECTION_KEY = 'unassigned'

/** Recipe grant identity. Recipes have no CRD `connectionRef` field. */
export const CODEX_CONNECTION_REF_ANNOTATION = 'clerum.io/codex-connection-ref'

export function isAssignableCodexGrant(
  row: Pick<CodexSubscriptionConnectionView, 'status' | 'catalogStatus'>
): boolean {
  return row.status === 'connected' && row.catalogStatus === 'ready'
}

export type CodexSubscriptionConnectionView = {
  id?: string
  connectionKey: string
  displayName?: string
  defaultModel?: string | null
  status: CodexConnectionStatus
  credentialRevision: number
  catalogRevision: number
  accountFingerprint: string | null
  catalogStatus: CodexCatalogStatus
  catalogSyncedAt: string | null
  lastRefreshAt: string | null
  lastAuthAt: string | null
  refreshLockHeld: boolean
  assignedHosts?: CodexAssignedHost[]
  assignedHostsUnavailable?: boolean
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
  connection: CodexSubscriptionConnectionView | null
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
  const connectionKey = typeof raw.connectionKey === 'string' ? raw.connectionKey.trim() : ''
  if (!connectionKey || connectionKey === CODEX_UNASSIGNED_CONNECTION_KEY) {
    throw new Error('Codex subscription connection key is invalid')
  }
  return {
    connectionKey,
    displayName: pickString(raw.displayName) ?? undefined,
    defaultModel: pickString(raw.defaultModel),
    assignedHosts: Array.isArray(raw.assignedHosts)
      ? raw.assignedHosts
          .filter(
            (entry): entry is { name: string } =>
              Boolean(entry) && typeof (entry as { name?: unknown }).name === 'string'
          )
          .map(entry => ({ name: entry.name }))
      : undefined,
    assignedHostsUnavailable: raw.assignedHostsUnavailable === true,
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
  if (verificationUri !== CODEX_DEVICE_VERIFICATION_URI) {
    throw new Error('Codex device start verification URI is not allowed')
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
    connection: raw.connection == null ? null : sanitizeCodexConnection(raw.connection),
  }
}

function sanitizeAssignableHost(raw: unknown): CodexAssignableHost | null {
  if (!isPlainObject(raw)) return null
  const name = pickString(raw.name)
  const connectionRef = pickString(raw.connectionRef)
  if (!name || !connectionRef) return null
  const provider = pickString(raw.provider)
  const model = pickString(raw.model)
  return {
    name,
    connectionRef,
    displayName: pickString(raw.displayName) ?? name,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  }
}

export async function listCodexSubscriptionConnections(): Promise<
  CodexSubscriptionConnectionView[]
> {
  const fleet = await listCodexSubscriptionFleet()
  return fleet.connections
}

export async function listCodexSubscriptionFleet(): Promise<{
  connections: CodexSubscriptionConnectionView[]
  assignableHosts: CodexAssignableHost[]
  assignableHostsUnavailable: boolean
}> {
  const raw = (await apiGet(`${CODEX_SUBSCRIPTION_API_BASE}/connections`)) as {
    connections?: unknown
    assignableHosts?: unknown
    assignableHostsUnavailable?: unknown
  }
  const connections = Array.isArray(raw.connections)
    ? raw.connections.map(sanitizeCodexConnection)
    : []
  return {
    connections,
    assignableHosts: Array.isArray(raw.assignableHosts)
      ? raw.assignableHosts
          .map(sanitizeAssignableHost)
          .filter((row): row is CodexAssignableHost => Boolean(row))
      : [],
    assignableHostsUnavailable:
      raw.assignableHostsUnavailable === true ||
      connections.some(row => row.assignedHostsUnavailable === true),
  }
}

export async function createCodexSubscriptionConnection(input: {
  displayName: string
  connectionKey?: string
}): Promise<CodexSubscriptionConnectionView> {
  return sanitizeCodexConnection(
    await apiSend('POST', `${CODEX_SUBSCRIPTION_API_BASE}/connections`, input)
  )
}

export async function listCodexConnectionModels(
  connectionKey: string
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }>> {
  const raw = (await apiGet(
    `${CODEX_SUBSCRIPTION_API_BASE}/connections/${encodeURIComponent(connectionKey)}/models`
  )) as { models?: Array<{ model?: string; enabled?: boolean; stale?: boolean }> }
  return Array.isArray(raw.models)
    ? raw.models
        .filter(row => typeof row.model === 'string' && row.model.trim())
        .map(row => ({
          model: String(row.model),
          enabled: row.enabled === true,
          stale: row.stale === true,
        }))
    : []
}

export async function getCodexSubscriptionConnection(
  connectionKey?: string
): Promise<CodexSubscriptionConnectionView> {
  const path = connectionKey
    ? `${CODEX_SUBSCRIPTION_API_BASE}/connections/${encodeURIComponent(connectionKey)}`
    : `${CODEX_SUBSCRIPTION_API_BASE}/connection`
  return sanitizeCodexConnection(await apiGet(path))
}

function keyedPath(connectionKey: string | undefined, action: string): string {
  if (!connectionKey) return `${CODEX_SUBSCRIPTION_API_BASE}/${action}`
  return `${CODEX_SUBSCRIPTION_API_BASE}/connections/${encodeURIComponent(connectionKey)}/${action}`
}

export async function startCodexBrowserConnect(
  intent: CodexOAuthIntent,
  connectionKey?: string
): Promise<CodexBrowserStartView> {
  return sanitizeCodexBrowserStart(
    await apiSend('POST', keyedPath(connectionKey, 'browser/start'), { intent })
  )
}

export async function startCodexDeviceConnect(
  intent: CodexOAuthIntent,
  connectionKey?: string
): Promise<CodexDeviceStartView> {
  return sanitizeCodexDeviceStart(
    await apiSend('POST', keyedPath(connectionKey, 'device/start'), { intent })
  )
}

export async function pollCodexDevice(
  state: string,
  connectionKey?: string
): Promise<CodexDevicePollView> {
  return sanitizeCodexDevicePoll(await apiGet(keyedPath(connectionKey, 'device/poll'), { state }))
}

export async function refreshCodexSubscriptionConnection(
  connectionKey?: string
): Promise<CodexSubscriptionConnectionView> {
  return sanitizeCodexConnection(await apiSend('POST', keyedPath(connectionKey, 'refresh')))
}

export async function syncCodexSubscriptionCatalog(
  connectionKey?: string
): Promise<CodexCatalogSyncView> {
  return sanitizeCodexCatalogSync(await apiSend('POST', keyedPath(connectionKey, 'catalog/sync')))
}

export async function revokeCodexSubscription(
  connectionKey?: string
): Promise<CodexSubscriptionConnectionView> {
  return sanitizeCodexConnection(await apiSend('POST', keyedPath(connectionKey, 'revoke')))
}

export async function patchCodexSubscriptionConnection(
  connectionKey: string,
  patch: { displayName?: string; defaultModel?: string | null }
): Promise<CodexSubscriptionConnectionView> {
  return sanitizeCodexConnection(
    await apiSend(
      'PATCH',
      `${CODEX_SUBSCRIPTION_API_BASE}/connections/${encodeURIComponent(connectionKey)}`,
      patch
    )
  )
}

export async function patchCodexCatalogModel(
  connectionKey: string,
  model: string,
  enabled: boolean
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }>> {
  const raw = (await apiSend(
    'PATCH',
    `${CODEX_SUBSCRIPTION_API_BASE}/connections/${encodeURIComponent(connectionKey)}/models/${encodeURIComponent(model)}`,
    { enabled }
  )) as { models?: Array<{ model?: string; enabled?: boolean; stale?: boolean }> }
  return Array.isArray(raw.models)
    ? raw.models
        .filter(row => typeof row.model === 'string' && row.model.trim())
        .map(row => ({
          model: String(row.model),
          enabled: row.enabled === true,
          stale: row.stale === true,
        }))
    : []
}

const CODEX_OAUTH_QUERY_PARAM = 'codex_oauth'

export function readCodexOAuthQueryParam(
  searchParams: URLSearchParams | null | undefined
): string | null {
  if (!searchParams) return null
  const value = searchParams.get(CODEX_OAUTH_QUERY_PARAM)
  return value && value.trim() ? value.trim() : null
}

export function isCodexBrowserOAuthUnavailableError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'browser_oauth_unregistered'
  )
}
