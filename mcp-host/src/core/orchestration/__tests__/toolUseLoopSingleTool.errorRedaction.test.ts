/**
 * A15 item 6 — a thrown tool error reaches the post-result transform and the
 * model through `errorResult`. A thrown upstream message can carry a secret,
 * so its text goes through the same tool-output sanitizer the success path
 * applies (`config.safety.sanitizeOutput`, which `toolOutputProcessor`
 * delegates to) before the transform sees it.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ToolLaneGuardrail } from '../../guardrails'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { ChatMessage, ToolOutput, ToolResult } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

const GITHUB_PAT = 'ghp_Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8'
const GITHUB_PAT_BODY = GITHUB_PAT.slice('ghp_'.length)
const UPSTREAM = 'upstream refused the request with credential'

function throwingTool(): Tool & { execute: ReturnType<typeof vi.fn> } {
  return {
    name: () => 'fetch_repo',
    description: () => 'Fetch a repository',
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(async (): Promise<ToolOutput> => {
      throw new Error(`${UPSTREAM} ${GITHUB_PAT}`)
    }),
    requiresSanitization: () => true,
    requiresApproval: () => false,
  }
}

function registryOf(tool: Tool): ToolRegistry {
  return {
    get: name => (name === tool.name() ? tool : null),
    listDefinitions: () => [
      { name: tool.name(), description: tool.description(), parameters: tool.parametersSchema() },
    ],
    register: vi.fn(),
  }
}

describe('executeSingleTool — thrown error text is sanitized (A15 item 6)', () => {
  it('redacts a token in a thrown message before the transform and the model see it', async () => {
    const tool = throwingTool()
    const seenByTransform: Array<{ content: string; isError: boolean }> = []
    const guardrails: ToolLaneGuardrail = {
      async decide(_id, input) {
        return { decision: 'allow', reasonCode: 'r', effectiveInput: input, source: 'host_rule' }
      },
      async transformResult(_id, _input, result) {
        seenByTransform.push(result)
        return result
      },
    }
    const resultsForModel: ToolResult[][] = []
    const messagesForModel: ChatMessage[][] = []
    const reasoning: ReasoningPort = {
      respondWithTools: vi.fn(async () => ({
        type: 'tool_calls' as const,
        calls: [{ id: 'tc_1', name: 'fetch_repo', arguments: {} }],
      })),
      continueWithToolResults: vi.fn(async (context, results) => {
        // Copies: the loop keeps mutating the arrays it passed.
        resultsForModel.push(structuredClone(results))
        messagesForModel.push(structuredClone(context.messages))
        return { type: 'text' as const, content: 'done' }
      }),
    }
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: registryOf(tool),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })
    config.guardrails = guardrails

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'fetch it' }])

    // Witness: the tool ran and threw, and the loop handed its error onward.
    expect(tool.execute).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ type: 'response', content: 'done' })
    expect(seenByTransform).toHaveLength(1)
    expect(resultsForModel).toHaveLength(1)
    expect(resultsForModel[0]).toHaveLength(1)

    // The result reaching the transform: still an error, error text kept,
    // token redacted.
    const transformed = seenByTransform[0]!
    expect(transformed.isError).toBe(true)
    expect(transformed.content).toContain(`Tool execution failed: ${UPSTREAM}`)
    expect(transformed.content).toContain('[REDACTED]')
    expect(transformed.content).not.toContain(GITHUB_PAT_BODY)

    // The result and the messages the model receives.
    const toModel = resultsForModel[0]![0]!
    expect(toModel).toMatchObject({ tool_call_id: 'tc_1', is_error: true })
    expect(toModel.content).toContain(`Tool execution failed: ${UPSTREAM}`)
    expect(toModel.content).not.toContain(GITHUB_PAT_BODY)
    const toolMessages = messagesForModel[0]!.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(JSON.stringify(toolMessages[0])).toContain(UPSTREAM)
    expect(JSON.stringify(messagesForModel[0])).not.toContain(GITHUB_PAT_BODY)
  })
})
