export const CODEX_COMPLETIONS_ORIGIN = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_CATALOG_ORIGIN = 'https://chatgpt.com/backend-api/codex/models'
export const CODEX_TRANSPORT_PROTOCOL = 'codex-subscription-transport.v1' as const

export type UpstreamKind = 'completions' | 'catalog'

export class OriginDeniedError extends Error {
  readonly code = 'origin_denied'
  constructor(message: string) {
    super(message)
    this.name = 'OriginDeniedError'
  }
}

const FROZEN: Record<UpstreamKind, URL> = {
  completions: new URL(CODEX_COMPLETIONS_ORIGIN),
  catalog: new URL(CODEX_CATALOG_ORIGIN),
}

export type AddressLookup = () => Promise<Array<{ address: string; family: number }>>

export type OriginPolicyOptions = {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
}

export function assertAllowedUpstreamUrl(raw: string, kind: UpstreamKind): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new OriginDeniedError('origin_denied')
  }
  const frozen = FROZEN[kind]
  if (parsed.protocol !== 'https:') throw new OriginDeniedError('origin_denied')
  if (parsed.username || parsed.password) throw new OriginDeniedError('origin_denied')
  if (parsed.hash) throw new OriginDeniedError('origin_denied')
  if (parsed.search) throw new OriginDeniedError('origin_denied')
  if (parsed.origin !== frozen.origin || parsed.pathname !== frozen.pathname) {
    throw new OriginDeniedError('origin_denied')
  }
  if (isIpLiteral(parsed.hostname) || isBlockedHostname(parsed.hostname)) {
    throw new OriginDeniedError('origin_denied')
  }
  return parsed
}

export async function assertResolvedUpstream(
  url: URL,
  lookup: OriginPolicyOptions['lookup']
): Promise<void> {
  if (!lookup) return
  const records = await lookup(url.hostname)
  if (!records.length) throw new OriginDeniedError('origin_denied')
  for (const record of records) {
    if (isBlockedAddress(record.address)) throw new OriginDeniedError('origin_denied')
  }
}

export function assertRedirectLocation(location: string, from: URL): URL {
  let next: URL
  try {
    next = new URL(location, from)
  } catch {
    throw new OriginDeniedError('origin_denied')
  }
  if (next.protocol !== 'https:') throw new OriginDeniedError('origin_denied')
  if (next.origin !== from.origin) throw new OriginDeniedError('origin_denied')
  if (isIpLiteral(next.hostname) || isBlockedHostname(next.hostname)) {
    throw new OriginDeniedError('origin_denied')
  }
  if (next.pathname !== from.pathname) throw new OriginDeniedError('origin_denied')
  return next
}

export function isBlockedAddress(address: string): boolean {
  if (address.includes(':')) return isBlockedV6(address)
  const parts = address.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 51 || b === 18)) return true
  if (a === 203 && b === 113) return true
  if (a >= 224) return true
  return false
}

function isBlockedV6(address: string): boolean {
  const normalized = address.toLowerCase()
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80') ||
    normalized.startsWith('::ffff:')
  )
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
}
