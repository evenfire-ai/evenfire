import { describe, expect, it } from 'vitest'
import {
  activeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  openFilesTab,
  prepareNewChatWorkspaceTab,
} from '../workspaceTabs'

describe('prepareNewChatWorkspaceTab', () => {
  it('reuses the drawer blank-chat owner without changing the active Files tab', () => {
    const state = openFilesTab(createWorkspaceTabsState('seed-chat'), {
      id: 'files-root',
      path: null,
    })

    const prepared = prepareNewChatWorkspaceTab(state, 'unused-chat-id', 'agent-a', true)

    expect(prepared.tabId).toBe('seed-chat')
    expect(prepared.state.activeTabId).toBe('files-root')
    expect(activeWorkspaceTab(prepared.state)?.kind).toBe('files')
    expect(prepared.state.tabs.find(tab => tab.id === prepared.tabId)?.chat).toEqual({
      agentRef: 'agent-a',
      chatId: null,
    })
  })

  it('reserves a blank drawer destination when none exists and preserves the active tab', () => {
    const state = openFilesTab(createEmptyWorkspaceTabsState(), {
      id: 'files-root',
      path: null,
    })

    const prepared = prepareNewChatWorkspaceTab(state, 'chat-owner', null, true)

    expect(prepared.tabId).toBe('chat-owner')
    expect(prepared.state.activeTabId).toBe('files-root')
    expect(prepared.state.tabs.find(tab => tab.id === prepared.tabId)).toMatchObject({
      kind: 'chat',
      chat: { agentRef: null, chatId: null },
    })
  })

  it('activates the exact destination in full-page mode', () => {
    const state = openFilesTab(createWorkspaceTabsState('seed-chat'), {
      id: 'files-root',
      path: null,
    })

    const prepared = prepareNewChatWorkspaceTab(state, 'chat-owner', 'agent-a')

    expect(prepared.state.activeTabId).toBe(prepared.tabId)
    expect(activeWorkspaceTab(prepared.state)?.id).toBe(prepared.tabId)
    expect(activeWorkspaceTab(prepared.state)?.chat?.agentRef).toBe('agent-a')
  })
})
