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
