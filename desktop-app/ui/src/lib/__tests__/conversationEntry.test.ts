import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { LatestSidebarChatEntry, SidebarChatEntry } from '@hooks/domain/useAgentChatController'
import {
  UNKNOWN_CONVERSATION_TITLE,
  findConversationEntry,
  openConversationTitle,
} from '../conversationEntry'

// Entries are typed off the chat-list contract (`ChatListContextValue` re-exports
// these shapes), so a fixture the lists cannot hold does not compile.

function listedEntry(id: string, title = id): SidebarChatEntry {
  return { id, title, createdAt: '', updatedAt: '', messageCount: 0 }
}

function latestEntry(agentRef: string, id: string, title = id): LatestSidebarChatEntry {
  return { ...listedEntry(id, title), agentRef }
}

// Short ids over a two-letter alphabet collide often, which is what exercises
// the "same id under another agent" and "duplicate id" cases.
const words = (letters: string[], minLength: number, maxLength: number) =>
  fc
    .array(fc.constantFrom(...letters), { minLength, maxLength })
    .map(characters => characters.join(''))
const ids = words(['a', 'b'], 1, 2)
const agentRefs = words(['u', 'v'], 1, 1)
const titles = words(['x', ' ', '\t'], 0, 4)
const listedArb: fc.Arbitrary<SidebarChatEntry> = fc
  .tuple(ids, titles)
  .map(([id, title]) => listedEntry(id, title))
const latestArb: fc.Arbitrary<LatestSidebarChatEntry> = fc
  .tuple(agentRefs, ids, titles)
  .map(([agentRef, id, title]) => latestEntry(agentRef, id, title))
const chatLists = fc.array(listedArb)
const latestLists = fc.array(latestArb)
const runs = { numRuns: 2000 }

const withoutId = <T extends { id: string }>(entries: T[], id: string): T[] =>
  entries.filter(entry => entry.id !== id)

describe('findConversationEntry', () => {
  it('returns the open conversation from the selected agent’s chat list', () => {
    const entry = listedEntry('chat-1', 'Pricing review')

    expect(findConversationEntry([entry], [], 'alpha', 'chat-1')).toBe(entry)
  })

  it('falls back to the cross-agent list when the chat list has not described it yet', () => {
    const entry = latestEntry('alpha', 'chat-1', 'Pricing review')

    expect(findConversationEntry([], [entry], 'alpha', 'chat-1')).toBe(entry)
  })

  it('does not borrow another agent’s session that shares the id', () => {
    const other = latestEntry('beta', 'chat-1')

    expect(findConversationEntry([], [other], 'alpha', 'chat-1')).toBeUndefined()
    expect(findConversationEntry([], [other], null, 'chat-1')).toBeUndefined()
  })

  it('resolves nothing without an open conversation', () => {
    const entry = listedEntry('chat-1')

    expect(findConversationEntry([entry], [], 'alpha', null)).toBeUndefined()
  })

  it('prefers the chat list entry whenever one exists', () => {
    fc.assert(
      fc.property(
        chatLists,
        listedArb,
        latestLists,
        agentRefs,
        fc.nat(),
        (others, listed, latest, agentRef, position) => {
          const chatList = withoutId(others, listed.id)
          chatList.splice(position % (chatList.length + 1), 0, listed)

          expect(findConversationEntry(chatList, latest, agentRef, listed.id)).toBe(listed)
        }
      ),
      runs
    )
  })

  it('only ever resolves an entry carrying the requested id', () => {
    fc.assert(
      fc.property(chatLists, latestLists, agentRefs, ids, (chatList, latest, agentRef, chatId) => {
        const entry = findConversationEntry(chatList, latest, agentRef, chatId)

        if (entry) expect(entry.id).toBe(chatId)
      }),
      runs
    )
  })

  it('falls back only to entries of the requesting agent', () => {
    fc.assert(
      fc.property(chatLists, latestLists, agentRefs, ids, (chatList, latest, agentRef, chatId) => {
        const entry = findConversationEntry(withoutId(chatList, chatId), latest, agentRef, chatId)

        if (entry) {
          expect(latest).toContain(entry)
          expect((entry as LatestSidebarChatEntry).agentRef).toBe(agentRef)
        }
      }),
      runs
    )
  })

  it('resolves the chat whenever the agent’s cross-agent entries describe it', () => {
    fc.assert(
      fc.property(
        chatLists,
        latestLists,
        titles,
        agentRefs,
        ids,
        (chatList, latest, describedTitle, agentRef, chatId) => {
          const described = latestEntry(agentRef, chatId, describedTitle)

          expect(
            findConversationEntry(chatList, [...latest, described], agentRef, chatId)?.id
          ).toBe(chatId)
        }
      ),
      runs
    )
  })

  it('resolves nothing when no list describes the chat', () => {
    fc.assert(
      fc.property(chatLists, latestLists, agentRefs, ids, (chatList, latest, agentRef, chatId) => {
        // 'c' is outside the id alphabet, so no renamed entry can match `chatId`.
        const renamed = latest.map(entry =>
          latestEntry(entry.agentRef, `${entry.id}c`, entry.title)
        )

        expect(
          findConversationEntry(withoutId(chatList, chatId), renamed, agentRef, chatId)
        ).toBeUndefined()
      }),
      runs
    )
  })

  it('does not fall back without an agent to scope it', () => {
    fc.assert(
      fc.property(chatLists, latestLists, ids, (chatList, latest, chatId) => {
        expect(
          findConversationEntry(withoutId(chatList, chatId), latest, null, chatId)
        ).toBeUndefined()
      }),
      runs
    )
  })
})

describe('openConversationTitle', () => {
  it('shows the chat list entry’s title, trimmed', () => {
    const chatList = [listedEntry('chat-1', '  Pricing review \n')]

    expect(openConversationTitle(chatList, [], 'alpha', 'chat-1')).toBe('Pricing review')
  })

  it('shows the cross-agent entry’s title when the chat list has not described it yet', () => {
    const latest = [latestEntry('alpha', 'chat-1', 'Pricing review')]

    expect(openConversationTitle([], latest, 'alpha', 'chat-1')).toBe('Pricing review')
  })

  it('falls back while no entry or title is known', () => {
    const blank = [listedEntry('chat-1', ' \t ')]

    expect(openConversationTitle(blank, [], 'alpha', 'chat-1')).toBe(UNKNOWN_CONVERSATION_TITLE)
    expect(openConversationTitle([], [], 'alpha', 'chat-1')).toBe(UNKNOWN_CONVERSATION_TITLE)
    expect(openConversationTitle([], [], null, null)).toBe(UNKNOWN_CONVERSATION_TITLE)
  })

  it('shows the described entry’s title, or the fallback', () => {
    fc.assert(
      fc.property(chatLists, latestLists, agentRefs, ids, (chatList, latest, agentRef, chatId) => {
        const listed = chatList.find(entry => entry.id === chatId)
        const described =
          listed ?? latest.find(entry => entry.agentRef === agentRef && entry.id === chatId)

        expect(openConversationTitle(chatList, latest, agentRef, chatId)).toBe(
          described?.title.trim() || UNKNOWN_CONVERSATION_TITLE
        )
      }),
      runs
    )
  })
})
