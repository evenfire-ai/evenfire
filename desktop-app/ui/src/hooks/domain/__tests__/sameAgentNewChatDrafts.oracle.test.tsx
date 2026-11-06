// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { ChatComposerStateProvider } from '@contexts/ChatComposerStateContext'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useComposerDraft } from '@hooks/useComposerDraft'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  newChatTab,
  openFilesTab,
} from '@lib/workspaceTabs'

function ComposerProbe({ workspaceTabId }: { workspaceTabId: string }) {
  const [draft, setDraft, ownerConflictTabId] = useComposerDraft(null, 'agent-same')
  return (
    <>
      <label>
        Draft for {workspaceTabId}
        <textarea
          aria-label={`Draft for ${workspaceTabId}`}
          onChange={event => setDraft(event.currentTarget.value)}
          value={draft}
        />
      </label>
      <output data-testid="draft-owner-conflict">{ownerConflictTabId ?? 'none'}</output>
    </>
  )
}

function renderComposer(workspaceTabId: string) {
  return render(
    <ChatComposerStateProvider
      value={{
        activeChatId: null,
        workspaceChatTabId: workspaceTabId,
        composerImageAttachments: [],
        composerFileAttachments: [],
        composerFileRefusals: [],
        composerReferenceAttachments: [],
        agentSending: false,
        agentError: null,
        failedAgentSend: null,
        activeMessageCount: 0,
        composerFocusRequestId: 0,
        requestComposerFocus: () => undefined,
      }}
    >
      <ComposerProbe workspaceTabId={workspaceTabId} />
    </ChatComposerStateProvider>
  )
}

describe('owner-directed same-agent New Chat draft ownership oracle', () => {
  afterEach(() => {
    cleanup()
    resetComposerDraftStore()
  })

  it('creates two same-agent New Chat tabs and preserves independently typed drafts on switch', () => {
    let workspace = newChatTab(createWorkspaceTabsState('chat-a'), 'chat-a', 'agent-same')
    workspace = openFilesTab(workspace, { id: 'files-between' })
    workspace = newChatTab(workspace, 'chat-b', 'agent-same')

    const tabA = workspace.tabs.find(tab => tab.id === 'chat-a')
    const tabB = activeWorkspaceTab(workspace)
    expect(tabA?.kind).toBe('chat')
    expect(tabB?.kind).toBe('chat')
    if (tabA?.kind !== 'chat' || tabB?.kind !== 'chat') {
      throw new Error('workspace producer did not create two chat tabs')
    }
    expect(tabA.chat).toEqual({ agentRef: 'agent-same', chatId: null })
    expect(tabB.chat).toEqual({ agentRef: 'agent-same', chatId: null })

    const first = renderComposer(tabA.id)
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft for chat-a' }), {
      target: { value: 'draft owned by A' },
    })
    expect(
      (screen.getByRole('textbox', { name: 'Draft for chat-a' }) as HTMLTextAreaElement).value
    ).toBe('draft owned by A')
    first.unmount()

    const second = renderComposer(tabB.id)
    const draftB = screen.getByRole('textbox', { name: 'Draft for chat-b' })
    expect((draftB as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(draftB, { target: { value: 'draft owned by B' } })
    expect((draftB as HTMLTextAreaElement).value).toBe('draft owned by B')
    second.unmount()

    const restoredB = renderComposer(tabB.id)
    expect(
      (screen.getByRole('textbox', { name: 'Draft for chat-b' }) as HTMLTextAreaElement).value
    ).toBe('draft owned by B')
    restoredB.unmount()

    renderComposer(tabA.id)
    expect(
      (screen.getByRole('textbox', { name: 'Draft for chat-a' }) as HTMLTextAreaElement).value
    ).toBe('draft owned by A')
  })
})
