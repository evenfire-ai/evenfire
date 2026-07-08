import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { LlmError, LlmErrorCode } from '../../errors'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

function createMockReasoning(results: RespondResult[]): ReasoningPort {
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

function createMockTool(toolName: string, output: string): Tool {
  return {
    name: () => toolName,
    description: () => `Mock ${toolName}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: output,
        duration_ms: 10,
        is_error: false,
      })
    ),
    requiresSanitization: () => false,
    requiresApproval: () => false,
  }
}

function createMockRegistry(tools: Tool[]): ToolRegistry {
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

describe('runToolUseLoop workflow artifact recovery', () => {
  it('recovers a named workflow artifact request when the first model response skips workflow_result', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'text',
        content:
          'No result artifact is available. Try https://storage.example/fake.json with artifact-output-fake.',
      },
      {
        type: 'tool_calls',
        calls: [
          {
            id: 'tc_1',
            name: 'workflow_result',
            arguments: { name: 'workflow-agent-chat-due-diligence' },
          },
        ],
      },
      { type: 'error', error: emptyResponse },
      { type: 'error', error: emptyResponse },
    ])

    const workflowResultTool = createMockTool(
      'workflow_result',
      JSON.stringify({
        workflowName: 'workflow-agent-chat-due-diligence',
        artifactAvailable: true,
        result: {
          marker: 'telegram-artifact-marker',
          artifactProof: 'artifact-output-real',
        },
      })
    )
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowResultTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 5,
    })

    const result = await runToolUseLoop(config, [
      {
        role: 'user',
        content:
          'Show me the workflow result artifact for workflow-agent-chat-due-diligence. Include the artifact proof value from the output.',
      },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow result for workflow-agent-chat-due-diligence')
      expect(result.content).toContain('artifact-output-real')
      expect(result.content).not.toContain('artifact-output-fake')
      expect(result.content).not.toContain('storage.example')
    }
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(3)
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(1)
    expect(workflowResultTool.execute).toHaveBeenCalledTimes(1)
  })
})
