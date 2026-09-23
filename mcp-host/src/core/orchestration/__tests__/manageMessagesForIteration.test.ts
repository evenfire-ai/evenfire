import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ReasoningPort, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { ChatMessage, ToolDefinition } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { manageMessagesForIteration } from '../toolUseLoopRuntime'

describe('manageMessagesForIteration', () => {
  it('T-R2-2d hands the registry tool definitions to the context manager (#731)', async () => {
    // The tool schemas travel in the request the contract caps; the manager can
    // only count them if the loop passes them (review r2, M2b). The registry's
    // full list is a superset of what the loop presents, so the count errs high.
    const definitions: ToolDefinition[] = [
      { name: 'crm_search_contacts', description: 'Search', parameters: { type: 'object' } },
    ]
    const toolRegistry: ToolRegistry = {
      get: () => null,
      listDefinitions: () => definitions,
      register: vi.fn(),
    }
    const reasoning: ReasoningPort = {
      respondWithTools: vi.fn(),
      continueWithToolResults: vi.fn(),
    }
    const manage = vi.fn((messages: ChatMessage[]) => messages)
    const conversation = makeFakeConversation()
    const config = buildLoopConfig({
      reasoning,
      toolRegistry,
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation,
      contextManager: { manage },
    })
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]

    const managed = await manageMessagesForIteration(config, messages, 0, true)

    expect(managed).toBe(messages)
    expect(manage).toHaveBeenCalledTimes(1)
    expect(manage).toHaveBeenCalledWith(messages, conversation, { tools: definitions })
  })

  it('T-R9-14e hands the loop system prompt to the context manager (R9-14)', async () => {
    // The system prompt is not in `messages` (the reasoning port prepends it or
    // ships it out of band), yet it travels in the same capped request.
    const toolRegistry: ToolRegistry = {
      get: () => null,
      listDefinitions: () => [],
      register: vi.fn(),
    }
    const reasoning: ReasoningPort = {
      respondWithTools: vi.fn(),
      continueWithToolResults: vi.fn(),
    }
    const manage = vi.fn((messages: ChatMessage[]) => messages)
    const conversation = makeFakeConversation()
    const config = buildLoopConfig({
      reasoning,
      toolRegistry,
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation,
      contextManager: { manage },
    })
    config.systemPrompt = 'identity\n\n## Daily Log (frozen at session start)\nentry'
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]

    const managed = await manageMessagesForIteration(config, messages, 0, true)

    expect(managed).toBe(messages)
    expect(manage).toHaveBeenCalledTimes(1)
    expect(manage).toHaveBeenCalledWith(messages, conversation, {
      tools: [],
      systemPrompt: 'identity\n\n## Daily Log (frozen at session start)\nentry',
    })
  })
})
