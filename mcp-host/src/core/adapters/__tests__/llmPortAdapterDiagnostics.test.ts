import { describe, expect, it, vi } from 'vitest'
import { SingleTurnProvider } from '../../../llm'
import { LlmError, LlmErrorCode } from '../../errors'
import { LlmPortAdapter } from '../llmPortAdapter'

describe('LlmPortAdapter diagnostics', () => {
  it('does not copy raw cause messages into provider diagnostics logs', async () => {
    const cause = new Error('upstream payload included Bearer sk-live-secret')
    const originalError = new Error('Connection error.', { cause })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue(originalError),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn().mockReturnValue({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'Connection error.',
      }),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    await expect(adapter.complete({ messages: [] })).rejects.toBeInstanceOf(LlmError)

    const logText = logSpy.mock.calls.flat().join('\n')
    expect(logText).not.toContain('sk-live-secret')
    expect(logText).not.toContain('upstream payload included')
    logSpy.mockRestore()
  })

  it('redacts bearer-like secrets from provider diagnostic fields', async () => {
    const secretPrefix = 's' + 'k'
    const secretishCode = [secretPrefix, 'live', 'diagnostic', 'code'].join('-')
    const secretishCauseCode = [secretPrefix, 'live', 'diagnostic', 'cause'].join('-')
    const cause = Object.assign(new Error('cause hidden'), {
      name: 'FetchError',
      code: ['Bearer', secretishCauseCode].join(' '),
    })
    const originalError = Object.assign(new Error('Connection error.', { cause }), {
      name: 'APIConnectionError',
      code: secretishCode,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue(originalError),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn().mockReturnValue({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'Connection error.',
      }),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    await expect(adapter.complete({ messages: [] })).rejects.toBeInstanceOf(LlmError)

    const logText = logSpy.mock.calls.flat().join('\n')
    expect(logText).not.toContain(secretishCode)
    expect(logText).not.toContain(secretishCauseCode)
    expect(logText).toContain(`${secretPrefix}-[redacted]`)
    logSpy.mockRestore()
  })
})
