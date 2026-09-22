import { apiGet, apiSend } from './api'
import {
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexAssignableHost,
  type CodexCatalogStatus,
  type CodexCatalogSyncView,
  type CodexConnectionStatus,
  type CodexDevicePollView,
  type CodexOAuthIntent,
  type CodexSubscriptionConnectionView,
  sanitizeCodexCatalogSync,
  sanitizeCodexConnection,
} from './codexSubscription'

export const GROK_SUBSCRIPTION_API_BASE = '/api/v1/admin/llm/providers/grok-subscription'
export const GROK_UNASSIGNED_CONNECTION_KEY = CODEX_UNASSIGNED_CONNECTION_KEY
export const SUBSCRIPTION_CONNECTION_REF_ANNOTATION = 'clerum.io/subscription-connection-ref'
export const GROK_DEVICE_VERIFICATION_ORIGIN = 'https://accounts.x.ai/oauth2/device'

export type GrokSubscriptionConnectionView = CodexSubscriptionConnectionView
export type GrokAssignableHost = CodexAssignableHost
export type GrokCatalogStatus = CodexCatalogStatus
export type GrokConnectionStatus = CodexConnectionStatus
export type GrokOAuthIntent = CodexOAuthIntent
export type GrokDevicePollView = CodexDevicePollView
/**
 * Narrower than the Codex view on purpose. The Grok `catalog/sync` endpoint
 * answers `{ outcome, connection }` and sends no `added`/`refreshed`/`staled`
 * counters, so `sanitizeCodexCatalogSync` fills them with zeros that mean "the
 * endpoint said nothing", not "nothing changed". Promising the fields would
 * invite a caller to render those zeros as a result.
 */
export type GrokCatalogSyncView = Omit<CodexCatalogSyncView, 'added' | 'refreshed' | 'staled'>

export type GrokDeviceStartView = {
  userCode: string
  verificationUri: string
  intervalSeconds: number
  state: string
  intent: GrokOAuthIntent
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
      throw new Error(`Grok subscription payload leaked forbidden field "${key}" at ${path}`)
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

export function isAllowedGrokVerificationUri(value: string): boolean {
  try {
    const parsed = new URL(value)
    // Exact hosts: the live xAI device page is accounts.x.ai/oauth2/device.
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'auth.x.ai' || parsed.hostname === 'accounts.x.ai')
    )
  } catch {
    return false
  }
}

export function isAssignableGrokGrant(
  row: Pick<GrokSubscriptionConnectionView, 'status' | 'catalogStatus'>
): boolean {
  return row.status === 'connected' && row.catalogStatus === 'ready'
}

function sanitizeGrokDeviceStart(raw: unknown): GrokDeviceStartView {
  assertNoForbiddenKeys(raw)
  if (!isPlainObject(raw)) throw new Error('Grok device start is not an object')
  const userCode = pickString(raw.userCode)
  const verificationUri = pickString(raw.verificationUri)
  const state = pickString(raw.state)
  const intent = raw.intent
  if (!userCode || !verificationUri || !state) {
    throw new Error('Grok device start is incomplete')
  }
  if (!isAllowedGrokVerificationUri(verificationUri)) {
    throw new Error('Grok device start verification URI is not allowed')
  }
  return {
    userCode,
    verificationUri,
    intervalSeconds: Math.max(1, pickNumber(raw.intervalSeconds, 5)),
    state,
    intent: intent === 'reconnect' || intent === 'replace' ? intent : 'connect',
  }
}

function keyedPath(connectionKey: string, action?: string): string {
  const base = `${GROK_SUBSCRIPTION_API_BASE}/connections/${encodeURIComponent(connectionKey)}`
  return action ? `${base}/${action}` : base
}

export async function listGrokSubscriptionConnections(): Promise<GrokSubscriptionConnectionView[]> {
  const raw = (await apiGet(`${GROK_SUBSCRIPTION_API_BASE}/connections`)) as {
    connections?: unknown
  }
  return Array.isArray(raw.connections) ? raw.connections.map(sanitizeCodexConnection) : []
}

export async function createGrokSubscriptionConnection(input: {
  displayName: string
  connectionKey?: string
}): Promise<GrokSubscriptionConnectionView> {
  return sanitizeCodexConnection(
    await apiSend('POST', `${GROK_SUBSCRIPTION_API_BASE}/connections`, input)
  )
}

export async function listGrokConnectionModels(
  connectionKey: string
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }>> {
  const raw = (await apiGet(`${keyedPath(connectionKey)}/models`)) as {
    models?: Array<{ model?: string; enabled?: boolean; stale?: boolean }>
  }
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

export async function startGrokDeviceConnect(
  intent: GrokOAuthIntent,
  connectionKey: string
): Promise<GrokDeviceStartView> {
  return sanitizeGrokDeviceStart(
    await apiSend('POST', keyedPath(connectionKey, 'device/start'), { intent })
  )
}

export async function pollGrokDevice(
  state: string,
  connectionKey: string
): Promise<GrokDevicePollView> {
  const raw = (await apiGet(keyedPath(connectionKey, 'device/poll'), { state })) as Record<
    string,
    unknown
  >
  assertNoForbiddenKeys(raw)
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
  throw new Error('Grok device poll status is invalid')
}

export async function syncGrokSubscriptionCatalog(
  connectionKey: string
): Promise<GrokCatalogSyncView> {
  return sanitizeCodexCatalogSync(await apiSend('POST', keyedPath(connectionKey, 'catalog/sync')))
}

export async function revokeGrokSubscription(
  connectionKey: string
): Promise<GrokSubscriptionConnectionView> {
  return sanitizeCodexConnection(await apiSend('POST', keyedPath(connectionKey, 'revoke')))
}

export async function patchGrokSubscriptionConnection(
  connectionKey: string,
  patch: { displayName?: string; defaultModel?: string | null }
): Promise<GrokSubscriptionConnectionView> {
  return sanitizeCodexConnection(await apiSend('PATCH', keyedPath(connectionKey), patch))
}

export async function patchGrokCatalogModel(
  connectionKey: string,
  model: string,
  enabled: boolean
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }>> {
  const raw = (await apiSend(
    'PATCH',
    `${keyedPath(connectionKey)}/models/${encodeURIComponent(model)}`,
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
