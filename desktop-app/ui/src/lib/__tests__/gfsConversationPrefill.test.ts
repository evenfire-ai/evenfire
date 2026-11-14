import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  clearComposerDraft,
  clearDeletedChatComposerDraft,
  getComposerDraft,
  resetComposerDraftStore,
  setAutomaticComposerDraft,
  setComposerDraft,
} from '../composerDraftStore'
import {
  clearLatestGfsConversationContext,
  getLatestGfsConversationContext,
  prefillEmptyConversationWithGfsResource,
  prefillNewConversationWithGfsResource,
  recordLatestGfsConversationContext,
} from '../gfsConversationPrefill'
import { decidePersistedConversationPrefill } from '../persistedConversationPrefillDecision'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  openFilesTab,
  openPreviewTab,
} from '../workspaceTabs'
import type { WorkspaceTab } from '../workspaceTabs.types'

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
const destinationTabId = 'chat-destination'

function requireGfsTab(tab: WorkspaceTab | null | undefined): WorkspaceTab {
  if (!tab) throw new Error('Expected a visible GFS context tab')
  return tab
}

afterEach(() => {
  resetComposerDraftStore()
  clearLatestGfsConversationContext()
})

describe('clearDeletedChatComposerDraft', () => {
  it('clears the matching deleted origin and preserves another authority scope', () => {
    const destination = {
      authorityScope: 'scope-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      workspaceChatTabId: 'tab-a',
    }
    expect(setAutomaticComposerDraft(destination, uri)).toBe(true)

    expect(clearDeletedChatComposerDraft('chat-a', 'agent-a', 'scope-b')).toBe(false)
    expect(getComposerDraft('chat-a', 'agent-a', 'tab-a', 'scope-a')).toBe(uri)

    expect(clearDeletedChatComposerDraft('chat-a', 'agent-a', 'scope-a')).toBe(true)
    expect(getComposerDraft('chat-a', 'agent-a', 'tab-a', 'scope-a')).toBe('')
  })

  it('clears ordinary deleted-chat text when the legacy caller has no scope', () => {
    setComposerDraft('chat-a', 'ordinary draft', 'agent-a')

    expect(clearDeletedChatComposerDraft('chat-a', 'agent-a', '')).toBe(true)
    expect(getComposerDraft('chat-a', 'agent-a')).toBe('')
  })

  it('keeps automatic bytes when the deleted-chat caller has no scope', () => {
    const destination = {
      authorityScope: 'scope-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      workspaceChatTabId: 'tab-a',
    }
    expect(setAutomaticComposerDraft(destination, uri)).toBe(true)

    expect(clearDeletedChatComposerDraft('chat-a', 'agent-a', '')).toBe(false)
    expect(getComposerDraft('chat-a', 'agent-a', 'tab-a', 'scope-a')).toBe(uri)
  })
})

describe('persisted conversation prefill decision', () => {
  it('preserves nonempty visible input and its projected draft', () => {
    expect(
      decidePersistedConversationPrefill({
        eventId: 1,
        currentEventId: 1,
        authorityScope: 'scope-a',
        currentAuthorityScope: 'scope-a',
        agentRef: 'agent-a',
        currentAgentRef: 'agent-a',
        chatId: 'chat-a',
        currentChatId: 'chat-a',
        workspaceChatTabId: 'tab-a',
        currentWorkspaceChatTabId: 'tab-a',
        resourceUri: uri,
        currentResourceUri: uri,
        resourceOwnerId: 'files-a',
        currentResourceOwnerId: 'files-a',
        inputIsVisible: true,
        inputText: '  keep this text  ',
        projectedDraft: '  keep this text  ',
        deletePending: false,
      })
    ).toBe('preserve-input')
  })
})

describe('prefillNewConversationWithGfsResource', () => {
  it('prefills a new chat from the active folder route', async () => {
    const folder = await resolveResource(
      resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
    )
    const tab = requireGfsTab(
      activeWorkspaceTab(
        openFilesTab(createWorkspaceTabsState('chat-tab'), {
          id: 'files-tab',
          path: folder.gfsUri,
        })
      )
    )
    expect(prefillNewConversationWithGfsResource(tab, 'agent-1', destinationTabId)).toBe(true)
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe(folder.gfsUri)
  })

  it('does not append or replace the resource when the same new-chat prefill repeats', async () => {
    const folder = await resolveResource(
      resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
    )
    const tab = requireGfsTab(
      activeWorkspaceTab(
        openFilesTab(createWorkspaceTabsState('chat-tab'), {
          id: 'files-tab',
          path: folder.gfsUri,
        })
      )
    )

    expect(prefillNewConversationWithGfsResource(tab, 'agent-1', destinationTabId)).toBe(true)
    expect(prefillNewConversationWithGfsResource(tab, 'agent-1', destinationTabId)).toBe(false)
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe(folder.gfsUri)

    setComposerDraft(null, 'existing draft', 'agent-1', destinationTabId)
    expect(prefillNewConversationWithGfsResource(tab, 'agent-1', destinationTabId)).toBe(false)
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe('existing draft')
  })

  it('does not carry a previous Files context into a new chat opened from Chat', async () => {
    const folder = await resolveResource(
      resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
    )
    const filesTab = requireGfsTab(
      activeWorkspaceTab(
        openFilesTab(createWorkspaceTabsState('chat-tab'), {
          id: 'files-tab',
          path: folder.gfsUri,
        })
      )
    )
    const chatTab: WorkspaceTab = {
      id: 'chat-tab',
      kind: 'chat',
      title: 'Chat',
      chat: { agentRef: 'agent-1', chatId: null },
    }

    expect(prefillNewConversationWithGfsResource(filesTab, 'agent-1', destinationTabId)).toBe(true)
    clearComposerDraft(null, 'agent-1', destinationTabId)
    expect(prefillNewConversationWithGfsResource(chatTab, 'agent-1', destinationTabId)).toBe(false)
    expect(getComposerDraft(null, 'agent-1')).toBe('')
  })

  it('keeps a resource prefill pending until ChatPage selects an agent', async () => {
    const folder = await resolveResource(
      resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
    )
    const tab = requireGfsTab(
      activeWorkspaceTab(
        openFilesTab(createWorkspaceTabsState('chat-tab'), {
          id: 'files-tab',
          path: folder.gfsUri,
        })
      )
    )

    expect(prefillNewConversationWithGfsResource(tab, null, destinationTabId)).toBe(true)
    expect(getComposerDraft(null, undefined, destinationTabId)).toBe(folder.gfsUri)
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe(folder.gfsUri)

    expect(prefillNewConversationWithGfsResource(tab, null, destinationTabId)).toBe(false)
    expect(getComposerDraft(null, undefined, destinationTabId)).toBe(folder.gfsUri)
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe(folder.gfsUri)
    expect(getComposerDraft(null, 'agent-1', 'different-chat')).toBe('')
  })

  it('prefills a new chat from the active file route', async () => {
    const file = await resolveResource(
      resolvedFile('abcdefabcdefabcdefabcdefabcdefab', 'Quarterly report.md')
    )
    const tab = requireGfsTab(
      activeWorkspaceTab(
        openFilesTab(createWorkspaceTabsState('chat-tab'), {
          id: 'files-tab',
          path: file.gfsUri,
        })
      )
    )
    expect(prefillNewConversationWithGfsResource(tab, 'agent-1', destinationTabId)).toBe(true)
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe(file.gfsUri)
  })

  it('prefills a new chat from an active file preview tab', async () => {
    const file = await resolveResource(
      resolvedFile('abcdefabcdefabcdefabcdefabcdefab', 'README.md')
    )
    const tab = requireGfsTab(
      activeWorkspaceTab(
        openPreviewTab(createWorkspaceTabsState('chat-tab'), {
          id: 'preview-tab',
          title: 'README.md',
          gfsUri: file.gfsUri,
          fileKind: 'markdown',
          byteLength: 4,
        })
      )
    )
    expect(prefillNewConversationWithGfsResource(tab, 'agent-1', destinationTabId)).toBe(true)
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe(file.gfsUri)
  })

  it('keeps a legacy draft beside a valid Files prefill and ignores root or chat tabs', () => {
    setComposerDraft(null, 'keep this draft', 'agent-1')
    const visibleTab = requireGfsTab(
      activeWorkspaceTab(
        openFilesTab(createWorkspaceTabsState('chat-tab'), { id: 'files', path: uri })
      )
    )

    expect(prefillNewConversationWithGfsResource(visibleTab, 'agent-1', destinationTabId)).toBe(
      true
    )
    expect(getComposerDraft(null, 'agent-1', destinationTabId)).toBe(uri)
    expect(getComposerDraft(null, 'agent-1')).toBe('keep this draft')
    expect(
      prefillNewConversationWithGfsResource(
        { id: 'root', kind: 'files', title: 'Files', files: { path: null } },
        'agent-1',
        destinationTabId
      )
    ).toBe(false)
    expect(
      prefillNewConversationWithGfsResource(
        { id: 'chat', kind: 'chat', title: 'Chat', chat: { agentRef: 'agent-1', chatId: null } },
        'agent-1',
        destinationTabId
      )
    ).toBe(false)
  })

  it('fails closed for malformed resource routes', () => {
    expect(
      prefillNewConversationWithGfsResource(
        {
          id: 'files',
          kind: 'files',
          title: 'Files',
          files: { path: 'gfs://main/../../private' },
        },
        null,
        destinationTabId
      )
    ).toBe(false)
  })

  it('prefills a persisted chat once from its exact visible GFS context', async () => {
    const file = await resolveResource(
      resolvedFile('abcdefabcdefabcdefabcdefabcdefab', 'Quarterly report.md')
    )
    const tab = activeWorkspaceTab(
      openFilesTab(createWorkspaceTabsState('chat-tab'), {
        id: 'files-tab',
        path: file.gfsUri,
      })
    )
    if (!tab) throw new Error('Expected the Files context tab to be active')
    recordLatestGfsConversationContext(tab, false, 'scope-a')

    const context = getLatestGfsConversationContext()
    expect(context).toMatchObject({ uri: file.gfsUri, sourceTabId: 'files-tab' })
    const destination = {
      authorityScope: 'scope-a',
      agentRef: 'agent-1',
      chatId: 'chat-1',
      workspaceChatTabId: 'chat-tab',
    }
    expect(prefillEmptyConversationWithGfsResource('chat-1', 'agent-1', context, destination)).toBe(
      true
    )
    expect(getComposerDraft('chat-1', 'agent-1', 'chat-tab', 'scope-a')).toBe(file.gfsUri)
    expect(getComposerDraft('chat-1', 'agent-1', 'chat-tab', 'scope-b')).toBe('')
    expect(prefillEmptyConversationWithGfsResource('chat-1', 'agent-1', context, destination)).toBe(
      false
    )
  })

  it('preserves whitespace and does not restore a cleared prefill on refocus', async () => {
    const folder = await resolveResource(
      resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
    )
    const tab = activeWorkspaceTab(
      openFilesTab(createWorkspaceTabsState('chat-tab'), {
        id: 'files-tab',
        path: folder.gfsUri,
      })
    )
    if (!tab) throw new Error('Expected the Files context tab to be active')
    recordLatestGfsConversationContext(tab, false, 'scope-a')
    setComposerDraft('chat-1', '   ', 'agent-1')

    expect(
      prefillEmptyConversationWithGfsResource(
        'chat-1',
        'agent-1',
        getLatestGfsConversationContext(),
        {
          authorityScope: 'scope-a',
          agentRef: 'agent-1',
          chatId: 'chat-1',
          workspaceChatTabId: 'chat-tab',
        }
      )
    ).toBe(false)
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('   ')

    clearComposerDraft('chat-1', 'agent-1')
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('')
  })
})
