// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useComposerDraft } from '@hooks/useComposerDraft'
import { activeWorkspaceTab, createWorkspaceTabsState } from '@lib/workspaceTabs'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

function PersistedChatComposer({
  chatId,
  workspaceTabId,
  onSend,
}: {
  chatId: string
  workspaceTabId: string
  onSend: (text: string) => Promise<void>
}) {
  const [draft, setDraft] = useComposerDraft(chatId, 'agent-x', workspaceTabId)
  return (
    <label>
      Existing chat composer
      <textarea
        aria-label="Existing chat composer"
        onChange={event => setDraft(event.currentTarget.value)}
        value={draft}
      />
      <button type="button" onClick={() => void onSend(draft)}>
        Send current draft
      </button>
    </label>
  )
}

describe('persisted-chat draft revision ownership', () => {
  it('preserves text typed while the outgoing turn is being persisted', async () => {
    clerum = installMockClerum()
    const tab = activeWorkspaceTab(createWorkspaceTabsState('workspace-chat-tab', 'agent-x'))
    if (tab?.kind !== 'chat') throw new Error('expected a production-created workspace Chat tab')

    const controller = renderController()
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await act(async () => controller.result.current.handleCreateChat())
    await waitFor(() => expect(controller.result.current.activeChatId).toBeTruthy())

    const chatId = controller.result.current.activeChatId!
    expect(await clerum.persistedMessages('agent-x', chatId)).toEqual([])
    render(
      <PersistedChatComposer
        chatId={chatId}
        onSend={text => controller.result.current.handleSendAgentMessage(text, tab.id)}
        workspaceTabId={tab.id}
      />
    )

    const composer = screen.getByRole('textbox', { name: 'Existing chat composer' })
    fireEvent.change(composer, { target: { value: 'message already submitted' } })

    const persistOutgoing = clerum.chat.upsertMessages.getMockImplementation()
    if (!persistOutgoing) throw new Error('expected the real ChatStore upsert producer')
    let finishPersistence!: () => void
    const persistence = new Promise<void>(resolve => {
      finishPersistence = resolve
    })
    clerum.chat.upsertMessages.mockImplementationOnce(async (agentRef, id, messages) => {
      await persistence
      await persistOutgoing(agentRef, id, messages)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send current draft' }))
    await waitFor(() => expect(clerum.chat.upsertMessages).toHaveBeenCalledOnce())
    fireEvent.change(composer, { target: { value: 'new text typed during persistence' } })
    expect((composer as HTMLTextAreaElement).value).toBe('new text typed during persistence')

    await act(async () => finishPersistence())
    await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledOnce())

    expect((composer as HTMLTextAreaElement).value).toBe('new text typed during persistence')
    expect(await clerum.persistedMessages('agent-x', chatId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'message already submitted' }),
      ])
    )
  })
})
