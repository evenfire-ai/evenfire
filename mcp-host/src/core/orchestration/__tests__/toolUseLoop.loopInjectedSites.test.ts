/**
 * LM1 — every `role: 'user'` message the loop injects itself carries the
 * `loopInjected` marker, so turn-scoped passes (the C17 attachment page
 * collapse in `prePrune`) do not treat it as the start of a new user turn.
 *
 * `toolUseLoop.loopInjectedTurn.test.ts` proves the behaviour for the nudge and
 * the empty-after-tool-results recovery. This file drives the real loop into
 * each of the remaining injection branches and checks the message it injected.
 * The branch's own prompt text is the liveness witness: the test cannot pass
 * unless that branch ran and its message reached the model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareStatements } from '../../../db/statements'
import type { PendingApprovalRow } from '../../../db/worker/protocol'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../conversation/persistence/__tests__/testHelpers'
import { reconstructPendingApproval } from '../../conversation/persistence/reconstruct'
import { LlmError, LlmErrorCode } from '../../errors'
import { UnifiedApprovalGateController } from '../../extensions/mcpApprovalGateController'
import type { LoopController, ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { ChatMessage, ReasoningContext, RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'
import { isLoopInjectedMessage } from '../toolUseLoopMessages'

const TRIGGER_AFTER_LIST_PROMPT =
  'The previous assistant response listed or described workflows but did not trigger the requested workflow. The user asked to run a named workflow recipe and provided any business inputs in the original message. Call workflow_trigger for that workflow with those inputs when it is available, or use workflow tools to prove it is not available. Do not only summarize workflow_list.'
const LIST_WITHOUT_TOOL_PROMPT =
  'The previous assistant response answered a workflow recipe list request without calling workflow_list. Use workflow_list now and answer only from its current results. Do not reuse prior conversation workflow names.'
const TRIGGER_WITHOUT_TOOL_PROMPT =
  'The previous assistant response did not trigger the requested workflow. The user asked to trigger a workflow recipe by name. Use workflow_trigger for the requested workflow and target when it is available, or use the workflow tools to prove that it is not available. Do not create or report a workflow run without workflow_trigger.'
const ARTIFACT_WITHOUT_TOOL_PROMPT =
  'The previous assistant response did not retrieve the requested workflow result artifact. The user asked for an existing workflow result artifact by name. Use workflow_result for the named workflow, or use the workflow tools to prove that it is unavailable. Do not invent artifact URLs, proof values, or run outputs.'
const TRIGGER_FOR_LIST_PROMPT =
  'The user asked to list workflow recipes, not trigger one. Do not call workflow_trigger for workflow availability questions. Use workflow_list and answer only from its results.'
const TRIGGER_FOR_ARTIFACT_PROMPT =
  'The previous tool choice would trigger a workflow, but the user asked for an existing workflow result artifact. Do not call workflow_trigger for result, artifact, output, or download requests. Use workflow_result for the named workflow.'
const EMPTY_INITIAL_PROMPT =
  'The previous assistant turn was empty. Continue the user request now. Use the available tools when needed, and do not invent workflow names, workflow results, approvals, runs, or artifacts.'

const LIST_REQUEST = 'List the workflow recipes I can run.'
const ARTIFACT_REQUEST =
  'Show me the workflow result artifact for workflow-agent-chat-due-diligence.'
const WORKFLOW_LIST_OUTPUT = JSON.stringify({
  items: [
    {
      name: 'research-summary-workflow',
      inputContract: {
        type: 'object',
        required: ['topic'],
        properties: { topic: { type: 'string' } },
      },
    },
  ],
  count: 1,
})

function emptyResponse(): RespondResult {
  return {
    type: 'error',
    error: new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    ),
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): RespondResult {
  return { type: 'tool_calls', calls: [{ id, name, arguments: args }] }
}

function makeTool(name: string, output: string, requiresApproval = false): Tool {
  return {
    name: () => name,
    description: () => `Mock ${name}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({ content: output, duration_ms: 1, is_error: false })
    ),
    requiresSanitization: () => false,
    requiresApproval: () => requiresApproval,
  }
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map(tool => [tool.name(), tool]))
  return {
    get: name => byName.get(name) ?? null,
    listDefinitions: () =>
      tools.map(tool => ({
        name: tool.name(),
        description: tool.description(),
        parameters: tool.parametersSchema(),
      })),
    register: vi.fn(),
  }
}

async function runScript(input: {
  userText: string
  tools: Tool[]
  script: RespondResult[]
  loopController?: (registry: ToolRegistry) => LoopController
}) {
  let index = 0
  // Snapshot every request: the loop keeps mutating the array it sent.
  const sent: ChatMessage[][] = []
  const next = async (context: ReasoningContext): Promise<RespondResult> => {
    sent.push(structuredClone(context.messages))
    return input.script[index++] ?? { type: 'error', error: new Error('script exhausted') }
  }
  const reasoning: ReasoningPort = {
    respondWithTools: vi.fn(next),
    continueWithToolResults: vi.fn(next),
  }
  const registry = makeRegistry(input.tools)
  const config = buildLoopConfig({
    reasoning,
    toolRegistry: registry,
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation: makeFakeConversation(),
    maxIterations: 6,
    loopController: input.loopController?.(registry),
  })
  const outcome = await runToolUseLoop(config, [{ role: 'user', content: input.userText }])
  return { outcome, sent, scriptConsumed: index }
}

interface SiteCase {
  site: string
  prompt: string
  userText: string
  tools: () => Tool[]
  script: RespondResult[]
  /** Zero-based request that first carries the injected message. */
  firstRequest: number
}

const SITES: SiteCase[] = [
  {
    site: 'toolUseLoop: workflow_trigger recovery after a workflow_list text response',
    prompt: TRIGGER_AFTER_LIST_PROMPT,
    userText: '@Evenfire Test App run research-summary-workflow topic "the roman empire"',
    tools: () => [
      makeTool('workflow_list', WORKFLOW_LIST_OUTPUT),
      makeTool('workflow_trigger', JSON.stringify({ workflowName: 'research-summary-workflow' })),
    ],
    script: [
      toolCall('tc_list', 'workflow_list'),
      { type: 'text', content: 'research-summary-workflow is available for this conversation.' },
      toolCall('tc_trigger', 'workflow_trigger', {
        name: 'research-summary-workflow',
        inputs: { topic: 'the roman empire' },
      }),
      { type: 'text', content: 'The workflow request is now being handled.' },
    ],
    firstRequest: 2,
  },
  {
    site: 'toolUseLoop: workflow_list recovery for a text answer without a tool call',
    prompt: LIST_WITHOUT_TOOL_PROMPT,
    userText: LIST_REQUEST,
    tools: () => [makeTool('workflow_list', WORKFLOW_LIST_OUTPUT)],
    script: [
      { type: 'text', content: 'You can run research-summary-workflow.' },
      { type: 'text', content: 'Done' },
    ],
    firstRequest: 1,
  },
  {
    site: 'toolUseLoop: workflow_trigger recovery for a text answer without a tool call',
    prompt: TRIGGER_WITHOUT_TOOL_PROMPT,
    userText: 'Run e2e-telegram-risk-review now.',
    tools: () => [makeTool('workflow_trigger', JSON.stringify({ workflowName: 'x' }))],
    script: [
      { type: 'text', content: 'Started it for you.' },
      { type: 'text', content: 'Done' },
    ],
    firstRequest: 1,
  },
  {
    site: 'toolUseLoop: workflow_result recovery for a text answer without a tool call',
    prompt: ARTIFACT_WITHOUT_TOOL_PROMPT,
    userText: ARTIFACT_REQUEST,
    tools: () => [makeTool('workflow_result', JSON.stringify({ artifactAvailable: true }))],
    script: [
      { type: 'text', content: 'No artifact is available.' },
      { type: 'text', content: 'Done' },
    ],
    firstRequest: 1,
  },
  {
    site: 'toolUseLoop: workflow_trigger chosen for a workflow list request',
    prompt: TRIGGER_FOR_LIST_PROMPT,
    userText: LIST_REQUEST,
    tools: () => [
      makeTool('workflow_list', WORKFLOW_LIST_OUTPUT),
      makeTool('workflow_trigger', JSON.stringify({ workflowName: 'x' })),
    ],
    script: [
      toolCall('tc_bad', 'workflow_trigger', { name: 'research-summary-workflow' }),
      toolCall('tc_list', 'workflow_list'),
      { type: 'text', content: 'research-summary-workflow requires topic.' },
    ],
    firstRequest: 1,
  },
  {
    site: 'toolUseLoop: workflow_trigger chosen for a workflow artifact request',
    prompt: TRIGGER_FOR_ARTIFACT_PROMPT,
    userText: ARTIFACT_REQUEST,
    tools: () => [
      makeTool('workflow_result', JSON.stringify({ artifactAvailable: true })),
      makeTool('workflow_trigger', JSON.stringify({ workflowName: 'x' })),
    ],
    script: [
      toolCall('tc_bad', 'workflow_trigger', { name: 'workflow-agent-chat-due-diligence' }),
      toolCall('tc_result', 'workflow_result', { name: 'workflow-agent-chat-due-diligence' }),
      { type: 'text', content: 'Here is the workflow result artifact.' },
    ],
    firstRequest: 1,
  },
  {
    site: 'toolUseLoopErrorRecovery: empty initial response',
    prompt: EMPTY_INITIAL_PROMPT,
    userText: 'Summarize the attached plan.',
    tools: () => [makeTool('echo', 'echo result')],
    script: [emptyResponse(), { type: 'text', content: 'Done' }],
    firstRequest: 1,
  },
]

function findUserMessage(messages: ChatMessage[], content: string): ChatMessage | undefined {
  return messages.find(message => message.role === 'user' && message.content === content)
}

describe('LM1 every loop-injected user message carries the loopInjected marker', () => {
  it.each(SITES.map(site => [site.site, site] as const))('%s', async (_, site) => {
    const { outcome, sent, scriptConsumed } = await runScript({
      userText: site.userText,
      tools: site.tools(),
      script: site.script,
    })

    // Witness: the whole script ran, so the loop went through the branch and on
    // to a final answer instead of stopping early.
    expect(outcome.type).toBe('response')
    expect(scriptConsumed).toBe(site.script.length)

    // Witness: the branch's own prompt reached the model, first in the request
    // right after the branch ran.
    const firstCarrying = sent.findIndex(request => findUserMessage(request, site.prompt))
    expect(firstCarrying).toBe(site.firstRequest)

    for (const request of sent.slice(site.firstRequest)) {
      const injected = findUserMessage(request, site.prompt)
      expect(injected).toEqual({ role: 'user', content: site.prompt, loopInjected: true })
      expect(isLoopInjectedMessage(injected!)).toBe(true)

      // The genuine request stays an unmarked turn boundary.
      const genuine = findUserMessage(request, site.userText)
      expect(genuine).toEqual({ role: 'user', content: site.userText })
      expect(isLoopInjectedMessage(genuine!)).toBe(false)
    }
  })
})

describe('LM1 the loopInjected marker survives the approval context snapshot', () => {
  let store: StoreHandle | undefined
  afterEach(async () => {
    await store?.shutdown()
    store = undefined
  })

  it('keeps the marker in context_snapshot and through the persisted JSON row', async () => {
    const { outcome, sent } = await runScript({
      userText: 'Clean up the build directory.',
      tools: [makeTool('shell_exec', 'removed', true)],
      script: [emptyResponse(), toolCall('tc_shell', 'shell_exec', { command: 'rm -rf build' })],
      loopController: registry => new UnifiedApprovalGateController(registry),
    })

    // Witness: the recovery ran (its prompt reached the model) and the next
    // tool call suspended for approval.
    expect(sent).toHaveLength(2)
    expect(findUserMessage(sent[1]!, EMPTY_INITIAL_PROMPT)).toBeDefined()
    expect(outcome.type).toBe('need_approval')
    if (outcome.type !== 'need_approval') return
    const snapshot = outcome.approval.context_snapshot
    expect(outcome.approval.tool_call_id).toBe('tc_shell')

    const inSnapshot = findUserMessage(snapshot, EMPTY_INITIAL_PROMPT)
    expect(inSnapshot).toEqual({ role: 'user', content: EMPTY_INITIAL_PROMPT, loopInjected: true })
    const genuine = findUserMessage(snapshot, 'Clean up the build directory.')
    expect(genuine).toBeDefined()
    expect(isLoopInjectedMessage(genuine!)).toBe(false)

    // Persist through the real SQLite store (the JSON `context_snapshot` column)
    // and rebuild it the way a cold restart does.
    store = makeSqliteStore()
    const manager = new ConversationManager(store.store)
    const conv = await manager.getOrCreate('user-lm1:rpc:agent:default')
    await manager.startTurn(conv, 'Clean up the build directory.', 'task-lm1')
    await store.store.persistSuspend(conv, {
      ...outcome.approval,
      task_budget: {
        elapsedActiveMs: 0,
        iterationsUsed: 2,
        durationMs: 86400000,
        maxIterations: 1000,
      },
    })
    const row = prepareStatements(store.worker.db).selectPendingApprovalBySession.get(
      conv.id
    ) as PendingApprovalRow
    expect(row.context_snapshot).toContain(EMPTY_INITIAL_PROMPT)
    const restored = reconstructPendingApproval(row).context_snapshot
    expect(restored).toHaveLength(snapshot.length)
    const restoredInjected = findUserMessage(restored, EMPTY_INITIAL_PROMPT)
    expect(restoredInjected).toBeDefined()
    expect(isLoopInjectedMessage(restoredInjected!)).toBe(true)
    const restoredGenuine = findUserMessage(restored, 'Clean up the build directory.')
    expect(restoredGenuine).toBeDefined()
    expect(isLoopInjectedMessage(restoredGenuine!)).toBe(false)
  })
})
