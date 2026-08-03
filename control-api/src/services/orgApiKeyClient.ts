import { config } from '../config.js'
import { rootLogger } from '../observability/logger.js'
import type { AdminUserRecord } from './adminAuthService.js'
import {
  isRegistryIdentityCacheGenerationCurrent,
  withCurrentRegistryIdentity,
} from './registryIdentityCache.js'
import { mintIdentityVoucher } from './registryVoucher.js'

const API_BASE = `${config.registryUrl}/api/v1`

/** Per-admin cache of the exchanged registry USER token. */
const userTokenCache = new Map<string, { generation: number; token: string }>()
const pendingUserTokenRequests = new Map<string, { generation: number; promise: Promise<string> }>()

export function __resetUserTokenCacheForTests(): void {
  userTokenCache.clear()
  pendingUserTokenRequests.clear()
}

/** Error carrying an HTTP status the route maps to a response. `.message` is a
 *  bare error code (never a raw upstream body — would risk leaking a minted key). */
export class RegistryStatusError extends Error {
  status: number
  constructor(code: string, status: number) {
    super(code)
    this.status = status
    this.name = 'RegistryStatusError'
  }
}

export interface OrgApiKey {
  id: string
  key_prefix: string
  description: string | null
  scopes: string[]
  created_by_username: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
}
export interface CreatedOrgApiKey {
  id: string
  key: string
  key_prefix: string
  scopes: string[]
  expires_at: string | null
  // Present only when the minted key carries registry:publish AND the registry
  // build supports docker push credentials (additive, per the push-credential
  // spec §2 invariant 8). Forwarded verbatim by the /admin/registry/keys POST.
  dockerconfigjson?: string
  registry?: string
  username?: string
}
export interface CreateOrgApiKeyInput {
  description?: string
  scopes?: string[]
  expiresInDays?: number
}

async function exchangeVoucher(admin: AdminUserRecord): Promise<string> {
  const voucher = await mintIdentityVoucher(admin)
  const res = await fetch(`${API_BASE}/user/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voucher }),
  })
  if (res.status === 401) {
    // invalid_voucher = signing-key mismatch or clock skew > 60s: a persistent
    // config fault, not a blip. Log loud (distinct from a gated 401) then 502.
    rootLogger.error(
      { event: 'registry_voucher_rejected', adminId: admin.id },
      'registry rejected control-api identity voucher (key mismatch or clock skew)'
    )
    throw new RegistryStatusError('registry_integration_error', 502)
  }
  if (!res.ok) {
    // Non-401 exchange failure (e.g. 409 reserved_username, 5xx). Surface it as a
    // generic 502 to the browser, but log the real status + error code so the
    // failure is diagnosable instead of an opaque "registry integration error".
    let code = ''
    try {
      code = ((await res.json()) as { error?: string })?.error ?? ''
    } catch {
      /* non-JSON body; keep code empty (never log the raw body) */
    }
    rootLogger.error(
      { event: 'registry_exchange_failed', status: res.status, code, adminId: admin.id },
      'registry voucher exchange failed (non-401)'
    )
    throw new RegistryStatusError('registry_integration_error', 502)
  }
  const json = (await res.json()) as { token: string }
  return json.token
}

async function getUserToken(admin: AdminUserRecord): Promise<string> {
  return withCurrentRegistryIdentity(
    generation => {
      const cached = userTokenCache.get(admin.id)
      if (cached?.generation === generation) return Promise.resolve(cached.token)

      const pending = pendingUserTokenRequests.get(admin.id)
      if (pending?.generation === generation) return pending.promise

      const promise = exchangeVoucher(admin)
        .then(token => {
          if (isRegistryIdentityCacheGenerationCurrent(generation)) {
            userTokenCache.set(admin.id, { generation, token })
          }
          return token
        })
        .finally(() => {
          if (pendingUserTokenRequests.get(admin.id)?.promise === promise) {
            pendingUserTokenRequests.delete(admin.id)
          }
        })
      pendingUserTokenRequests.set(admin.id, { generation, promise })
      return promise
    },
    { staleError: () => new RegistryStatusError('registry_integration_error', 502) }
  )
}

/** Parse the registry { error } body into a bare-code RegistryStatusError.
 *  Never includes the raw response text. */
async function toStatusError(res: Response): Promise<RegistryStatusError> {
  let code = 'registry_error'
  try {
    const body = (await res.json()) as { error?: string }
    if (body?.error) code = body.error
  } catch {
    /* keep generic code; never embed raw text */
  }
  return new RegistryStatusError(code, res.status)
}

/** Mirrors registryClient.authedFetch's 401-evict-retry-once, for the per-admin
 *  USER token. Inline (not shared) to avoid refactoring the stable machine path. */
async function userAuthedFetch(
  admin: AdminUserRecord,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const send = async (): Promise<Response> => {
    const token = await getUserToken(admin)
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    })
  }
  let res = await send()
  if (res.status === 401) {
    userTokenCache.delete(admin.id) // evict + re-exchange once
    res = await send()
  }
  if (res.status === 401) {
    // Still 401 with a fresh user token → integration fault. Never surface a
    // bare 401 to control-ui (it treats 401 as session-expiry/logout).
    throw new RegistryStatusError('registry_integration_error', 502)
  }
  return res
}

export async function listKeys(
  admin: AdminUserRecord,
  org: string
): Promise<{ keys: OrgApiKey[] }> {
  const res = await userAuthedFetch(admin, `/org/${encodeURIComponent(org)}/keys`)
  if (!res.ok) throw await toStatusError(res)
  return (await res.json()) as { keys: OrgApiKey[] }
}

export async function createKey(
  admin: AdminUserRecord,
  org: string,
  input: CreateOrgApiKeyInput
): Promise<CreatedOrgApiKey> {
  const res = await userAuthedFetch(admin, `/org/${encodeURIComponent(org)}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await toStatusError(res)
  return (await res.json()) as CreatedOrgApiKey
}

export async function revokeKey(admin: AdminUserRecord, org: string, id: string): Promise<void> {
  const res = await userAuthedFetch(
    admin,
    `/org/${encodeURIComponent(org)}/keys/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  )
  if (!res.ok) throw await toStatusError(res)
}
