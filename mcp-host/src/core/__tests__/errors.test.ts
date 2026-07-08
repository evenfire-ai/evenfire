import { describe, expect, it } from 'vitest'
import {
  AgentError,
  ConversationError,
  ConversationErrorCode,
  LlmError,
  LlmErrorCode,
  SafetyError,
  SafetyErrorCode,
  ToolError,
  ToolErrorCode,
} from '../errors'

describe('AgentError', () => {
  it('should be an instance of Error', () => {
    const err = new AgentError('test', 'TEST_CODE')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AgentError)
    expect(err.name).toBe('AgentError')
    expect(err.message).toBe('test')
    expect(err.code).toBe('TEST_CODE')
  })

  it('should preserve cause chain', () => {
    const cause = new Error('root cause')
    const err = new AgentError('wrapped', 'WRAP', cause)
    expect(err.cause).toBe(cause)
    expect((err.cause as Error).message).toBe('root cause')
  })
})

describe('LlmError', () => {
  it('should extend AgentError with provider field', () => {
    const err = new LlmError('API failed', 'openai', LlmErrorCode.ApiCallFailed, false)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.name).toBe('LlmError')
    expect(err.provider).toBe('openai')
    expect(err.code).toBe(LlmErrorCode.ApiCallFailed)
    expect(err.retryable).toBe(false)
  })

  it('should have all expected error codes', () => {
    expect(LlmErrorCode.ApiCallFailed).toBe('LLM_API_CALL_FAILED')
    expect(LlmErrorCode.InvalidResponse).toBe('LLM_INVALID_RESPONSE')
    expect(LlmErrorCode.ContextLengthExceeded).toBe('LLM_CONTEXT_LENGTH_EXCEEDED')
    expect(LlmErrorCode.ContentFiltered).toBe('LLM_CONTENT_FILTERED')
    expect(LlmErrorCode.ModelNotAvailable).toBe('LLM_MODEL_NOT_AVAILABLE')
  })

  it('should carry a retryable flag', () => {
    const err = new LlmError('rate limit', 'openai', LlmErrorCode.RateLimited, true)
    expect(err.retryable).toBe(true)
  })

  it('should have all new error codes', () => {
    expect(LlmErrorCode.InsufficientQuota).toBe('LLM_INSUFFICIENT_QUOTA')
    expect(LlmErrorCode.RateLimited).toBe('LLM_RATE_LIMITED')
    expect(LlmErrorCode.AuthenticationFailed).toBe('LLM_AUTHENTICATION_FAILED')
    expect(LlmErrorCode.ModelOverloaded).toBe('LLM_MODEL_OVERLOADED')
  })
})

describe('ToolError', () => {
  it('should extend AgentError with toolName field', () => {
    const err = new ToolError('Tool not found', 'mongodb__find', ToolErrorCode.NotFound)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toBeInstanceOf(ToolError)
    expect(err.name).toBe('ToolError')
    expect(err.toolName).toBe('mongodb__find')
    expect(err.code).toBe('TOOL_NOT_FOUND')
  })

  it('should have all expected error codes', () => {
    expect(ToolErrorCode.NotFound).toBe('TOOL_NOT_FOUND')
    expect(ToolErrorCode.ExecutionFailed).toBe('TOOL_EXECUTION_FAILED')
    expect(ToolErrorCode.Timeout).toBe('TOOL_TIMEOUT')
    expect(ToolErrorCode.InvalidParams).toBe('TOOL_INVALID_PARAMS')
    expect(ToolErrorCode.ApprovalDenied).toBe('TOOL_APPROVAL_DENIED')
  })
})

describe('SafetyError', () => {
  it('should extend AgentError', () => {
    const err = new SafetyError('blocked', SafetyErrorCode.InputBlocked)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toBeInstanceOf(SafetyError)
    expect(err.name).toBe('SafetyError')
    expect(err.code).toBe('SAFETY_INPUT_BLOCKED')
  })
})

describe('ConversationError', () => {
  it('should extend AgentError', () => {
    const err = new ConversationError('invalid transition', ConversationErrorCode.InvalidTransition)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toBeInstanceOf(ConversationError)
    expect(err.name).toBe('ConversationError')
    expect(err.code).toBe('CONV_INVALID_TRANSITION')
  })

  it('should have all expected error codes', () => {
    expect(ConversationErrorCode.InvalidTransition).toBe('CONV_INVALID_TRANSITION')
    expect(ConversationErrorCode.NotFound).toBe('CONV_NOT_FOUND')
    expect(ConversationErrorCode.ConcurrentMutation).toBe('CONV_CONCURRENT_MUTATION')
  })
})
