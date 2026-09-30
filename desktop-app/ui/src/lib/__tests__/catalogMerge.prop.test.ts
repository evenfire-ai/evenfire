import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { byUpdatedDesc, mergeCatalogPage } from '../catalogMerge'
import type { PendingRename } from '../resolveSessionTitle'

/**
 * R1-M9 — property suite for the single sidebar/catalog merge precedence rule
 * (spec 15 §2.2). The expected titles are written out from the case table, not
 * computed by calling `resolveSessionTitle`, so a regression in either the
 * merge or the resolver fails here.
 */

interface Entry {
  id: string
  title: string
  updatedAt: string
  /** A field the merge must never touch. */
  messageCount: number
}

interface Session {
  chatId: string
  title?: string
  lastActivityAt: string
}

const CHAT_IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const
const PENDING: PendingRename[] = ['none', 'in-flight', 'offline']

const placeholderFor = (chatId: string) => `Chat ${chatId}`

const timestampArb = fc.oneof(
  fc
    .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) })
    .map(ms => new Date(ms).toISOString()),
  fc.constant('not-a-date')
)
const titleArb = fc.constantFrom('', 'Local plan', 'Server plan', 'Renamed')

const entriesArb = fc.uniqueArray(
  fc.record({
    id: fc.constantFrom(...CHAT_IDS),
    title: titleArb,
    updatedAt: timestampArb,
    messageCount: fc.nat({ max: 50 }),
  }),
  { selector: entry => entry.id, maxLength: CHAT_IDS.length }
)
const sessionsArb = fc.array(
  fc.record(
    {
      chatId: fc.constantFrom(...CHAT_IDS),
      title: titleArb,
      lastActivityAt: timestampArb,
    },
    { requiredKeys: ['chatId', 'lastActivityAt'] }
  ),
  { maxLength: 10 }
)
const pendingArb = fc.dictionary(fc.constantFrom(...CHAT_IDS), fc.constantFrom(...PENDING))

function merge(cached: Entry[], sessions: Session[], pending: Record<string, PendingRename>) {
  const pendingFor = (chatId: string): PendingRename => pending[chatId] ?? 'none'
  return mergeCatalogPage<Entry, Session>({
    cached,
    sessions,
    entryKey: entry => entry.id,
    sessionKey: session => session.chatId,
    entryPendingRename: entry => pendingFor(entry.id),
    sessionPendingRename: session => pendingFor(session.chatId),
    placeholderFor,
    serverOnlyEntry: (session, title) => ({
      id: session.chatId,
      title,
      updatedAt: session.lastActivityAt,
      messageCount: 0,
    }),
  })
}

/** §2.2 cases C/D/E/F for a cached entry the page also reports. */
function expectedCachedTitle(local: string, server: string | undefined, pending: PendingRename) {
  if (pending !== 'none' && local !== '') return local // E/F
  if (server) return server // C
  if (local !== '') return local // D
  return 'placeholder'
}

/** §2.2 cases A/B for a session the cache does not hold. */
function expectedServerOnlyTitle(server: string | undefined, chatId: string) {
  return server ? server : placeholderFor(chatId)
}

const firstReport = (sessions: Session[], chatId: string) =>
  sessions.find(session => session.chatId === chatId)

describe('mergeCatalogPage', () => {
  it('holds every cached entry and every reported chat exactly once', () => {
    fc.assert(
      fc.property(entriesArb, sessionsArb, pendingArb, (cached, sessions, pending) => {
        const ids = merge(cached, sessions, pending).map(entry => entry.id)
        const expected = new Set([
          ...cached.map(entry => entry.id),
          ...sessions.map(session => session.chatId),
        ])
        expect(ids).toHaveLength(expected.size)
        expect(new Set(ids)).toEqual(expected)
      })
    )
  })

  it('titles a cached entry by the §2.2 precedence and leaves its other fields alone', () => {
    fc.assert(
      fc.property(entriesArb, sessionsArb, pendingArb, (cached, sessions, pending) => {
        const merged = merge(cached, sessions, pending)
        for (const entry of cached) {
          const out = merged.find(candidate => candidate.id === entry.id)
          const session = firstReport(sessions, entry.id)
          if (!session) {
            expect(out).toBe(entry)
            continue
          }
          const expected = expectedCachedTitle(
            entry.title,
            session.title,
            pending[entry.id] ?? 'none'
          )
          expect(out).toEqual({
            ...entry,
            title: expected === 'placeholder' ? placeholderFor(entry.id) : expected,
          })
          if (out?.title === entry.title) expect(out).toBe(entry)
        }
      })
    )
  })

  it('builds one server-only entry from the first report of each new chat', () => {
    fc.assert(
      fc.property(entriesArb, sessionsArb, pendingArb, (cached, sessions, pending) => {
        const merged = merge(cached, sessions, pending)
        const cachedIds = new Set(cached.map(entry => entry.id))
        for (const chatId of new Set(sessions.map(session => session.chatId))) {
          if (cachedIds.has(chatId)) continue
          const first = firstReport(sessions, chatId) as Session
          expect(merged.find(entry => entry.id === chatId)).toEqual({
            id: chatId,
            title: expectedServerOnlyTitle(first.title, chatId),
            updatedAt: first.lastActivityAt,
            messageCount: 0,
          })
        }
      })
    )
  })

  it('orders the result newest first', () => {
    fc.assert(
      fc.property(entriesArb, sessionsArb, pendingArb, (cached, sessions, pending) => {
        const merged = merge(cached, sessions, pending)
        for (let i = 1; i < merged.length; i += 1) {
          expect(byUpdatedDesc(merged[i - 1] as Entry, merged[i] as Entry)).toBeLessThanOrEqual(0)
        }
      })
    )
  })

  it('is idempotent: merging the same page again changes nothing', () => {
    fc.assert(
      fc.property(entriesArb, sessionsArb, pendingArb, (cached, sessions, pending) => {
        const once = merge(cached, sessions, pending)
        expect(merge(once, sessions, pending)).toEqual(once)
      })
    )
  })

  // Cursor pages report disjoint chats, so merging page A and then page B must
  // equal one merge of both. Overlapping pages do not compose by design: a
  // later report updates a chat's title but its `updatedAt` stays from the
  // report that created the entry.
  it('composes over disjoint pages: A then B equals one merge of A and B', () => {
    fc.assert(
      fc.property(
        entriesArb,
        sessionsArb,
        fc.subarray([...CHAT_IDS]),
        pendingArb,
        (cached, sessions, pageAIds, pending) => {
          const inPageA = new Set<string>(pageAIds)
          const pageA = sessions.filter(session => inPageA.has(session.chatId))
          const pageB = sessions.filter(session => !inPageA.has(session.chatId))

          const sequential = merge(merge(cached, pageA, pending), pageB, pending)

          // Witness: both pages reached the result, so a merge that ignores
          // its sessions cannot satisfy the equality below.
          expect(new Set(sequential.map(entry => entry.id))).toEqual(
            new Set([...cached.map(entry => entry.id), ...sessions.map(s => s.chatId)])
          )
          expect(sequential).toEqual(merge(cached, [...pageA, ...pageB], pending))
        }
      )
    )
  })

  it('orders known dates newest first with an unparseable date as the epoch (fixed oracle)', () => {
    // The property test above checks order with the production comparator, so an
    // inverted comparator or a different fallback for NaN passes it. This case
    // states the expected order literally.
    const cached: Entry[] = [
      { id: 'jan', title: 'Jan', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
      { id: 'invalid', title: 'Invalid', updatedAt: 'no-fecha', messageCount: 0 },
      { id: 'pre-epoch', title: 'Pre', updatedAt: '1969-06-01T00:00:00.000Z', messageCount: 0 },
      { id: 'mar', title: 'Mar', updatedAt: '2026-03-01T00:00:00.000Z', messageCount: 0 },
    ]
    const sessions: Session[] = [
      { chatId: 'feb', title: 'Feb', lastActivityAt: '2026-02-01T00:00:00.000Z' },
    ]
    expect(merge(cached, sessions, {}).map(entry => entry.id)).toEqual([
      'mar',
      'feb',
      'jan',
      'invalid',
      'pre-epoch',
    ])
  })

  it('names the placeholder after the cached entry id, not the reported chat id', () => {
    // Entry and session share a key but not an id, so the two placeholder calls
    // are distinguishable. The cached title is empty and the server has none, so
    // the placeholder is what the entry ends up titled.
    const calls: string[] = []
    const merged = mergeCatalogPage<Entry, Session>({
      cached: [
        { id: 'cached-id', title: '', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
      ],
      sessions: [{ chatId: 'reported-chat-id', lastActivityAt: '2026-02-01T00:00:00.000Z' }],
      entryKey: () => 'shared-key',
      sessionKey: () => 'shared-key',
      entryPendingRename: () => 'none',
      sessionPendingRename: () => 'none',
      placeholderFor: chatId => {
        calls.push(chatId)
        return `Chat ${chatId}`
      },
      serverOnlyEntry: (session, title) => ({
        id: session.chatId,
        title,
        updatedAt: session.lastActivityAt,
        messageCount: 0,
      }),
    })
    // Liveness witness: the merge reached the placeholder path for the shared key.
    expect(calls).toEqual(['cached-id'])
    expect(merged.map(entry => entry.title)).toEqual(['Chat cached-id'])
  })

  it('names a server-only session placeholder after its chat id', () => {
    const merged = mergeCatalogPage<Entry, Session>({
      cached: [],
      sessions: [{ chatId: 'reported-chat-id', lastActivityAt: '2026-02-01T00:00:00.000Z' }],
      entryKey: entry => entry.id,
      sessionKey: session => session.chatId,
      entryPendingRename: () => 'none',
      sessionPendingRename: () => 'none',
      placeholderFor,
      serverOnlyEntry: (session, title) => ({
        id: session.chatId,
        title,
        updatedAt: session.lastActivityAt,
        messageCount: 0,
      }),
    })
    expect(merged.map(entry => entry.title)).toEqual(['Chat reported-chat-id'])
  })

  it('keeps a pending local rename over a server title (case E)', () => {
    const cached: Entry[] = [
      { id: 'a', title: 'Renamed', updatedAt: '2026-09-12T00:00:00.000Z', messageCount: 3 },
    ]
    const sessions: Session[] = [
      { chatId: 'a', title: 'Server plan', lastActivityAt: '2026-09-13T00:00:00.000Z' },
    ]
    expect(merge(cached, sessions, { a: 'in-flight' })[0]?.title).toBe('Renamed')
    expect(merge(cached, sessions, {})[0]?.title).toBe('Server plan')
  })
})
