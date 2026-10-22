// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
  setResourceComposerPrefill,
} from '@lib/composerDraftStore'
import { prefillNewConversationWithGfsResource } from '@lib/gfsConversationPrefill'
import { createWorkspaceTabsState, openFilesTab } from '@lib/workspaceTabs'
import type { WorkspaceTab } from '@lib/workspaceTabs.types'
import { resolveResource, resolvedDirectory } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { useComposerDraft } from '../useComposerDraft'

const draftSurfaceHarness: {
  setDraft: ((value: string) => { accepted: boolean }) | null
} = { setDraft: null }

afterEach(() => {
  cleanup()
  resetComposerDraftStore()
  draftSurfaceHarness.setDraft = null
  vi.restoreAllMocks()
})

function DraftSurface({
  tabId,
  agentRef,
  chatId = null,
}: {
  tabId: string | null
  agentRef: string
  chatId?: string | null
}) {
  const [draft, setDraft, ownerConflictTabId] = useComposerDraft(chatId, agentRef, tabId)
  draftSurfaceHarness.setDraft = setDraft
  return (
    <label>
      {tabId ?? 'legacy'}
      <textarea
        aria-label={`${tabId ?? 'legacy'} composer`}
        data-chat-tab-id={tabId ?? ''}
        disabled={Boolean(ownerConflictTabId)}
        onChange={event => setDraft(event.currentTarget.value)}
        value={draft}
      />
      {ownerConflictTabId ? <span role="alert">Another workspace tab owns this draft.</span> : null}
    </label>
  )
}

function SelectedChatHarness() {
  const [selectedTabId, setSelectedTabId] = useState('chat-b')
  const tabs = [
    { id: 'chat-a', label: 'Chat A', agentRef: 'agent-a' },
    { id: 'chat-b', label: 'Chat B', agentRef: 'agent-b' },
  ]
  const selectedTab = tabs.find(tab => tab.id === selectedTabId)!
  return (
    <section>
      <nav aria-label="Workspace chats">
        {tabs.map(tab => (
          <button
            aria-pressed={selectedTabId === tab.id}
            key={tab.id}
            onClick={() => setSelectedTabId(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <DraftSurface tabId={selectedTab.id} agentRef={selectedTab.agentRef} />
    </section>
  )
}

describe('tab-owned GFS composer prefill', () => {
  it('refreshes legacy owner feedback when a same-key tab prefill arrives unchanged', () => {
    const uri = `gfs://main/${'f'.repeat(32)}`
    setComposerDraft(null, uri, 'agent-a')
    render(<DraftSurface tabId={null} agentRef="agent-a" />)

    const textarea = screen.getByRole('textbox', { name: 'legacy composer' }) as HTMLTextAreaElement
    expect(textarea.value).toBe(uri)
    expect(textarea.disabled).toBe(false)

    act(() => {
      expect(setResourceComposerPrefill('owner-tab', uri, 'agent-a')).toBe(true)
    })

    expect(textarea.disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Another workspace tab owns this draft')
    expect(getComposerDraft(null, 'agent-a')).toBe(uri)
    expect(getComposerDraft(null, 'agent-a', 'owner-tab')).toBe(uri)
  })

  it('keeps a rejected keystroke visible if ownership changes before the write', () => {
    render(<DraftSurface tabId="other-tab" agentRef="agent-a" />)
    const uri = `gfs://main/${'e'.repeat(32)}`
    let accepted: { accepted: boolean } | undefined

    act(() => {
      expect(setResourceComposerPrefill('owner-tab', uri, 'agent-a')).toBe(true)
      accepted = draftSurfaceHarness.setDraft?.('typed during owner change')
    })

    expect(accepted?.accepted).toBe(false)
    expect(
      (screen.getByRole('textbox', { name: 'other-tab composer' }) as HTMLTextAreaElement).value
    ).toBe('typed during owner change')
    expect(
      (screen.getByRole('textbox', { name: 'other-tab composer' }) as HTMLTextAreaElement).disabled
    ).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Another workspace tab owns this draft')
    expect(getComposerDraft(null, 'agent-a', 'owner-tab')).toBe(uri)
  })

  it('does not let another selected chat claim a pending Files resource prefill', async () => {
    const resource = await resolveResource(
      resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
    )
    const sourceTab = openFilesTab(createWorkspaceTabsState('seed-chat'), {
      id: 'files-source',
      path: resource.gfsUri,
    }).tabs.find(tab => tab.id === 'files-source') as WorkspaceTab

    expect(prefillNewConversationWithGfsResource(sourceTab, null, 'chat-a')).toBe(true)
    render(<SelectedChatHarness />)

    const chatB = screen.getByRole('button', { name: 'Chat B' })
    expect(chatB.getAttribute('aria-pressed')).toBe('true')
    expect(
      (screen.getByRole('textbox', { name: 'chat-b composer' }) as HTMLTextAreaElement).value
    ).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Chat A' }))
    expect(screen.getByRole('button', { name: 'Chat A' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'chat-a composer' }) as HTMLTextAreaElement).value
      ).toBe(resource.gfsUri)
    )

    fireEvent.click(screen.getByRole('button', { name: 'Chat B' }))
    expect(screen.getByRole('button', { name: 'Chat B' }).getAttribute('aria-pressed')).toBe('true')
    expect(
      (screen.getByRole('textbox', { name: 'chat-b composer' }) as HTMLTextAreaElement).value
    ).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Chat A' }))
    expect(
      (screen.getByRole('textbox', { name: 'chat-a composer' }) as HTMLTextAreaElement).value
    ).toBe(resource.gfsUri)
  })

  it('notifies the exact destination composer when its resource prefill arrives later', async () => {
    const resource = await resolveResource(
      resolvedDirectory('abcdefabcdefabcdefabcdefabcdefab', 'Later folder')
    )
    const sourceTab = openFilesTab(createWorkspaceTabsState('seed-chat'), {
      id: 'files-source',
      path: resource.gfsUri,
    }).tabs.find(tab => tab.id === 'files-source') as WorkspaceTab
    const { rerender } = render(<DraftSurface tabId="chat-a" agentRef="agent-a" />)

    expect(prefillNewConversationWithGfsResource(sourceTab, 'agent-a', 'chat-a')).toBe(true)
    rerender(<DraftSurface tabId="chat-a" agentRef="agent-a" />)
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'chat-a composer' }) as HTMLTextAreaElement).value
      ).toBe(resource.gfsUri)
    )
  })

  it('cancels a pending prefill when its owner tab navigates to a persisted chat', async () => {
    const resource = await resolveResource(
      resolvedDirectory('fedcba9876543210fedcba9876543210', 'Superseded folder')
    )
    const sourceTab = openFilesTab(createWorkspaceTabsState('seed-chat'), {
      id: 'files-source',
      path: resource.gfsUri,
    }).tabs.find(tab => tab.id === 'files-source') as WorkspaceTab
    expect(prefillNewConversationWithGfsResource(sourceTab, null, 'chat-a')).toBe(true)

    const { rerender } = render(<DraftSurface tabId="chat-a" agentRef="" />)
    expect(
      (screen.getByRole('textbox', { name: 'chat-a composer' }) as HTMLTextAreaElement).value
    ).toBe(resource.gfsUri)

    rerender(<DraftSurface tabId="chat-a" agentRef="agent-a" chatId="persisted-chat" />)
    rerender(<DraftSurface tabId="chat-a" agentRef="agent-a" />)
    expect(
      (screen.getByRole('textbox', { name: 'chat-a composer' }) as HTMLTextAreaElement).value
    ).toBe('')
  })
})
