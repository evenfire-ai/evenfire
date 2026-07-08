import type { AccessCatalogMcpServerEntry, RpcMcpServer } from '../../../../src/types'
import type { ScopedMcpServer } from '../../uiTypes'

export function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

export function getChatUpdatedTimestamp(chat: { updatedAt: string }): number {
  const timestamp = Date.parse(chat.updatedAt)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function normalizeScopedMcpServerEntry(
  entry: AccessCatalogMcpServerEntry | undefined
): ScopedMcpServer | null {
  if (typeof entry === 'string') {
    const name = entry.trim()
    if (!name) return null
    return { name }
  }
  if (!entry || typeof entry !== 'object') return null
  const name = String(entry.name || '').trim()
  if (!name) return null
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  return url ? { name, url } : { name }
}

export function normalizeScopedMcpServerMap(
  map: Record<string, AccessCatalogMcpServerEntry[]> | undefined
): Record<string, ScopedMcpServer[]> {
  if (!map || typeof map !== 'object') return {}
  const result: Record<string, ScopedMcpServer[]> = {}
  for (const [scope, rawEntries] of Object.entries(map)) {
    const scopedKey = String(scope || '').trim()
    if (!scopedKey) continue
    const nextEntries: ScopedMcpServer[] = []
    const seen = new Set<string>()
    const entries = Array.isArray(rawEntries) ? rawEntries : []
    for (const entry of entries) {
      const normalized = normalizeScopedMcpServerEntry(entry)
      if (!normalized) continue
      if (seen.has(normalized.name)) continue
      seen.add(normalized.name)
      nextEntries.push(normalized)
    }
    result[scopedKey] = nextEntries
  }
  return result
}

export function normalizeGlobalMcpServerList(
  servers: RpcMcpServer[] | undefined
): ScopedMcpServer[] {
  const result: ScopedMcpServer[] = []
  const seen = new Set<string>()
  const items = Array.isArray(servers) ? servers : []
  for (const entry of items) {
    const name = String(entry?.name || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const url = typeof entry?.url === 'string' ? entry.url.trim() : ''
    result.push(url ? { name, url } : { name })
  }
  return result
}
