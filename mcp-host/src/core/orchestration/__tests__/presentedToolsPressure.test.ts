/**
 * R21-1 (#780) — pressure counts the tool schemas the request carries.
 *
 * When the controller presents only the native tools (Codex `discovery`, or the
 * legacy bridge latch), the deferred MCP schemas never reach the model. The
 * context manager must count the list the loop hands to `reasoning` on that
 * iteration, not the registry's full catalog.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ContextManageOptions, ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type {
  ChatMessage,
  ReasoningContext,
  RespondResult,
  ToolDefinition,
  ToolOutput,
} from '../../types'
import { DeferrableToolController, type LatchStore } from '../deferrableToolController'
import { SimpleEventEmitter } from '../eventEmitter'
import { DefaultLoopController, buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

const NATIVE = 'native_search'
const DEFERRED = 'crm__export_contacts'
// One deferred schema large enough to dominate the gauge if it were counted.
const DEFERRED_DESCRIPTION = 'x'.repeat(40_000)

function makeTool(name: string, description: string): Tool {
  return {
    name: () => name,
    description: () => description,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: `${name} result`,
        duration_ms: 1,
        is_error: false,
      })
    ),
    requiresSanitization: () => false,
    requiresApproval: () => false,
  }
}

function makeRegistry(tools: Tool[]): ToolRegistry {
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

function makeLatch(): LatchStore {
  let value: boolean | undefined
  return {
    get: () => value,
    set: v => {
      value = v
    },
  }
}

function names(tools: ToolDefinition[] | undefined): string[] {
  return (tools ?? []).map(t => t.name)
}

async function runWithController(controller: DeferrableToolController) {
  const results: RespondResult[] = [
    { type: 'tool_calls', calls: [{ id: 'tc_1', name: NATIVE, arguments: {} }] },
    { type: 'text', content: 'Done' },
  ]
  let index = 0
  const next = async () => results[index++] ?? { type: 'error' as const, error: new Error('none') }
  const reasoning: ReasoningPort = {
    respondWithTools: vi.fn(next),
    continueWithToolResults: vi.fn(next),
  }
  const manage = vi.fn(
    (messages: ChatMessage[], _conversation: unknown, _options?: ContextManageOptions) => messages
  )
  const registry = makeRegistry([
    makeTool(NATIVE, 'Search natively'),
    makeTool(DEFERRED, DEFERRED_DESCRIPTION),
  ])
  const config = buildLoopConfig({
    reasoning,
    toolRegistry: registry,
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation: makeFakeConversation(),
    loopController: controller,
    contextManager: { manage },
  })

  const outcome = await runToolUseLoop(config, [{ role: 'user', content: 'Hi' }])

  const presented = [
    ...vi.mocked(reasoning.respondWithTools).mock.calls.map(c => c[0]),
    ...vi.mocked(reasoning.continueWithToolResults).mock.calls.map(c => c[0]),
  ].map((context: ReasoningContext) => names(context.available_tools))
  const counted = manage.mock.calls.map(c => names(c[2]?.tools))
  return { outcome, registry, presented, counted }
}

describe('R21-1 the context manager counts the presented tools (#780)', () => {
  it.each([
    [
      'Codex discovery mode',
      () =>
        new DeferrableToolController(
          new DefaultLoopController(),
          new Set([NATIVE]),
          { dynamicToolsEnabled: false, dynamicToolsThreshold: 60, codexMode: 'discovery' },
          makeLatch()
        ),
    ],
    [
      'the legacy bridge latch',
      () =>
        new DeferrableToolController(
          new DefaultLoopController(),
          new Set([NATIVE]),
          { dynamicToolsEnabled: true, dynamicToolsThreshold: 0 },
          makeLatch()
        ),
    ],
  ])('T-R21-1a %s: pre-LLM and post-tool pressure see only native tools', async (_, build) => {
    const { outcome, registry, presented, counted } = await runWithController(build())

    // Witnesses: the loop ran two iterations, the registry carries the deferred
    // schema, and the controller withheld it from both requests.
    expect(outcome).toMatchObject({ type: 'response', content: 'Done' })
    expect(names(registry.listDefinitions())).toEqual([NATIVE, DEFERRED])
    expect(presented).toEqual([[NATIVE], [NATIVE]])

    // pre-LLM (iteration 0), post-tool (iteration 0), pre-LLM (iteration 1).
    expect(counted).toEqual([[NATIVE], [NATIVE], [NATIVE]])
  })

  it('T-R21-1b direct presentation still counts every registered schema', async () => {
    const { presented, counted } = await runWithController(
      new DeferrableToolController(
        new DefaultLoopController(),
        new Set([NATIVE]),
        { dynamicToolsEnabled: false, dynamicToolsThreshold: 60, codexMode: 'direct' },
        makeLatch()
      )
    )

    expect(presented).toEqual([
      [NATIVE, DEFERRED],
      [NATIVE, DEFERRED],
    ])
    expect(counted).toEqual([
      [NATIVE, DEFERRED],
      [NATIVE, DEFERRED],
      [NATIVE, DEFERRED],
    ])
  })
})
