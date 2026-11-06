/**
 * Runs the real tool loop (reasoning port + assistant push) over a port, so a
 * test can obtain the history the loop actually builds instead of imitating it.
 */
import { vi } from 'vitest'
import { decodedResponse } from '../../../llm/openaiFamily/__tests__/responsesFixtures'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { LlmPort, ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { DefaultReasoningPort } from '../../reasoning/port'
import { DefaultPromptBuilder } from '../../reasoning/promptBuilder'
import { BasicSafety } from '../../safety/safety'
import type {
  ChatMessage,
  CompletionResponse,
  RespondResult,
  ToolCompletionRequest,
  ToolCompletionResponse,
  ToolOutput,
} from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

function tool(name: string): Tool {
  return {
    name: () => name,
    description: () => `Fake ${name}`,
    parametersSchema: () => ({ type: 'object', properties: { city: { type: 'string' } } }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({ content: '18C, cloudy', duration_ms: 1, is_error: false })
    ),
    requiresSanitization: () => false,
    requiresApproval: () => false,
  }
}

export function registry(): ToolRegistry {
  const tools = [tool('get_weather'), tool('get_time')]
  const map = new Map(tools.map(t => [t.name(), t]))
  return {
    get: (name: string) => map.get(name) ?? null,
    listDefinitions: () =>
      tools.map(t => ({
        name: t.name(),
        description: t.description(),
        parameters: t.parametersSchema(),
      })),
    register: vi.fn(),
  }
}

export async function runLoop(port: LlmPort, observe?: (result: RespondResult) => void) {
  const reasoning = new DefaultReasoningPort(
    port,
    new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
  )
  const observed: ReasoningPort = {
    respondWithTools: async context => {
      const result = await reasoning.respondWithTools(context)
      observe?.(result)
      return result
    },
    continueWithToolResults: async (context, results) => {
      const result = await reasoning.continueWithToolResults(context, results)
      observe?.(result)
      return result
    },
  }
  const config = buildLoopConfig({
    reasoning: observed,
    toolRegistry: registry(),
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation: makeFakeConversation(),
  })
  return runToolUseLoop(config, [{ role: 'user', content: 'Which city, and its weather?' }])
}

/**
 * Runs the loop over provider responses already decoded by a real driver
 * protocol, and returns what the port produced and what the loop sent.
 */
export async function loopOver(responses: ToolCompletionResponse[]) {
  const requests: ToolCompletionRequest[] = []
  const results: RespondResult[] = []
  const queue = [...responses]
  const port: LlmPort = {
    modelName: () => 'unit-model',
    complete: async () => ({}) as CompletionResponse,
    completeWithTools: async request => {
      requests.push(request)
      return queue.shift()!
    },
  }
  await runLoop(port, result => results.push(result))
  return { requests, results }
}

/**
 * The messages of the request the loop sends after a tool turn decoded from
 * `fixture`: the user prompt, the assistant message the loop pushed, and the
 * tool outputs.
 */
export async function historyAfterToolTurn(fixture: string): Promise<ChatMessage[]> {
  const { requests } = await loopOver([
    decodedResponse(fixture),
    decodedResponse('v1-text-gpt-6.1-terra'),
  ])
  return requests[1]!.messages
}
