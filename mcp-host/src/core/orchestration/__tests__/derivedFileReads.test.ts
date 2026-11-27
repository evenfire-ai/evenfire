/**
 * Guardrail `file_read` rules over the files another native tool reads
 * (`Tool.fileReads`). Admission uses the real rule engine; the tool is a stub
 * that declares its reads and records every execution.
 */
import { describe, expect, it } from 'vitest'
import { type GuardrailRule, buildToolLaneGuardrail } from '../../guardrails'
import type { Decision } from '../../guardrails/types'
import type {
  AgentEventEmitter,
  FileReads,
  Safety,
  Tool,
  ToolRegistry,
  ToolTraceDescriptor,
} from '../../interfaces'
import type { AgentEvent, Conversation, ToolCall, ToolDefinition, ToolOutput } from '../../types'
import type { LoopConfig } from '../loopConfig'
import { admitToolCall } from '../toolCallPolicy'

class ReaderTool implements Tool {
  public calls: Record<string, unknown>[] = []
  constructor(
    private readonly declares = true,
    private readonly descriptor?: ToolTraceDescriptor
  ) {}
  name(): string {
    return 'reader_tool'
  }
  description(): string {
    return 'reads a workspace file'
  }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: { file: { type: 'string' } } }
  }
  requiresSanitization(): boolean {
    return true
  }
  requiresApproval(): boolean {
    return false
  }
  fileReads(params: Record<string, unknown>): FileReads | undefined {
    if (!this.declares || typeof params.file !== 'string') return undefined
    return { paths: [params.file] }
  }
  traceDescriptor(): ToolTraceDescriptor {
    return this.descriptor ?? { kind: 'internal_tool', sourceRef: 'mcp-host' }
  }
  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    this.calls.push(params)
    return { content: 'read', duration_ms: 1, is_error: false }
  }
}

const noopSafety: Safety = {
  validateInput: () => ({ is_valid: true, errors: [] }),
  validateToolParams: () => ({ is_valid: true, errors: [] }),
  sanitizeOutput: (_n, output) => ({ content: output, was_modified: false, warnings: [] }),
  wrapForLlm: (_n, content) => content,
}

function makeConfig(
  tool: Tool,
  rules: GuardrailRule[],
  options: { executionMode?: 'interactive' | 'unattended'; events?: AgentEvent[] } = {}
): LoopConfig {
  const toolRegistry: ToolRegistry = {
    get: name => (name === tool.name() ? tool : null),
    listDefinitions: (): ToolDefinition[] => [],
    register: () => {},
  }
  const events: AgentEventEmitter = {
    emit: event => options.events?.push(event),
    on: () => {},
    off: () => {},
  }
  return {
    reasoning: {} as never,
    toolRegistry,
    safety: noopSafety,
    events,
    conversation: {
      pending_approval: undefined,
      auto_approved_tools: new Set<string>(),
    } as unknown as Conversation,
    loopController: {
      shouldAccept: () => true,
      onTextRejected: () => null,
      beforeTool: () => 'proceed',
      onExhaustion: () => '',
      refreshTools: async t => t,
    },
    contextManager: {} as never,
    toolOutputProcessor: {
      beforeExecution: () => ({ is_valid: true, errors: [] }),
      afterExecution: (_n, out) => out.content,
    },
    guardrails: buildToolLaneGuardrail({ rules }),
    maxIterations: 10,
    toolTimeout: 5000,
    toolProgressInterval: 0,
    ...(options.executionMode ? { executionMode: options.executionMode } : {}),
  }
}

const read = (file: string, id = 'c1'): ToolCall => ({
  id,
  name: 'reader_tool',
  arguments: { file },
})

const allowNative: GuardrailRule = {
  id: 'allow-native',
  action: 'allow',
  match: { tool: { provenance: 'native', name: '*' } },
}
const denySecrets: GuardrailRule = {
  id: 'deny-secrets',
  action: 'deny',
  match: {
    tool: { provenance: 'native', name: 'file_read' },
    arguments: [{ type: 'path', pointer: '/path', op: 'under', value: 'secrets' }],
  },
}
const allowReaderTool: GuardrailRule = {
  id: 'allow-reader',
  action: 'allow',
  match: { tool: { provenance: 'native', name: 'reader_tool' } },
}
const allowPubReads: GuardrailRule = {
  id: 'allow-pub',
  action: 'allow',
  match: {
    tool: { provenance: 'native', name: 'file_read' },
    arguments: [{ type: 'path', pointer: '/path', op: 'under', value: 'pub' }],
  },
}

describe('guardrail file_read rules over a native tool’s declared reads', () => {
  it('a file_read deny blocks the read through another tool', async () => {
    const tool = new ReaderTool()
    const config = makeConfig(tool, [allowNative, denySecrets])

    const blocked = await admitToolCall(read('secrets/a.json'), config, 0)
    expect(blocked).toEqual({
      kind: 'result',
      toolResult: {
        tool_call_id: 'c1',
        name: 'reader_tool',
        content: 'Blocked by guardrail policy (rule:deny-secrets).',
        is_error: true,
      },
    })

    const allowed = await admitToolCall(read('pub/a.json', 'c2'), config, 0)
    expect(allowed.kind).toBe('execute')
  })

  it('an allowlist Host asks for a read file_read is not allowed, exactly as file_read would', async () => {
    const tool = new ReaderTool()
    const config = makeConfig(tool, [allowReaderTool, allowPubReads])

    const asked = await admitToolCall(read('secrets/a.json'), config, 0)
    expect(asked).toMatchObject({
      kind: 'suspend',
      cause: 'guardrail_ask',
      approval: {
        tool_name: 'reader_tool',
        authorization_scope: 'exact_invocation',
        parameters: { file: 'secrets/a.json' },
        description: 'Guardrail requires approval (unmatched_ask)',
      },
    })

    const allowed = await admitToolCall(read('pub/a.json', 'c2'), config, 0)
    expect(allowed.kind).toBe('execute')
  })

  it('an unattended run refuses a derived ask', async () => {
    const tool = new ReaderTool()
    const config = makeConfig(tool, [allowReaderTool, allowPubReads], {
      executionMode: 'unattended',
    })

    const refused = await admitToolCall(read('secrets/a.json'), config, 0)
    expect(refused).toMatchObject({
      kind: 'result',
      toolResult: {
        content: 'Blocked: approval required but no approver is available in an autonomous run.',
        is_error: true,
      },
    })
    expect((await admitToolCall(read('pub/a.json', 'c2'), config, 0)).kind).toBe('execute')
  })

  it('the guardrail decision event reports the derived decision', async () => {
    const events: AgentEvent[] = []
    const config = makeConfig(new ReaderTool(), [allowNative, denySecrets], { events })

    await admitToolCall(read('secrets/a.json'), config, 0)

    expect(events.filter(e => e.type === 'guardrail:decision')).toEqual([
      expect.objectContaining({
        data: {
          toolName: 'reader_tool',
          decision: 'deny',
          reasonCode: 'rule:deny-secrets',
          source: 'host_rule',
          iteration: 0,
        },
      }),
    ])
  })

  it('a tool that declares no reads keeps its own decision', async () => {
    const config = makeConfig(new ReaderTool(false), [allowNative, denySecrets])

    expect((await admitToolCall(read('secrets/a.json'), config, 0)).kind).toBe('execute')
  })

  it('an MCP tool’s declared reads are not evaluated as file_read', async () => {
    const mcpTool = new ReaderTool(true, { kind: 'mcp_server_tool', sourceRef: 'files-server' })
    const config = makeConfig(mcpTool, [
      allowNative,
      denySecrets,
      { id: 'allow-mcp', action: 'allow', match: { tool: { provenance: 'mcp', name: '*' } } },
    ])

    expect((await admitToolCall(read('secrets/a.json'), config, 0)).kind).toBe('execute')
  })
})

describe('the merge of a call’s own decision with its derived file_read decision', () => {
  // The strictness order the merge applies: deny > ask > allow > no_decision.
  const DECISIONS: Decision[] = ['no_decision', 'allow', 'ask', 'deny']
  const rank = (d: Decision) => DECISIONS.indexOf(d)
  const cells = DECISIONS.flatMap(own => DECISIONS.map(derived => [own, derived] as const))

  const decisionEvent = async (config: LoopConfig, events: AgentEvent[]) => {
    await admitToolCall(read('data/a.json'), config, 0)
    const seen = events.filter(e => e.type === 'guardrail:decision')
    expect(seen).toHaveLength(1)
    const { decision, reasonCode, source } = seen[0].data as Record<string, unknown>
    return { decision, reasonCode, source }
  }

  it.each(cells)(
    'own %s, derived %s: only a strictly stricter derived decision wins',
    async (own, derived) => {
      const events: AgentEvent[] = []
      const config = makeConfig(new ReaderTool(), [], { events })
      config.guardrails = {
        async decide(_identity, input) {
          return {
            decision: own,
            reasonCode: `own_${own}`,
            effectiveInput: input,
            source: 'current',
          }
        },
        derivedFileReadDecision: () => ({ decision: derived, reasonCode: `derived_${derived}` }),
      }
      const expected =
        rank(derived) > rank(own)
          ? // The derived source is reported as host_rule (review finding 11, a follow-up:
            // an unmatched derived ask has no rule).
            { decision: derived, reasonCode: `derived_${derived}`, source: 'host_rule' }
          : { decision: own, reasonCode: `own_${own}`, source: 'current' }
      expect(await decisionEvent(config, events)).toEqual(expected)
    }
  )

  const RULE_ACTIONS = ['allow', 'ask', 'deny'] as const
  it.each(RULE_ACTIONS.flatMap(own => RULE_ACTIONS.map(derived => [own, derived] as const)))(
    'real rules, own %s and file_read %s: the stricter wins, and a tie keeps the call’s own rule',
    async (own, derived) => {
      const events: AgentEvent[] = []
      const config = makeConfig(
        new ReaderTool(),
        [
          {
            id: 'own',
            action: own,
            reasonCode: `own_${own}`,
            match: { tool: { provenance: 'native', name: 'reader_tool' } },
          },
          {
            id: 'read',
            action: derived,
            reasonCode: `read_${derived}`,
            match: {
              tool: { provenance: 'native', name: 'file_read' },
              arguments: [{ type: 'path', pointer: '/path', op: 'under', value: 'data' }],
            },
          },
        ],
        { events }
      )
      const expected =
        rank(derived) > rank(own)
          ? { decision: derived, reasonCode: `read_${derived}`, source: 'host_rule' }
          : { decision: own, reasonCode: `own_${own}`, source: 'host_rule' }
      expect(await decisionEvent(config, events)).toEqual(expected)
    }
  )
})
