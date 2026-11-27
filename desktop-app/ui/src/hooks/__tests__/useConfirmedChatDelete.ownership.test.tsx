// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatDeleteOutcome, QueuedChatDelete } from '@contexts/AgentChatActionsContext'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useConfirmedChatDelete } from '../useConfirmedChatDelete'

const actions = vi.hoisted(() => ({
  captureChatDeleteFence: vi.fn(),
  handleDeleteChatForAgent: vi.fn(),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({ useAgentChatActionsContext: () => actions }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

// Copied from the header test's captured-fence contract fixture.
const deletion: QueuedChatDelete = {
  agentRef: 'alpha',
  fence: {
    version: 1,
    authorityScope: {
      environmentKey: 'fixture-environment',
      userId: 'fixture-user',
      teamId: 'fixture-team',
    },
    bindingGeneration: 1,
    sessionGeneration: 1,
  },
  hostAuthorityEpoch: 1,
}
const target = (id: string) => ({ agentRef: 'alpha', chatId: id, title: id })

it.each(['deleted', 'stale-authority', 'retryable-failure'] as const)(
  'late %s cannot dismiss a newer request',
  async outcome => {
    actions.captureChatDeleteFence.mockResolvedValue(deletion)
    let finish!: (value: ChatDeleteOutcome) => void
    actions.handleDeleteChatForAgent.mockImplementation(
      () =>
        new Promise<ChatDeleteOutcome>(resolve => {
          finish = resolve
        })
    )
    const hook = renderHook(() => useConfirmedChatDelete())
    await act(async () => {
      await hook.result.current.request(target('A'))
    })
    let confirmation!: Promise<void>
    act(() => {
      confirmation = hook.result.current.confirm()
    })
    await act(async () => {
      await hook.result.current.request(target('B'))
    })
    await act(async () => {
      finish(outcome)
      await confirmation
    })
    expect(actions.handleDeleteChatForAgent).toHaveBeenCalledWith('alpha', 'A', deletion)
    expect(hook.result.current.pending?.chatId).toBe('B')
  }
)

it('cancelling a pending capture prevents it from opening a confirmation', async () => {
  let finish!: (value: QueuedChatDelete) => void
  actions.captureChatDeleteFence.mockImplementation(
    () =>
      new Promise<QueuedChatDelete>(resolve => {
        finish = resolve
      })
  )
  const hook = renderHook(() => useConfirmedChatDelete())
  let request!: Promise<void>
  act(() => {
    request = hook.result.current.request(target('A'))
  })
  act(() => hook.result.current.cancel())
  await act(async () => {
    finish(deletion)
    await request
  })
  expect(actions.captureChatDeleteFence).toHaveBeenCalledWith('alpha')
  expect(hook.result.current.pending).toBeNull()
  expect(actions.handleDeleteChatForAgent).not.toHaveBeenCalled()
})
