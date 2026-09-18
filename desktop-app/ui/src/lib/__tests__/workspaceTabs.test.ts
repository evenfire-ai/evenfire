import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  activeWorkspaceTab,
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  cycleWorkspaceTab,
  firstWorkspaceTab,
  lastWorkspaceTab,
  newChatTab,
  openAppTab,
  openChatTab,
  openFilesTab,
  openSettingsTab,
  reconcileWorkspaceChatTab,
  selectLastWorkspaceTab,
  selectWorkspaceTab,
  selectWorkspaceTabAt,
  setAppTabSavedRoutePath,
  setAppTabTitle,
} from '../workspaceTabs'
import type { ActiveChat, SettingsSection, WorkspaceTabsState } from '../workspaceTabs.types'

const SECTIONS: SettingsSection[] = ['connectors', 'agents', 'plugins', 'settings']

// A persisted chatId is unique to its agent, so tie the agent to the chat: the
// store dedupes chat tabs by (agentRef, chatId), and this makes that equivalent
// to dedupe-by-chatId, the identity the spec (§4.1 / §7-3) states.
const agentForChat = (chatId: string) => `agent:${chatId}`

// ---- example-based specifications -------------------------------------------

describe('workspaceTabs — construction and empty state', () => {
  it('boots with a single active blank chat tab (§5 boot seed)', () => {
    const state = createWorkspaceTabsState('boot', 'alpha')
    expect(state).toEqual({
      tabs: [
        { id: 'boot', kind: 'chat', title: 'New chat', chat: { agentRef: 'alpha', chatId: null } },
      ],
      activeTabId: 'boot',
    })
  })

  it('represents an empty workspace with a null active id', () => {
    expect(createEmptyWorkspaceTabsState()).toEqual({ tabs: [], activeTabId: null })
  })

  it('total accessors never throw on an empty list (lifted invariant)', () => {
    const empty = createEmptyWorkspaceTabsState()
    expect(firstWorkspaceTab(empty.tabs)).toBeUndefined()
    expect(lastWorkspaceTab(empty.tabs)).toBeUndefined()
    expect(activeWorkspaceTab(empty)).toBeUndefined()
    expect(selectLastWorkspaceTab(empty)).toBe(empty)
    expect(cycleWorkspaceTab(empty, 'next')).toBe(empty)
    expect(selectWorkspaceTabAt(empty, 0)).toBe(empty)
  })
})

describe('workspaceTabs — identity rules R6–R9', () => {
  it('R7 — dedupes a chat by chatId and focuses the existing tab', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openChatTab(state, { id: 'c1', agentRef: 'a', chatId: 'chat-1', title: 'First' })
    state = openAppTab(state, { id: 'app-1', appRef: 'app' })
    const before = state.tabs.length
    state = openChatTab(state, { id: 'dup', agentRef: 'a', chatId: 'chat-1', title: 'Renamed' })
    expect(state.tabs.length).toBe(before) // no new tab
    expect(state.activeTabId).toBe('c1') // focused existing
    expect(state.tabs.find(t => t.id === 'c1')?.title).toBe('Renamed')

    // A re-open with the same (or no) title is a no-op on the tab array — the
    // dedupe branch preserves referential equality so downstream skips a render.
    const sameTabs = state.tabs
    const reopened = openChatTab(state, {
      id: 'dup2',
      agentRef: 'a',
      chatId: 'chat-1',
      title: 'Renamed',
    })
    expect(reopened.tabs).toBe(sameTabs)
    expect(openChatTab(state, { id: 'dup3', agentRef: 'a', chatId: 'chat-1' }).tabs).toBe(sameTabs)
  })

  it('R9 — apps always open a new tab, keyed by tab-id (no appRef dedupe)', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks' })
    state = openAppTab(state, { id: 'app-2', appRef: 'eventasks' })
    expect(state.tabs.filter(t => t.kind === 'app')).toHaveLength(2)
    expect(state.activeTabId).toBe('app-2')
  })

  it('R8 — files is a single instance; re-open focuses the existing tab', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openFilesTab(state, { id: 'files-1' })
    state = openAppTab(state, { id: 'app-1', appRef: 'x' })
    state = openFilesTab(state, { id: 'files-2' })
    expect(state.tabs.filter(t => t.kind === 'files')).toHaveLength(1)
    expect(state.activeTabId).toBe('files-1')
  })

  it('R6 — settings is unique per section; re-open focuses the existing section', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openSettingsTab(state, { id: 's-connectors', section: 'connectors' })
    state = openSettingsTab(state, { id: 's-agents', section: 'agents' })
    state = openSettingsTab(state, { id: 's-connectors-2', section: 'connectors' })
    expect(state.tabs.filter(t => t.kind === 'settings')).toHaveLength(2)
    expect(state.activeTabId).toBe('s-connectors')
  })
})

describe('workspaceTabs — setAppTabSavedRoutePath (mini-spec 05 §3)', () => {
  it('persists a route on the matching app tab and leaves siblings untouched', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks' })
    state = openAppTab(state, { id: 'app-2', appRef: 'eventasks' })

    state = setAppTabSavedRoutePath(state, 'app-1', '/tickets/42')

    expect(state.tabs.find(t => t.id === 'app-1')?.app?.savedRoutePath).toBe('/tickets/42')
    expect(state.tabs.find(t => t.id === 'app-2')?.app?.savedRoutePath).toBeUndefined()
    expect(state.activeTabId).toBe('app-2') // selection is not disturbed
  })

  it('clears the saved route (drops the key) when routePath is undefined', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks', savedRoutePath: '/tickets/42' })

    state = setAppTabSavedRoutePath(state, 'app-1', undefined)

    const app = state.tabs.find(t => t.id === 'app-1')?.app
    expect(app?.savedRoutePath).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(app, 'savedRoutePath')).toBe(false)
  })

  it('is a no-op (same reference) when the route is unchanged', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks', savedRoutePath: '/tickets/42' })

    expect(setAppTabSavedRoutePath(state, 'app-1', '/tickets/42')).toBe(state)
    // Clearing an already-absent route is likewise a no-op.
    state = openAppTab(state, { id: 'app-2', appRef: 'eventasks' })
    expect(setAppTabSavedRoutePath(state, 'app-2', undefined)).toBe(state)
  })

  it('is a no-op when the tab is missing (e.g. a persist racing a close) or not an app', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks' })
    state = openChatTab(state, { id: 'chat-1', agentRef: 'a', chatId: 'c1' })

    // Closed / unknown tab id → the route write silently no-ops (§3: closing a
    // tab does not save).
    expect(setAppTabSavedRoutePath(state, 'gone', '/tickets/42')).toBe(state)
    // A chat tab is not an app tab → no route is written.
    expect(setAppTabSavedRoutePath(state, 'chat-1', '/tickets/42')).toBe(state)
  })

  it('keeps each of two tabs of the same app on its own route (R9, §5)', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-a', appRef: 'eventasks' })
    state = openAppTab(state, { id: 'app-b', appRef: 'eventasks' })

    state = setAppTabSavedRoutePath(state, 'app-a', '/tickets/A')
    state = setAppTabSavedRoutePath(state, 'app-b', '/tickets/B')

    expect(state.tabs.find(t => t.id === 'app-a')?.app?.savedRoutePath).toBe('/tickets/A')
    expect(state.tabs.find(t => t.id === 'app-b')?.app?.savedRoutePath).toBe('/tickets/B')
  })
})

describe('workspaceTabs — setAppTabTitle (mini-spec 06 §2)', () => {
  it('renames the matching app tab and leaves siblings untouched', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks', title: 'App' })
    state = openAppTab(state, { id: 'app-2', appRef: 'eventasks', title: 'App' })

    state = setAppTabTitle(state, 'app-1', 'Ticket 42 — Acme')

    expect(state.tabs.find(t => t.id === 'app-1')?.title).toBe('Ticket 42 — Acme')
    expect(state.tabs.find(t => t.id === 'app-2')?.title).toBe('App')
    expect(state.activeTabId).toBe('app-2') // selection is not disturbed
  })

  it('trims the reported title before storing it', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks', title: 'App' })
    state = setAppTabTitle(state, 'app-1', '  Padded title  ')
    expect(state.tabs.find(t => t.id === 'app-1')?.title).toBe('Padded title')
  })

  it('is a no-op (same reference) when the title is unchanged', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks', title: 'Doc' })
    expect(setAppTabTitle(state, 'app-1', 'Doc')).toBe(state)
    // A trimmed value equal to the stored one is likewise a no-op.
    expect(setAppTabTitle(state, 'app-1', '  Doc  ')).toBe(state)
  })

  it('ignores an empty / whitespace-only title, keeping the previous one', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks', title: 'Doc' })
    expect(setAppTabTitle(state, 'app-1', '')).toBe(state)
    expect(setAppTabTitle(state, 'app-1', '   ')).toBe(state)
    expect(state.tabs.find(t => t.id === 'app-1')?.title).toBe('Doc')
  })

  it('is a no-op when the tab is missing (persist racing a close) or not an app', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'eventasks', title: 'App' })
    state = openChatTab(state, { id: 'chat-1', agentRef: 'a', chatId: 'c1', title: 'Chat' })
    state = openFilesTab(state, { id: 'files-1' })

    expect(setAppTabTitle(state, 'gone', 'X')).toBe(state)
    // A chat / files tab is never renamed by the app-title path.
    expect(setAppTabTitle(state, 'chat-1', 'X')).toBe(state)
    expect(setAppTabTitle(state, 'files-1', 'X')).toBe(state)
    expect(state.tabs.find(t => t.id === 'chat-1')?.title).toBe('Chat')
  })
})

describe('workspaceTabs — new chat (blank) with kind guard', () => {
  it('reuses the active blank chat tab (aligns the agent)', () => {
    let state = createWorkspaceTabsState('boot', null)
    state = newChatTab(state, 'unused', 'alpha')
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toEqual({
      id: 'boot',
      kind: 'chat',
      title: 'New chat',
      chat: { agentRef: 'alpha', chatId: null },
    })
  })

  it('ADDS a chat tab when the active tab is not a chat (§5 / focusBlank guard)', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openFilesTab(state, { id: 'files-1' })
    state = newChatTab(state, 'chat-new', 'beta')
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).toBe('chat-new')
    expect(activeWorkspaceTab(state)?.kind).toBe('chat')
  })

  it('ADDS a chat tab when the active chat already holds a persisted chat', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openChatTab(state, { id: 'c1', agentRef: 'a', chatId: 'chat-1' })
    state = newChatTab(state, 'blank', 'a')
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).toBe('blank')
  })
})

describe('workspaceTabs — selection and cycling over all kinds', () => {
  function mixed(): WorkspaceTabsState {
    let state = createEmptyWorkspaceTabsState()
    state = openChatTab(state, { id: 't0', agentRef: 'a', chatId: 'c0' })
    state = openAppTab(state, { id: 't1', appRef: 'app' })
    state = openFilesTab(state, { id: 't2' })
    state = openSettingsTab(state, { id: 't3', section: 'agents' })
    return state
  }

  it('selects by id, by index, and last — across kinds', () => {
    const state = mixed()
    expect(selectWorkspaceTab(state, 't1').activeTabId).toBe('t1')
    expect(selectWorkspaceTabAt(state, 2).activeTabId).toBe('t2')
    expect(selectLastWorkspaceTab(state).activeTabId).toBe('t3')
    expect(selectWorkspaceTab(state, 'missing')).toBe(state)
  })

  it('cycles in both directions with wrapping', () => {
    let state = { ...mixed(), activeTabId: 't3' }
    expect(cycleWorkspaceTab(state, 'next').activeTabId).toBe('t0')
    state = { ...state, activeTabId: 't0' }
    expect(cycleWorkspaceTab(state, 'previous').activeTabId).toBe('t3')
  })
})

describe('workspaceTabs — close (no re-seed; empty allowed §5)', () => {
  it('activates the right neighbor, then clamps left, then leaves EMPTY', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openChatTab(state, { id: 't0', agentRef: 'a', chatId: 'c0' })
    state = openAppTab(state, { id: 't1', appRef: 'app' })
    state = openFilesTab(state, { id: 't2' })
    state = { ...state, activeTabId: 't1' }

    state = closeWorkspaceTab(state, 't1')
    expect(state.activeTabId).toBe('t2') // right neighbor

    state = closeWorkspaceTab(state, 't2')
    expect(state.activeTabId).toBe('t0') // clamped to left

    state = closeWorkspaceTab(state, 't0')
    // Closing the last tab does NOT re-seed a blank chat — it goes empty.
    expect(state).toEqual({ tabs: [], activeTabId: null })
  })

  it('closing a non-active tab keeps the active id', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openChatTab(state, { id: 't0', agentRef: 'a', chatId: 'c0' })
    state = openAppTab(state, { id: 't1', appRef: 'app' })
    state = { ...state, activeTabId: 't1' }
    state = closeWorkspaceTab(state, 't0')
    expect(state.activeTabId).toBe('t1')
    expect(state.tabs.map(t => t.id)).toEqual(['t1'])
  })

  it('is a no-op for an unknown id', () => {
    const state = openChatTab(createEmptyWorkspaceTabsState(), {
      id: 't0',
      agentRef: 'a',
      chatId: 'c0',
    })
    expect(closeWorkspaceTab(state, 'nope')).toBe(state)
  })
})

// ---- T2 property-based (§7) --------------------------------------------------

type OpenOp =
  | { t: 'chat'; chatId: string }
  | { t: 'app'; appRef: string }
  | { t: 'files' }
  | { t: 'settings'; section: SettingsSection }

const openOpArb: fc.Arbitrary<OpenOp> = fc.oneof(
  fc.record({ t: fc.constant('chat' as const), chatId: fc.constantFrom('c1', 'c2', 'c3', 'c4') }),
  fc.record({ t: fc.constant('app' as const), appRef: fc.constantFrom('app-a', 'app-b') }),
  fc.record({ t: fc.constant('files' as const) }),
  fc.record({ t: fc.constant('settings' as const), section: fc.constantFrom(...SECTIONS) })
)

function applyOpens(ops: OpenOp[]): WorkspaceTabsState {
  let state = createEmptyWorkspaceTabsState()
  ops.forEach((op, i) => {
    const id = `id-${i}`
    if (op.t === 'chat') {
      state = openChatTab(state, { id, agentRef: agentForChat(op.chatId), chatId: op.chatId })
    } else if (op.t === 'app') {
      state = openAppTab(state, { id, appRef: op.appRef })
    } else if (op.t === 'files') {
      state = openFilesTab(state, { id })
    } else {
      state = openSettingsTab(state, { id, section: op.section })
    }
  })
  return state
}

describe('workspaceTabs — T2 properties (§7)', () => {
  it('(2)+(3) no duplicate ids; chat/files/settings unique, apps multiple', () => {
    fc.assert(
      fc.property(fc.array(openOpArb, { maxLength: 40 }), ops => {
        const state = applyOpens(ops)

        // (2) no duplicate tab ids.
        const ids = state.tabs.map(t => t.id)
        expect(new Set(ids).size).toBe(ids.length)

        // (3) chat unique by chatId.
        const chatIds = state.tabs.filter(t => t.kind === 'chat').map(t => t.chat?.chatId)
        expect(new Set(chatIds).size).toBe(chatIds.length)

        // (3) files unique.
        expect(state.tabs.filter(t => t.kind === 'files').length).toBeLessThanOrEqual(1)

        // (3) settings unique per section.
        const sections = state.tabs.filter(t => t.kind === 'settings').map(t => t.settings?.section)
        expect(new Set(sections).size).toBe(sections.length)

        // (3) apps: one tab per app open (no dedupe).
        const appOpens = ops.filter(op => op.t === 'app').length
        expect(state.tabs.filter(t => t.kind === 'app').length).toBe(appOpens)

        // active id (when tabs exist) always references a real tab.
        if (state.tabs.length > 0) {
          expect(state.tabs.some(t => t.id === state.activeTabId)).toBe(true)
        } else {
          expect(state.activeTabId).toBeNull()
        }
      })
    )
  })

  it('(1) opens append in insertion order; selection and cycling preserve it', () => {
    fc.assert(
      fc.property(
        fc.array(openOpArb, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 0, max: 29 }),
        (ops, raw) => {
          // Expected strip order: the id of each op that CREATES a new tab
          // (dedupe focuses in place, it does not reorder), in open order.
          const expectedOrder: string[] = []
          const seenChats = new Set<string>()
          const seenSections = new Set<string>()
          let hasFiles = false
          ops.forEach((op, i) => {
            const id = `id-${i}`
            if (op.t === 'chat') {
              if (!seenChats.has(op.chatId)) {
                seenChats.add(op.chatId)
                expectedOrder.push(id)
              }
            } else if (op.t === 'app') {
              expectedOrder.push(id)
            } else if (op.t === 'files') {
              if (!hasFiles) {
                hasFiles = true
                expectedOrder.push(id)
              }
            } else if (!seenSections.has(op.section)) {
              seenSections.add(op.section)
              expectedOrder.push(id)
            }
          })

          const state = applyOpens(ops)
          const order = state.tabs.map(t => t.id)
          // Insertion order is preserved in the strip.
          expect(order).toEqual(expectedOrder)

          const index = raw % state.tabs.length
          const selected = selectWorkspaceTabAt(state, index)
          const cycled = cycleWorkspaceTab(cycleWorkspaceTab(selected, 'next'), 'previous')
          // Order is untouched by selection/cycling; only activeTabId moves.
          expect(selected.tabs.map(t => t.id)).toEqual(order)
          expect(cycled.tabs.map(t => t.id)).toEqual(order)
        }
      )
    )
  })

  it('(5) closing every tab in any order never re-seeds — ends EMPTY', () => {
    fc.assert(
      fc.property(
        fc.array(openOpArb, { minLength: 1, maxLength: 25 }),
        fc.array(fc.integer({ min: 0, max: 24 }), { maxLength: 25 }),
        (ops, order) => {
          let state = applyOpens(ops)
          const opened = state.tabs.length
          // Close each tab exactly once, in a shuffled-ish order.
          const ids = [...state.tabs.map(t => t.id)]
          const closeOrder = order
            .map(n => ids[n % ids.length]!)
            .concat(ids)
            .filter((id, i, arr) => arr.indexOf(id) === i)
          let closes = 0
          for (const id of closeOrder) {
            const before = state.tabs.length
            state = closeWorkspaceTab(state, id)
            if (state.tabs.length < before) closes += 1
            // The list only ever shrinks — no phantom tab appears.
            expect(state.tabs.length).toBeLessThanOrEqual(before)
          }
          expect(closes).toBe(opened)
          expect(state).toEqual({ tabs: [], activeTabId: null })
        }
      )
    )
  })
})

describe('workspaceTabs — reconcile (chat sub-slice, §3)', () => {
  const agentArb = fc.constantFrom('alpha', 'beta', 'gamma')
  const chatArb = fc.option(fc.constantFrom('c1', 'c2', 'c3', 'c4'), { nil: null })
  const titleArb = fc.option(fc.constantFrom('T1', 'T2'), { nil: undefined })
  const activeArb: fc.Arbitrary<ActiveChat> = fc.record({
    agentRef: agentArb,
    chatId: chatArb,
    title: titleArb,
  })

  it('the active tab always reflects the displayed chat; no duplicate persisted tabs', () => {
    fc.assert(
      fc.property(fc.array(activeArb, { maxLength: 40 }), events => {
        let state = createWorkspaceTabsState('seed', 'alpha')
        let counter = 0
        for (const event of events) {
          state = reconcileWorkspaceChatTab(state, event, `gen-${counter++}`)
          const active = activeWorkspaceTab(state)
          expect(active?.kind).toBe('chat')
          expect(active?.chat?.agentRef).toBe(event.agentRef)
          expect(active?.chat?.chatId).toBe(event.chatId)
          const seen = new Set<string>()
          for (const tab of state.tabs) {
            if (tab.kind !== 'chat' || tab.chat?.chatId == null) continue
            const key = `${tab.chat.agentRef}::${tab.chat.chatId}`
            expect(seen.has(key)).toBe(false)
            seen.add(key)
          }
        }
      })
    )
  })

  it('(4) is idempotent: applying the same event twice equals applying it once (same ref)', () => {
    fc.assert(
      fc.property(fc.array(activeArb, { maxLength: 20 }), activeArb, (prefix, event) => {
        let state = createWorkspaceTabsState('seed', 'alpha')
        let counter = 0
        for (const e of prefix) state = reconcileWorkspaceChatTab(state, e, `p-${counter++}`)
        const once = reconcileWorkspaceChatTab(state, event, 'once')
        const twice = reconcileWorkspaceChatTab(once, event, 'twice')
        expect(twice).toBe(once)
      })
    )
  })

  it('never drops a persisted chat tab that was already open', () => {
    fc.assert(
      fc.property(fc.array(activeArb, { maxLength: 30 }), events => {
        let state = createWorkspaceTabsState('seed', 'alpha')
        let counter = 0
        const everOpened = new Set<string>()
        for (const event of events) {
          state = reconcileWorkspaceChatTab(state, event, `g-${counter++}`)
          if (event.chatId !== null) everOpened.add(`${event.agentRef}::${event.chatId}`)
          for (const key of everOpened) {
            const [agentRef, chatId] = key.split('::')
            expect(
              state.tabs.filter(
                t => t.kind === 'chat' && t.chat?.agentRef === agentRef && t.chat?.chatId === chatId
              )
            ).toHaveLength(1)
          }
        }
      })
    )
  })

  // Coverage gap: the other reconcile properties all seed a chat tab. This one
  // seeds a NON-chat active tab (app/files/settings) so the append+activate path
  // is exercised and its contract is pinned.
  it('reconciles from a non-chat active tab: re-homes focus to the chat, keeps the seed, stays idempotent', () => {
    const seedKindArb = fc.constantFrom<'app' | 'files' | 'settings'>('app', 'files', 'settings')
    fc.assert(
      fc.property(
        seedKindArb,
        fc.array(activeArb, { minLength: 1, maxLength: 20 }),
        (seedKind, events) => {
          let state = createEmptyWorkspaceTabsState()
          if (seedKind === 'app') state = openAppTab(state, { id: 'seed', appRef: 'x' })
          else if (seedKind === 'files') state = openFilesTab(state, { id: 'seed' })
          else state = openSettingsTab(state, { id: 'seed', section: 'agents' })
          const seedTab = state.tabs[0]!

          let counter = 0
          for (const event of events) {
            state = reconcileWorkspaceChatTab(state, event, `n-${counter++}`)
            const active = activeWorkspaceTab(state)
            // Documented contract: focus re-homes onto the chat tab.
            expect(active?.kind).toBe('chat')
            expect(active?.chat?.agentRef).toBe(event.agentRef)
            expect(active?.chat?.chatId).toBe(event.chatId)
            // The non-chat seed is never dropped by chat reconciliation.
            expect(state.tabs.some(t => t.id === seedTab.id && t.kind === seedTab.kind)).toBe(true)
          }

          // Idempotence still holds from a non-chat-seeded history.
          const lastEvent = events[events.length - 1]!
          const again = reconcileWorkspaceChatTab(state, lastEvent, 'again')
          expect(again).toBe(state)
        }
      )
    )
  })

  // §1 (mini-spec 06): the drawer-toggle duplication. In drawer mode App wraps
  // reconcile so the app/files tab STAYS active (activating a chat tab would tear
  // the embed down). Model that seam by resetting `activeTabId` to the non-chat
  // tab after each reconcile: a chatId:null reconcile must then reuse the single
  // blank chat tab, never append a new one per toggle. Assert the observable tab
  // list (T4). Against the parent this appends one blank per event and blows the
  // cap.
  it('the drawer seam never stacks blank chat tabs across repeated blank reconciles (§1)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(fc.constantFrom('alpha', 'beta', 'gamma'), { minLength: 1, maxLength: 30 }),
        (startWithBlank, agents) => {
          let state = createEmptyWorkspaceTabsState()
          if (startWithBlank) state = newChatTab(state, 'boot-blank', 'alpha')
          state = openFilesTab(state, { id: 'files' }) // files becomes the active tab
          const countBlanks = (s: WorkspaceTabsState) =>
            s.tabs.filter(t => t.kind === 'chat' && (t.chat?.chatId ?? null) === null).length
          // Invariant: at most one blank, and a new one only if none existed.
          const cap = Math.max(1, countBlanks(state))
          let counter = 0
          for (const agent of agents) {
            state = reconcileWorkspaceChatTab(
              state,
              { agentRef: agent, chatId: null },
              `g-${counter++}`
            )
            // The drawer seam keeps the non-chat tab active.
            state = { ...state, activeTabId: 'files' }
            expect(countBlanks(state)).toBeLessThanOrEqual(cap)
          }
          // The non-chat tab is never dropped by blank chat reconciliation.
          expect(state.tabs.some(t => t.id === 'files' && t.kind === 'files')).toBe(true)
        }
      )
    )
  })

  it('reconcile leaves non-chat tabs untouched and re-homes focus to the chat tab', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'app-1', appRef: 'x' })
    state = openFilesTab(state, { id: 'files-1' }) // files-1 is the active tab
    const nonChatBefore = state.tabs.filter(t => t.kind !== 'chat')
    state = reconcileWorkspaceChatTab(state, { agentRef: 'a', chatId: 'c1', title: 'Hi' }, 'gen')
    const nonChatAfter = state.tabs.filter(t => t.kind !== 'chat')
    expect(nonChatAfter).toEqual(nonChatBefore)
    // NOTE: reconcile/openChat currently re-home focus to the chat tab even from
    // a non-chat active tab (ported from chatViewTabs). Slice 04 (drawer) will
    // revisit whether the drawer needs its own chat pointer distinct from
    // activeTabId.
    expect(state.activeTabId).toBe('gen')
    expect(activeWorkspaceTab(state)?.kind).toBe('chat')
  })
})
