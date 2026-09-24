import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ContextManager, ReasoningPort, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { ChatMessage, ToolDefinition } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { manageMessagesForIteration } from '../toolUseLoopRuntime'

const PRESENTED: ToolDefinition = {
  name: 'native_search',
  description: 'Search',
  parameters: { type: 'object' },
}
const DEFERRED: ToolDefinition = {
  name: 'crm__search_contacts',
  description: 'Search contacts',
  parameters: { type: 'object' },
}

function configWith(manage: ContextManager['manage']) {
  // The registry holds more than the loop presents, so a test can tell which
  // list reached the manager.
  const toolRegistry: ToolRegistry = {
    get: () => null,
    listDefinitions: () => [PRESENTED, DEFERRED],
    register: vi.fn(),
  }
  const reasoning: ReasoningPort = {
    respondWithTools: vi.fn(),
    continueWithToolResults: vi.fn(),
  }
  const conversation = makeFakeConversation()
  const config = buildLoopConfig({
    reasoning,
    toolRegistry,
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation,
    contextManager: { manage },
  })
  return { config, conversation }
}

describe('manageMessagesForIteration', () => {
  it('T-R2-2d hands the presented tool definitions to the context manager (#731, #780)', async () => {
    // The tool schemas travel in the request the contract caps; the manager can
    // only count them if the loop passes them (review r2, M2b). It passes the
    // list it presents on this iteration, not the registry's (R21-1).
    const manage = vi.fn((messages: ChatMessage[]) => messages)
    const { config, conversation } = configWith(manage)
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]

    const managed = await manageMessagesForIteration(config, messages, 0, [PRESENTED], true)

    expect(managed).toBe(messages)
    expect(manage).toHaveBeenCalledTimes(1)
    expect(manage).toHaveBeenCalledWith(messages, conversation, { tools: [PRESENTED] })
  })

  it('T-R9-14e hands the system prompt built for the presented tools to the context manager (R9-14, R21-1)', async () => {
    // The system prompt is not in `messages` (the reasoning port prepends it or
    // ships it out of band), yet it travels in the same capped request. On the
    // legacy path it describes the tools it is built over.
    const manage = vi.fn((messages: ChatMessage[]) => messages)
    const { config, conversation } = configWith(manage)
    const systemPromptFor = vi.fn(
      (tools: ToolDefinition[]) =>
        `identity\n\n## Daily Log (frozen at session start)\nentry\n${tools.map(t => t.name).join(',')}`
    )
    config.systemPromptFor = systemPromptFor
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]

    const managed = await manageMessagesForIteration(config, messages, 0, [PRESENTED], true)

    expect(managed).toBe(messages)
    expect(systemPromptFor).toHaveBeenCalledTimes(1)
    expect(systemPromptFor).toHaveBeenCalledWith([PRESENTED])
    expect(manage).toHaveBeenCalledTimes(1)
    expect(manage).toHaveBeenCalledWith(messages, conversation, {
      tools: [PRESENTED],
      systemPrompt: 'identity\n\n## Daily Log (frozen at session start)\nentry\nnative_search',
    })
  })
})
