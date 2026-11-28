// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAgentChatActionsValue } from '../useAgentChatActionsValue'

afterEach(cleanup)

it('preserves deletion failure for confirmed-delete callers', async () => {
  const failure = new Error('storage unavailable')
  const handleDeleteChatForAgent = vi.fn(async () => {
    throw failure
  })
  const vm = { handleDeleteChatForAgent } as unknown as Parameters<
    typeof useAgentChatActionsValue
  >[0]
  const { result } = renderHook(() => useAgentChatActionsValue(vm))
  // Same captured-fence shape as the header confirmation fixture.
  const deletion: Parameters<typeof result.current.handleDeleteChatForAgent>[2] = {
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
  await expect(result.current.handleDeleteChatForAgent('alpha', 'one', deletion)).rejects.toBe(
    failure
  )
  expect(handleDeleteChatForAgent).toHaveBeenCalledTimes(1)
})
