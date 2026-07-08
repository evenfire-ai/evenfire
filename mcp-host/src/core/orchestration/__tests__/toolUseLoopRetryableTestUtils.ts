import { vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'

export function createMockReasoning(results: RespondResult[]): ReasoningPort {
  let callIndex = 0
  return {
    respondWithTools: vi.fn(
      async () =>
        results[callIndex++] ?? {
          type: 'error',
          error: new Error('No more results'),
        }
    ),
    continueWithToolResults: vi.fn(
      async () =>
        results[callIndex++] ?? {
          type: 'error',
          error: new Error('No more results'),
        }
    ),
  }
}

export function createMockTool(
  toolName: string,
  opts: {
    sanitize?: boolean
    output?: string
    error?: boolean
  } = {}
): Tool {
  return {
    name: () => toolName,
    description: () => `Mock ${toolName}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: opts.output ?? `${toolName} result`,
        duration_ms: 10,
        is_error: opts.error ?? false,
      })
    ),
    requiresSanitization: () => opts.sanitize ?? true,
    requiresApproval: () => false,
  }
}

export function createMockRegistry(tools: Tool[]): ToolRegistry {
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

export function buildTestConfig(reasoning: ReasoningPort, tools: Tool[]) {
  return buildLoopConfig({
    reasoning,
    toolRegistry: createMockRegistry(tools),
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation: makeFakeConversation(),
    maxIterations: 4,
  })
}
