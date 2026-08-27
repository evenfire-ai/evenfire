import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  addBlankChatViewTab,
  closeChatViewTab,
  createChatViewTabsState,
  cycleChatViewTab,
  focusBlankChatViewTab,
  openPersistedChatViewTab,
  selectChatViewTabAt,
  selectLastChatViewTab,
} from '../chatViewTabs'

function tabs(count: number) {
  let state = createChatViewTabsState('tab-0', 'agent')
  for (let index = 1; index < count; index += 1) {
    state = addBlankChatViewTab(state, `tab-${index}`, 'agent')
  }
  return state
}

describe('chat view tabs', () => {
  it('creates blank tabs and deduplicates persisted agent/chat pairs', () => {
    let state = createChatViewTabsState('blank', 'alpha')
    state = openPersistedChatViewTab(state, {
      id: 'persisted',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: 'First',
    })
    expect(state.tabs).toEqual([
      { id: 'blank', agentRef: 'alpha', chatId: 'chat-1', title: 'First' },
    ])
    state = addBlankChatViewTab(state, 'blank-2', 'alpha')
    state = openPersistedChatViewTab(state, {
      id: 'duplicate',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: 'Renamed',
    })
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).toBe('blank')
    expect(state.tabs[0]?.title).toBe('Renamed')
  })

  it('reuses an active blank for agent selection and appends after a persisted chat', () => {
    let state = createChatViewTabsState('blank')
    state = focusBlankChatViewTab(state, 'unused', 'alpha')
    expect(state.tabs).toEqual([
      { id: 'blank', agentRef: 'alpha', chatId: null, title: 'New chat' },
    ])
    state = openPersistedChatViewTab(state, {
      id: 'unused-persisted',
      agentRef: 'alpha',
      chatId: 'chat-1',
    })
    state = focusBlankChatViewTab(state, 'next-blank', 'beta')
    expect(state.tabs.at(-1)).toEqual({
      id: 'next-blank',
      agentRef: 'beta',
      chatId: null,
      title: 'New chat',
    })
  })

  it('selects 1..8, maps 9 to last, and leaves missing indexes unchanged', () => {
    const state = tabs(10)
    expect(selectChatViewTabAt(state, 7).activeTabId).toBe('tab-7')
    expect(selectLastChatViewTab(state).activeTabId).toBe('tab-9')
    expect(selectChatViewTabAt(state, 10)).toBe(state)
  })

  it('cycles in both directions with wrapping', () => {
    let state = tabs(3)
    expect(cycleChatViewTab(state, 'next').activeTabId).toBe('tab-0')
    state = { ...state, activeTabId: 'tab-0' }
    expect(cycleChatViewTab(state, 'previous').activeTabId).toBe('tab-2')
  })

  it('selects the right close neighbor, then left, and keeps one blank fallback', () => {
    let state = { ...tabs(3), activeTabId: 'tab-1' }
    state = closeChatViewTab(state, 'tab-1', 'fallback')
    expect(state.activeTabId).toBe('tab-2')
    state = closeChatViewTab(state, 'tab-2', 'fallback')
    expect(state.activeTabId).toBe('tab-0')
    state = closeChatViewTab(state, 'tab-0', 'fallback')
    expect(state).toEqual(createChatViewTabsState('fallback', 'agent'))
  })

  it('preserves ordering, uniqueness, active membership, and idempotent persisted sync', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 29 }),
        (count, raw) => {
          const state = tabs(count)
          const index = raw % count
          const selected = selectChatViewTabAt(state, index)
          const cycled = cycleChatViewTab(cycleChatViewTab(selected, 'next'), 'previous')
          expect(cycled.tabs.map(tab => tab.id)).toEqual(state.tabs.map(tab => tab.id))
          expect(new Set(cycled.tabs.map(tab => tab.id)).size).toBe(cycled.tabs.length)
          expect(cycled.tabs.some(tab => tab.id === cycled.activeTabId)).toBe(true)

          const view = { id: 'persisted', agentRef: 'agent', chatId: `chat-${raw}` }
          const once = openPersistedChatViewTab(selected, view)
          const twice = openPersistedChatViewTab(once, view)
          expect(twice).toEqual(once)
          expect(
            twice.tabs.filter(tab => tab.agentRef === view.agentRef && tab.chatId === view.chatId)
          ).toHaveLength(1)
        }
      )
    )
  })
})
