// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import fc from 'fast-check'
import { DESKTOP_ROUTES } from '../../../constants/navigation'
import { resolveGfsPreview } from '../../../lib/gfsPreview'
import {
  activeWorkspaceTab,
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  openAppTab,
  openChatTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  selectWorkspaceTabAt,
} from '../../../lib/workspaceTabs'
import type { SettingsSection, WorkspaceTabsState } from '../../../lib/workspaceTabs.types'
import { useNavigationController } from '../useNavigationController'

// App activates app tabs only through its activation seam, which commits the
// tab and its launch together. The navigation controller writes the same store
// from sidebar navigation and chat selection, outside that seam, so none of its
// writers may ever move the active tab onto an app tab — whatever the store
// holds when they run.

type Seed =
  | { op: 'app'; appRef: string }
  | { op: 'chat'; agentRef: string; chatId: string | null }
  | { op: 'files'; path: string | null }
  | { op: 'settings'; section: SettingsSection }
  | { op: 'preview'; name: string }
  | { op: 'select'; index: number }
  | { op: 'close'; index: number }

type NavOp =
  | { op: 'nav'; route: (typeof DESKTOP_ROUTES)[keyof typeof DESKTOP_ROUTES] }
  | { op: 'activateChat'; agentRef: string | null; chatId: string | null }
  | { op: 'files'; path: string | null }
  | { op: 'preview'; name: string }

const agentRef = fc.constantFrom('agent-a', 'agent-b')
const chatId = fc.option(fc.constantFrom('chat-1', 'chat-2'), { nil: null })
const filesPath = fc.option(fc.constantFrom('gfs://main/a', 'gfs://main/b'), { nil: null })
const previewName = fc.constantFrom('README.md', 'notes.md')

const appSeed = fc.record({
  op: fc.constant('app' as const),
  appRef: fc.constantFrom('ns/alpha', 'ns/beta'),
})
const selectSeed = fc.record({ op: fc.constant('select' as const), index: fc.nat({ max: 8 }) })

// Chat seeds are rare on purpose: a chat ever made active becomes the chat the
// controller resumes, which hides any fallback that could pick another tab.
const seedArb: fc.Arbitrary<Seed> = fc.oneof(
  { weight: 3, arbitrary: appSeed },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('chat' as const), agentRef, chatId }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('files' as const), path: filesPath }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('settings' as const),
      section: fc.constantFrom<SettingsSection>('connectors', 'agents', 'plugins', 'settings'),
    }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('preview' as const), name: previewName }) },
  { weight: 2, arbitrary: selectSeed },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant('close' as const), index: fc.nat({ max: 8 }) }),
  }
)

// The dangerous shape: an app tab last in the strip but not active, reached by
// re-selecting an earlier tab after it was opened.
const seedsArb: fc.Arbitrary<Seed[]> = fc.oneof(
  { weight: 1, arbitrary: fc.array(seedArb, { maxLength: 8 }) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.array(seedArb, { maxLength: 6 }), appSeed, selectSeed)
      .map(([prefix, app, select]) => [...prefix, app, select]),
  }
)

const navOpArb: fc.Arbitrary<NavOp> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ op: 'nav' as const, route: DESKTOP_ROUTES.chat }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('nav' as const),
      route: fc.constantFrom(...Object.values(DESKTOP_ROUTES)),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('activateChat' as const),
      agentRef: fc.option(agentRef, { nil: null }),
      chatId,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant('files' as const), path: filesPath }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant('preview' as const), name: previewName }),
  }
)

function preview(name: string) {
  return resolveGfsPreview({ gfsUri: `gfs://main/${name}`, name, bytes: 10 })!
}

// Seeds use their own id prefix so they never collide with the controller's
// `ws-tab-N` sequence. Starting empty (or closing the boot chat) matters: while
// the boot chat survives it is always the chat the controller resumes.
function buildSeed(fromEmpty: boolean, seeds: Seed[]): WorkspaceTabsState {
  return seeds.reduce<WorkspaceTabsState>(
    (state, seed, index) => {
      const id = `seed-${index}`
      switch (seed.op) {
        case 'app':
          return openAppTab(state, { id, appRef: seed.appRef, title: seed.appRef })
        case 'chat':
          return openChatTab(state, { id, agentRef: seed.agentRef, chatId: seed.chatId })
        case 'files':
          return openFilesTab(state, { id, path: seed.path })
        case 'settings':
          return openSettingsTab(state, { id, section: seed.section })
        case 'preview': {
          const resource = preview(seed.name)
          return openPreviewTab(state, {
            id,
            title: resource.name,
            gfsUri: resource.gfsUri,
            fileKind: resource.kind,
            byteLength: resource.bytes,
          })
        }
        case 'select':
          return selectWorkspaceTabAt(state, seed.index)
        case 'close': {
          const target = state.tabs[seed.index]
          return target ? closeWorkspaceTab(state, target.id) : state
        }
      }
    },
    fromEmpty ? createEmptyWorkspaceTabsState() : createWorkspaceTabsState('chat-tab-1')
  )
}

describe('useNavigationController never activates an app tab', () => {
  it('does not advance navigation intent when the caller already started it', () => {
    const { result, unmount } = renderHook(() => useNavigationController())
    try {
      const intentBeforeActivation = result.current.navigationIntentSequence
      act(() => result.current.activateChatTab('agent-a', 'chat-1', undefined, true))
      expect(result.current.navigationIntentSequence).toBe(intentBeforeActivation)
      expect(activeWorkspaceTab(result.current.workspaceTabs)).toMatchObject({
        kind: 'chat',
        chat: { agentRef: 'agent-a', chatId: 'chat-1' },
      })
    } finally {
      unmount()
    }
  })

  it('keeps every navigation writer off app tabs, from any store state', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          { weight: 3, arbitrary: fc.constant(true) },
          { weight: 1, arbitrary: fc.constant(false) }
        ),
        seedsArb,
        fc.array(navOpArb, { minLength: 1, maxLength: 8 }),
        (fromEmpty, seeds, ops) => {
          const { result, unmount } = renderHook(() => useNavigationController())
          try {
            act(() => result.current.setWorkspaceTabs(buildSeed(fromEmpty, seeds)))
            for (const op of ops) {
              const before = result.current.workspaceTabs.activeTabId
              act(() => {
                if (op.op === 'nav') result.current.handleNavSelect(op.route)
                else if (op.op === 'activateChat')
                  result.current.activateChatTab(op.agentRef, op.chatId)
                else if (op.op === 'files') result.current.openFilesSection(op.path)
                else result.current.openPreviewSection(preview(op.name))
              })
              const after = result.current.workspaceTabs
              if (after.activeTabId !== before) {
                expect(activeWorkspaceTab(after)?.kind).not.toBe('app')
              }
            }
          } finally {
            unmount()
          }
        }
      ),
      {
        numRuns: 300,
        // No chat ever active, a non-chat tab active and an app tab last:
        // navigating to chat has no chat to resume or fall back to.
        examples: [
          [
            true,
            [
              { op: 'files', path: null },
              { op: 'app', appRef: 'ns/alpha' },
              { op: 'select', index: 0 },
            ],
            [{ op: 'nav', route: DESKTOP_ROUTES.chat }],
          ],
        ],
      }
    )
  })
})
