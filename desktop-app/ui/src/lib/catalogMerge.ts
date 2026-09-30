import { type PendingRename, resolveSessionTitle } from '@lib/resolveSessionTitle'

/**
 * Merge precedence between the sidebar's cached chat entries and one page of the
 * server session catalog (spec 15 §2.2). The same rule set used to be written
 * out three times in `useChatListController` (the selected agent's first page,
 * its load-more pages, and the cross-agent Latest list); this is the single
 * definition.
 *
 *  - Every cached entry survives, with every field but `title` untouched. Its
 *    title follows `resolveSessionTitle` (cases C/D/E/F): the server title wins
 *    when the Host reports one and no local rename is pending; a pending rename
 *    keeps the local title. An entry whose title is unchanged keeps its object
 *    identity.
 *  - A server session with no cached entry becomes one new entry (cases A/B),
 *    titled by the server or by the placeholder. A key reported twice by the
 *    page yields one entry, and the first report decides it.
 *  - The result is ordered by `updatedAt`, newest first; an unparseable
 *    timestamp sorts as the epoch.
 *
 * Callers own everything that is not precedence: authority epochs, deletion
 * tombstones and cached-entry de-duplication happen before this runs.
 */

export interface CatalogMergeEntry {
  id: string
  title: string
  updatedAt: string
}

export interface CatalogMergeSession {
  chatId: string
  title?: string
  lastActivityAt: string
}

export interface CatalogMergeInput<E extends CatalogMergeEntry, S extends CatalogMergeSession> {
  cached: readonly E[]
  sessions: readonly S[]
  /** Identity shared by an entry and the session that describes it. */
  entryKey: (entry: E) => string
  sessionKey: (session: S) => string
  entryPendingRename: (entry: E) => PendingRename
  sessionPendingRename: (session: S) => PendingRename
  placeholderFor: (chatId: string) => string
  /** Builds the entry for a server-only session from its resolved title. */
  serverOnlyEntry: (session: S, title: string) => E
}

function sortableTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function byUpdatedDesc(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return sortableTimestamp(b.updatedAt) - sortableTimestamp(a.updatedAt)
}

export function mergeCatalogPage<E extends CatalogMergeEntry, S extends CatalogMergeSession>(
  input: CatalogMergeInput<E, S>
): E[] {
  const sessionByKey = new Map<string, S>()
  for (const session of input.sessions) {
    const key = input.sessionKey(session)
    if (!sessionByKey.has(key)) sessionByKey.set(key, session)
  }

  const cachedKeys = new Set<string>()
  const reconciled = input.cached.map(entry => {
    const key = input.entryKey(entry)
    cachedKeys.add(key)
    const session = sessionByKey.get(key)
    if (!session) return entry
    const { title } = resolveSessionTitle({
      inCache: true,
      localTitle: entry.title,
      serverTitle: session.title,
      pendingRename: input.entryPendingRename(entry),
      placeholder: input.placeholderFor(entry.id),
    })
    return title === entry.title ? entry : { ...entry, title }
  })

  const serverOnly: E[] = []
  for (const [key, session] of sessionByKey) {
    if (cachedKeys.has(key)) continue
    const { title } = resolveSessionTitle({
      inCache: false,
      serverTitle: session.title,
      pendingRename: input.sessionPendingRename(session),
      placeholder: input.placeholderFor(session.chatId),
    })
    serverOnly.push(input.serverOnlyEntry(session, title))
  }

  return [...reconciled, ...serverOnly].sort(byUpdatedDesc)
}
