import { describe, expect, it, vi } from 'vitest'
import { dispatchMcpHostRuntime } from './runtimeDispatch'

describe('dispatchMcpHostRuntime', () => {
  it.each([
    ['standalone', 'standalone'],
    ['workflow', 'workflow'],
    ['sdk-only', 'sdkOnly'],
  ] as const)('dispatches %s to exactly its own startup branch', async (kind, expected) => {
    const starters = {
      standalone: vi.fn().mockResolvedValue(undefined),
      workflow: vi.fn().mockResolvedValue(undefined),
      sdkOnly: vi.fn().mockResolvedValue(undefined),
    }
    await dispatchMcpHostRuntime(kind, starters)
    expect(starters[expected]).toHaveBeenCalledTimes(1)
    for (const [name, starter] of Object.entries(starters)) {
      if (name !== expected) expect(starter).not.toHaveBeenCalled()
    }
  })
})
