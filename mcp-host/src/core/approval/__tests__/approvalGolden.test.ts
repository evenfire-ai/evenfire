/**
 * Golden for today's admitToolCall, captured before the approval-mode chain
 * changes. Volatile ids (request_id) are not part of a row.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../../../logger'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { ApprovalController } from '../../extensions/approvalController'
import { UnifiedApprovalGateController } from '../../extensions/mcpApprovalGateController'
import type { Decision, ToolLaneGuardrail } from '../../guardrails'
import type { Tool, ToolRegistry } from '../../interfaces'
import type { LoopConfig } from '../../orchestration/loopConfig'
import { admitToolCall } from '../../orchestration/toolCallPolicy'
import type { Conversation, PendingApproval, ToolCall } from '../../types'

const FIXTURE = join(__dirname, 'fixtures', 'approvalGolden.json')

const TOOLS = [
  { name: 'shell_exec', args: { command: 'ls' }, native: true, requiresApproval: true },
  {
    name: 'http_request',
    args: { url: 'https://example.com/hook' },
    native: true,
    requiresApproval: true,
  },
  { name: 'cron_manage', args: { action: 'create' }, native: true, requiresApproval: true },
  { name: 'acme__search', args: { q: 'n' }, native: false, requiresApproval: false },
  {
    name: 'browser_open',
    args: { url: 'https://example.com/browser' },
    native: true,
    requiresApproval: true,
  },
  { name: 'workflow_trigger', args: { name: 'wf' }, native: true, requiresApproval: true },
  {
    name: 'clerum__gfs_download',
    args: { drive: 'workspace', resourceId: 'file-1' },
    native: true,
    requiresApproval: false,
  },
] as const

const GRANTS = ['none', 'task', 'always', 'one_shot'] as const
const DENIALS = ['none', 'this_tool', 'other_tool'] as const
const OVERRIDES = ['absent', 'true', 'false'] as const
const GUARDRAILS = [
  'off',
  'allow',
  'deny',
  'ask',
  'no_decision',
  'allow_rewrite',
  'ask_rewrite',
] as const

type ToolCase = (typeof TOOLS)[number]
type Grant = (typeof GRANTS)[number]
type Denial = (typeof DENIALS)[number]
type Override = (typeof OVERRIDES)[number]
type Guardrail = (typeof GUARDRAILS)[number]

interface GoldenInput {
  tool: string
  grant: Grant
  denial: Denial
  override: Override
  stateless: boolean
  live: boolean
  guardrail: Guardrail
}

interface GoldenAdmission {
  kind: 'result' | 'suspend' | 'execute'
  pendingCleared: boolean
  authorization_scope?: 'turn_tools' | 'exact_invocation' | null
  reask?: 'denied' | 'denials_active' | null
  description?: string
  content?: string
  name?: string
  arguments?: Record<string, unknown>
  toolIdentity?: { provenance: 'native' | 'mcp'; server?: string; name: string } | null
}

function toolOf(name: string): Tool {
  const spec = TOOLS.find(tool => tool.name === name)!
  return {
    name: () => spec.name,
    description: () => spec.name,
    parametersSchema: () => ({ type: 'object' }),
    requiresSanitization: () => false,
    requiresApproval: () => spec.requiresApproval,
    traceDescriptor: () =>
      spec.native
        ? { kind: 'internal_tool' as const, sourceRef: 'mcp-host' }
        : { kind: 'mcp_server_tool' as const, sourceRef: 'acme' },
    execute: async () => ({ content: 'ok', is_error: false, duration_ms: 0 }),
  }
}

function registry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map(tool => [tool.name(), tool]))
  return {
    get: name => byName.get(name) ?? null,
    listDefinitions: () => [],
    register: () => {},
  }
}

function guardrailFor(
  kind: Guardrail,
  submitted: Record<string, unknown>
): ToolLaneGuardrail | undefined {
  if (kind === 'off') return undefined
  const decision: Decision =
    kind === 'deny'
      ? 'deny'
      : kind === 'ask' || kind === 'ask_rewrite'
        ? 'ask'
        : kind === 'no_decision'
          ? 'no_decision'
          : 'allow'
  const effectiveInput =
    kind === 'allow_rewrite' || kind === 'ask_rewrite'
      ? { ...submitted, rewritten: true }
      : submitted
  return {
    async decide() {
      return { decision, reasonCode: 'golden', effectiveInput, source: 'host_rule' }
    },
  }
}

function conversationFor(spec: ToolCase, grant: Grant, denial: Denial): Conversation {
  const callId = `tc-${spec.name}`
  const pending: PendingApproval | undefined =
    grant === 'one_shot'
      ? {
          request_id: 'pending-golden',
          tool_name: spec.name,
          tool_call_id: callId,
          parameters: { ...spec.args },
          description: 'pending',
          context_snapshot: [],
          authorization_scope: 'exact_invocation',
        }
      : undefined
  return makeFakeConversation({
    auto_approved_tools: new Set(grant === 'always' ? [spec.name] : []),
    task_approved_tools: new Set(grant === 'task' ? [spec.name] : []),
    denials:
      denial === 'this_tool'
        ? new Map([[spec.name, 'user-a']])
        : denial === 'other_tool'
          ? new Map([['other_tool', 'user-a']])
          : new Map(),
    pending_approval: pending,
  })
}

function project(
  admission: Awaited<ReturnType<typeof admitToolCall>>,
  pendingCleared: boolean
): GoldenAdmission {
  if (admission.kind === 'result') {
    return { kind: 'result', pendingCleared, content: admission.toolResult.content }
  }
  if (admission.kind === 'suspend') {
    return {
      kind: 'suspend',
      pendingCleared,
      authorization_scope: admission.approval.authorization_scope ?? null,
      reask: admission.approval.reask ?? null,
      description: admission.approval.description,
    }
  }
  return {
    kind: 'execute',
    pendingCleared,
    name: admission.call.name,
    arguments: admission.call.arguments,
    toolIdentity: admission.toolIdentity ?? null,
  }
}

async function collectRows(): Promise<Array<{ input: GoldenInput; admission: GoldenAdmission }>> {
  const native = registry(TOOLS.filter(tool => tool.native).map(tool => toolOf(tool.name)))
  const all = registry(TOOLS.map(tool => toolOf(tool.name)))
  const rows: Array<{ input: GoldenInput; admission: GoldenAdmission }> = []

  for (const spec of TOOLS) {
    for (const grant of GRANTS) {
      for (const denial of DENIALS) {
        for (const override of OVERRIDES) {
          for (const stateless of [false, true]) {
            for (const live of [false, true]) {
              for (const guardrail of GUARDRAILS) {
                const input: GoldenInput = {
                  tool: spec.name,
                  grant,
                  denial,
                  override,
                  stateless,
                  live,
                  guardrail,
                }
                const conversation = conversationFor(spec, grant, denial)
                const hadPending = conversation.pending_approval !== undefined
                const approvalConfig = {
                  defaultPolicy: 'cli_only' as const,
                  channels: {},
                  ...(override === 'absent' ? {} : { tools: { [spec.name]: override === 'true' } }),
                }
                const gate = new UnifiedApprovalGateController(all, approvalConfig, native, {
                  statelessLifecycle: stateless,
                })
                const controller = new ApprovalController(conversation, gate, {
                  toolRegistry: all,
                  liveApprovalTools:
                    live && spec.name === 'clerum__gfs_download'
                      ? new Set(['clerum__gfs_download'])
                      : undefined,
                  forcedApprovalGate: gate,
                })
                const config = {
                  reasoning: {} as never,
                  toolRegistry: all,
                  safety: {} as never,
                  events: { emit: () => {}, on: () => {}, off: () => {} },
                  conversation,
                  loopController: controller,
                  contextManager: {} as never,
                  toolOutputProcessor: {
                    beforeExecution: () => ({ is_valid: true, errors: [] }),
                    afterExecution: (_name: string, output: { content: string }) => output.content,
                  },
                  guardrails: guardrailFor(guardrail, { ...spec.args }),
                  maxIterations: 3,
                  toolTimeout: 1000,
                  toolProgressInterval: 0,
                } as LoopConfig
                const call: ToolCall = {
                  id: `tc-${spec.name}`,
                  name: spec.name,
                  arguments: { ...spec.args },
                }
                const admission = await admitToolCall(call, config, 0)
                const pendingCleared = hadPending && conversation.pending_approval === undefined
                rows.push({ input, admission: project(admission, pendingCleared) })
              }
            }
          }
        }
      }
    }
  }
  return JSON.parse(JSON.stringify(rows)) as Array<{
    input: GoldenInput
    admission: GoldenAdmission
  }>
}

describe('approval admission golden', () => {
  beforeAll(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
  })

  it("records today's admitToolCall for the reference inputs", async () => {
    const rows = await collectRows()
    const executeRows = rows.filter(row => row.admission.kind === 'execute')
    expect(executeRows.length).toBeGreaterThan(0)
    expect(executeRows.every(row => Object.hasOwn(row.admission, 'toolIdentity'))).toBe(true)
    expect(
      rows.some(
        row =>
          row.admission.kind === 'execute' &&
          row.admission.arguments?.rewritten === true &&
          row.admission.toolIdentity !== null &&
          row.input.guardrail === 'allow_rewrite'
      )
    ).toBe(true)
    expect(rows.some(row => JSON.stringify(row).includes('request_id'))).toBe(false)

    if (process.env.APPROVAL_GOLDEN_RECORD === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, `${JSON.stringify(rows, null, 2)}\n`)
    }

    const saved = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown
    expect(rows).toEqual(saved)
  })
})
