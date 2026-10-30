/**
 * Registry reads as the admin catalog serves them. Every entry that leaves
 * control-api through a catalog read goes through `resolveRemoteOAuthEntry`, so
 * a remote-OAuth entry reaches the UI with untrusted presentation metadata
 * already removed and its installability decided. The routes call these
 * instead of `registryClient` directly; filtering per route would let one read
 * path forget it.
 */
import {
  type RegistryEntry,
  getEntry,
  getEntryVersion,
  searchEntries,
} from '../../services/registryClient.js'
import { resolveRemoteOAuthEntry } from './catalogRemoteOAuth.js'

type SearchParams = Parameters<typeof searchEntries>[0]
type SearchPage = Awaited<ReturnType<typeof searchEntries>>

/** The single resolution step every catalog read applies, one entry at a time. */
export function resolveCatalogEntry(entry: RegistryEntry): RegistryEntry {
  return resolveRemoteOAuthEntry(entry)
}

export async function searchCatalogEntries(params: SearchParams): Promise<SearchPage> {
  const page = await searchEntries(params)
  // The landing search is served from a shared cache; build a new page instead of
  // resolving the cached entries in place.
  return {
    ...page,
    data: Array.isArray(page.data) ? page.data.map(resolveCatalogEntry) : page.data,
  }
}

export async function getCatalogEntry(name: string): Promise<RegistryEntry> {
  return resolveCatalogEntry(await getEntry(name))
}

export async function getCatalogEntryVersion(
  name: string,
  version: string
): Promise<RegistryEntry> {
  return resolveCatalogEntry(await getEntryVersion(name, version))
}
