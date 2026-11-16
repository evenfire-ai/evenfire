import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { register } from 'prom-client'
import { config } from '../../config'
import { LlmErrorCode } from '../../core/errors'
import {
  clerumSpilloverPersistedTotal,
  clerumSpilloverReadsTotal,
  clerumToolOutputBytes,
} from '../../core/spillover'
import { FinishReason } from '../../core/types'
import type { SingleTurnProvider } from '../../llm'
import type { McpClientConnection, McpClientFactory } from '../stepRouter'
import {
  clerumWorkflowStepSpilloverPersistedTotal,
  clerumWorkflowStepSpilloverReadsTotal,
} from '../stepSpillover'
import { WorkflowService } from '../workflowService'

type MockResponse = {
  content: string | null
  tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> | null
  finish_reason?: string
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
}

// Tool names offered on each provider call, captured at call time: the step
// loop extends its tool list in place once a result is spilled.
const offeredByProvider = new WeakMap<SingleTurnProvider, string[][]>()

function mockLlmProvider(responses: MockResponse[]): SingleTurnProvider {
  let i = 0
  const offered: string[][] = []
  const provider: SingleTurnProvider = {
    completeSingleTurn: vi.fn().mockImplementation(() => {
      const r = responses[i++] ?? { content: 'done' }
      return Promise.resolve({
        content: r.content ?? '',
        usage: r.usage ?? { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: r.finish_reason ?? 'stop',
      })
    }),
    completeSingleTurnWithTools: vi.fn().mockImplementation((_messages, tools) => {
      offered.push((tools as Array<{ name: string }>).map(t => t.name))
      const r = responses[i++] ?? { content: 'done', tool_calls: null }
      return Promise.resolve({
        content: r.content,
        tool_calls: r.tool_calls ?? null,
        usage: r.usage ?? { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: r.finish_reason ?? (r.tool_calls ? 'tool_use' : 'stop'),
      })
    }),
    getProviderType: () => 'openai',
    classifyError: vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'mock',
    })),
  }
  offeredByProvider.set(provider, offered)
  return provider
}

function mockMcpClient(
  tools: Array<{ name: string }> = [],
  callResults: Record<string, { content: unknown; isError?: boolean }> = {}
): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools.map(t => ({ name: t.name, description: '' }))),
    callTool: vi.fn().mockImplementation((name: string) => {
      const r = callResults[name]
      return Promise.resolve(
        r
          ? { content: r.content, isError: r.isError ?? false }
          : { content: sdk(`result-${name}`), isError: false }
      )
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

function mockMcpFactory(clients: Map<string, McpClientConnection> = new Map()): McpClientFactory {
  return server => clients.get(server.name) ?? mockMcpClient()
}

const SERVERS = [{ name: 'srv', url: 'http://srv' }]
const STEP_ID = 'review'
const READ_TOOL = 'clerum__spillover_read'
const FIRST_REF = `spillover://${STEP_ID}/i1c0.json`

function service(llm: SingleTurnProvider, client: McpClientConnection): WorkflowService {
  const svc = new WorkflowService('test-recipe', {
    llmFactory: () => llm,
    mcpClientFactory: mockMcpFactory(new Map([['srv', client]])),
  })
  svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-123' })
  return svc
}

type WithToolsCall = [Array<{ role: string; content: string }>, Array<{ name: string }>, unknown]

function providerCalls(llm: SingleTurnProvider): WithToolsCall[] {
  return vi.mocked(llm.completeSingleTurnWithTools).mock.calls as unknown as WithToolsCall[]
}

function offeredTools(llm: SingleTurnProvider): string[][] {
  return offeredByProvider.get(llm) ?? []
}

function toolResultMessages(llm: SingleTurnProvider): string[] {
  const calls = providerCalls(llm)
  const last = calls[calls.length - 1]?.[0] ?? []
  return last.filter(m => m.content.startsWith('<tool-result ')).map(m => m.content)
}

const big = (size: number): string => 'L'.repeat(size)
// The MCP client returns the SDK CallToolResult, whose `content` is a block array.
const sdk = (...texts: string[]): Array<{ type: 'text'; text: string }> =>
  texts.map(text => ({ type: 'text' as const, text }))
const inline = (name: string, content: unknown): string =>
  `<tool-result server="${name}" data-only="true">\n${JSON.stringify(content)}\n</tool-result>`

let outputDir: string

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-spillover-'))
  vi.stubEnv('CLERUM_OUTPUT_DIR', outputDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(outputDir, { recursive: true, force: true })
})

describe('WorkflowService step spillover — default (enabled)', () => {
  it('spills a 300 KiB MCP result, then offers the read tool', async () => {
    const payload = big(300 * 1024)
    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(payload) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: { path: 'a' } }] },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const [toolResult] = toolResultMessages(llm)
    expect(toolResult).toContain('[Result stored outside the prompt (')
    expect(toolResult).toContain(`"spillover_ref":"${FIRST_REF}"`)
    expect(toolResult).not.toContain(payload)
    expect(toolResult!.length).toBeLessThan(4096)
    expect(res.toolsCalled?.[0]?.result).toEqual(sdk(payload))
    expect(offeredTools(llm)[0]).not.toContain(READ_TOOL)
    expect(offeredTools(llm)[1]).toContain(READ_TOOL)
  })

  it('leaves a step with small results unchanged', async () => {
    const payload = sdk(big(1024))
    const client = mockMcpClient([{ name: 'read' }], { read: { content: payload } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const expectedResult = inline('srv__read', payload)
    expect(toolResultMessages(llm)).toEqual([expectedResult, expectedResult])
    const offered = offeredTools(llm)
    expect(offered).toHaveLength(3)
    for (const names of offered) expect(names).toEqual(offered[0])
    expect(offered[0]).not.toContain(READ_TOOL)
    expect(await fs.readdir(outputDir)).toEqual([])
  })

  it('keeps a 100 KiB result inline under the default 128 KiB threshold', async () => {
    const payload = sdk(big(100 * 1024))
    const client = mockMcpClient([{ name: 'read' }, { name: 'dump' }], {
      read: { content: payload },
      dump: { content: sdk(big(300 * 1024)) },
    })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__dump', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const [first, second] = toolResultMessages(llm)
    expect(first).toBe(inline('srv__read', payload))
    expect(offeredTools(llm)[1]).not.toContain(READ_TOOL)
    // Witness: spillover is on in this step, so the larger result is stored.
    expect(second).toContain('[Result stored outside the prompt (')
    expect(offeredTools(llm)[2]).toContain(READ_TOOL)
  })

  it('makes the read tool callable under an allowlist only after a spill', async () => {
    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(big(192 * 1024)) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: READ_TOOL, arguments: { ref: FIRST_REF } }] },
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      {
        content: null,
        tool_calls: [
          { name: READ_TOOL, arguments: { ref: FIRST_REF.replace('i1c0', 'i2c0') } },
          { name: 'clerum__generate_markdown', arguments: { filename: 'x.md', content: 'x' } },
        ],
      },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
      allowedTools: { include: ['srv__read'] },
    })

    expect(res.status).toBe('completed')
    const offered = offeredTools(llm)
    expect(offered[0]).toEqual(['srv__read'])
    expect(offered[1]).toEqual(['srv__read'])
    expect(offered[2]).toEqual(['srv__read', READ_TOOL])
    const records = res.toolsCalled ?? []
    // Before the first spill the read tool is outside the allowlist.
    expect(records[0]?.result).toMatchObject({ success: false })
    expect(JSON.stringify(records[0]?.result)).toContain('is not allowed in this step')
    // After the spill it is callable (192 KiB > threshold, so a whole read is refused
    // by the size limit, not by the allowlist).
    expect(records[2]?.result).toMatchObject({ success: false })
    expect(JSON.stringify(records[2]?.result)).toContain('pass range')
    // An internal tool the allowlist does not name stays rejected.
    expect(records[3]?.toolName).toBe('generate_markdown')
    expect(JSON.stringify(records[3]?.result)).toContain('is not allowed in this step')
  })

  it('returns a byte range and records only ref and size', async () => {
    const payload = Array.from({ length: 150 * 1024 }, (_, i) =>
      String.fromCharCode(97 + (i % 26))
    ).join('')
    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(payload) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      {
        content: null,
        tool_calls: [
          { name: READ_TOOL, arguments: { ref: FIRST_REF, range: { start: 1000, end: 1100 } } },
        ],
      },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const slice = payload.slice(1000, 1100)
    const readResult = toolResultMessages(llm)[1]
    expect(readResult).toContain(`server="${READ_TOOL}"`)
    expect(readResult).toContain(JSON.stringify(slice).slice(1, -1))
    expect(res.toolsCalled?.[1]?.result).toEqual({ success: true, ref: FIRST_REF, bytes: 100 })
    expect(JSON.stringify(res.toolsCalled?.[1])).not.toContain(slice)
  })

  it('answers a whole read of a large blob with a recoverable error', async () => {
    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(big(300 * 1024)) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: null, tool_calls: [{ name: READ_TOOL, arguments: { ref: FIRST_REF } }] },
      { content: 'recovered', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    expect(res.output).toBe('recovered')
    expect(toolResultMessages(llm)[1]).toContain('pass range {start,end}')
    expect(res.toolsCalled?.[1]?.result).toMatchObject({ success: false, ref: FIRST_REF })
  })

  it('does not spill a large tool error', async () => {
    const payload = big(300 * 1024)
    const client = mockMcpClient([{ name: 'read' }], {
      read: { content: sdk(payload), isError: true },
    })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(toolResultMessages(llm)[0]).toContain(payload)
    expect(offeredTools(llm)[1]).not.toContain(READ_TOOL)
    expect(await fs.readdir(outputDir)).toEqual([])
  })

  it('creates no store and offers no read tool for a text-only step', async () => {
    const llm = mockLlmProvider([{ content: 'analysis', tool_calls: null }])
    const res = await service(llm, mockMcpClient()).executeStep({
      stepId: STEP_ID,
      instruction: 'analyse',
    })
    expect(res.status).toBe('completed')
    expect(llm.completeSingleTurnWithTools).not.toHaveBeenCalled()
    expect(await fs.readdir(outputDir)).toEqual([])
  })

  it('still fails required-tool-unavailable when the allowlist names no existing tool', async () => {
    const llm = mockLlmProvider([{ content: 'x', tool_calls: null }])
    const res = await service(llm, mockMcpClient([{ name: 'read' }])).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
      allowedTools: { include: ['nope__missing'] },
      toolChoice: 'required',
    })
    expect(res.status).toBe('failed')
    expect(res.error).toContain('required-tool-unavailable')
  })

  it('keeps the artifact output when a large artifact result was spilled', async () => {
    const artifact = {
      success: true,
      artifact: {
        name: 'report.pdf',
        format: 'pdf',
        path: '/output/report.pdf',
        sizeBytes: 12,
        createdAt: '2026-05-13T00:00:00.000Z',
      },
      notes: big(192 * 1024),
    }
    const client = mockMcpClient([{ name: 'make_report' }], { make_report: { content: artifact } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__make_report', arguments: {} }] },
      { content: 'partial', finish_reason: FinishReason.Length },
      { content: 'still partial', finish_reason: FinishReason.Length },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'report',
      mcpServers: SERVERS,
    })

    expect(toolResultMessages(llm)[0]).toContain('[Result stored outside the prompt (')
    expect(res.status).toBe('completed')
    expect(res.output).toContain('Use the run artifacts for the complete output')
    expect(res.output).toContain('report.pdf')
    expect(res.toolsCalled?.[0]?.result).toEqual(artifact)
  })
})

describe('WorkflowService step spillover — what is stored', () => {
  const summaryOf = (message: string) => JSON.parse(message.split('\n')[2]!)

  it('summarises and reads back the tool text of an MCP text result', async () => {
    const a = 'row line\n'.repeat(20000)
    const b = 'tail block'
    const blocks = sdk(a, b)
    const client = mockMcpClient([{ name: 'read' }], { read: { content: blocks } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      {
        content: null,
        tool_calls: [
          { name: READ_TOOL, arguments: { ref: FIRST_REF, range: { start: 0, end: 18 } } },
        ],
      },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const text = `${a}\n${b}`
    const [stored, readBack] = toolResultMessages(llm)
    const summary = summaryOf(stored!)
    expect(summary.byte_size).toBe(Buffer.byteLength(text, 'utf8'))
    expect(summary.line_count).toBe(20002)
    expect(summary.head).toBe(text.slice(0, 400))
    expect(summary.tail).toBe(text.slice(-400))
    expect(readBack).toBe(inline(READ_TOOL, { success: true, content: 'row line\nrow line\n' }))
    expect(res.toolsCalled?.[0]?.result).toEqual(blocks)
  })

  it('keeps the serialized prompt of an MCP text result that is not stored', async () => {
    const small = sdk('small\ntext')
    const client = mockMcpClient([{ name: 'read' }, { name: 'dump' }], {
      read: { content: small },
      dump: { content: sdk(big(300 * 1024)) },
    })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__dump', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    const [first, second] = toolResultMessages(llm)
    expect(first).toBe(inline('srv__read', small))
    // Witness: spillover is on in this step, so the large result is stored.
    expect(second).toContain('[Result stored outside the prompt (')
  })

  it('stores mixed MCP blocks serialized', async () => {
    const mixed = [
      { type: 'text', text: big(200 * 1024) },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]
    const client = mockMcpClient([{ name: 'read' }], { read: { content: mixed } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    const serialized = JSON.stringify(mixed)
    const summary = summaryOf(toolResultMessages(llm)[0]!)
    expect(summary.spillover_ref).toBe(FIRST_REF)
    expect(summary.byte_size).toBe(Buffer.byteLength(serialized, 'utf8'))
    expect(summary.head).toBe(serialized.slice(0, 400))
  })

  it('stores an internal tool result serialized', async () => {
    vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD', '4096')
    // Twelve missing images, each named with 400 letters, make the generator's
    // notes long enough to reach the 4096-byte threshold.
    const images = 'abcdefghijkl'.split('').map(letter => `${letter.repeat(400)}.png`)
    const llm = mockLlmProvider([
      {
        content: null,
        tool_calls: [
          {
            name: 'clerum__generate_pdf',
            arguments: { filename: 'report.pdf', title: 'Report', body: 'Body text.', images },
          },
        ],
      },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, mockMcpClient([{ name: 'read' }])).executeStep({
      stepId: STEP_ID,
      instruction: 'report',
      mcpServers: SERVERS,
    })

    const record = res.toolsCalled?.[0]?.result
    expect(record).toMatchObject({ success: true, artifact: { name: 'report.pdf' } })
    const serialized = JSON.stringify(record)
    const summary = summaryOf(toolResultMessages(llm)[0]!)
    expect(summary.spillover_ref).toBe(FIRST_REF)
    expect(summary.byte_size).toBe(Buffer.byteLength(serialized, 'utf8'))
    expect(summary.head).toBe(serialized.slice(0, 400))
  })

  it.each([
    ['quotes', '"'],
    ['control characters', '\u0001'],
  ])(
    'decides on the serialized size: stores a text under the threshold made of %s',
    async (_label, char) => {
      vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD', '4096')
      const text = char.repeat(4000)
      const blocks = sdk(text)
      // The text is under the threshold; the string the prompt would carry is not.
      expect(Buffer.byteLength(text, 'utf8')).toBe(4000)
      expect(Buffer.byteLength(JSON.stringify(blocks), 'utf8')).toBeGreaterThanOrEqual(4096)
      const client = mockMcpClient([{ name: 'read' }], { read: { content: blocks } })
      const llm = mockLlmProvider([
        { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
        { content: null, tool_calls: [{ name: READ_TOOL, arguments: { ref: FIRST_REF } }] },
        { content: 'done', tool_calls: null },
      ])

      const res = await service(llm, client).executeStep({
        stepId: STEP_ID,
        instruction: 'review',
        mcpServers: SERVERS,
      })

      expect(res.status).toBe('completed')
      const summary = summaryOf(toolResultMessages(llm)[0]!)
      expect(summary.spillover_ref).toBe(FIRST_REF)
      expect(summary.byte_size).toBe(4000)
      // The stored text is under the read limit, so it reads back whole.
      expect(res.toolsCalled?.[1]?.result).toEqual({ success: true, ref: FIRST_REF, bytes: 4000 })
    }
  )
})

describe('WorkflowService step spillover — iteration limit', () => {
  const countRead = (names: string[]): number => names.filter(n => n === READ_TOOL).length

  it.each([
    ['auto', undefined],
    ['required', 'required' as const],
  ])(
    'keeps a result inline when the next call is sent without tools (%s)',
    async (_label, toolChoice) => {
      const content = sdk(big(200 * 1024))
      const run = async (maxIterations: number) => {
        const client = mockMcpClient([{ name: 'read' }], { read: { content } })
        const llm = mockLlmProvider([
          { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
          { content: 'final', tool_calls: null },
        ])
        const res = await service(llm, client).executeStep({
          stepId: STEP_ID,
          instruction: 'review',
          mcpServers: SERVERS,
          maxIterations,
          ...(toolChoice ? { toolChoice } : {}),
        })
        return { res, llm }
      }

      const two = await run(2)
      expect(two.res.status).toBe('completed')
      expect(offeredTools(two.llm)[1]).toEqual([])
      expect(toolResultMessages(two.llm)).toEqual([inline('srv__read', content)])
      // Witness: the same result is stored when a later call can read it back.
      const three = await run(3)
      expect(toolResultMessages(three.llm)[0]).toContain(`"spillover_ref":"${FIRST_REF}"`)
      expect(countRead(offeredTools(three.llm)[1]!)).toBe(1)
    }
  )

  it('stores a result on the third-to-last iteration and keeps one on the second-to-last inline', async () => {
    const content = sdk(big(200 * 1024))
    const client = mockMcpClient([{ name: 'read' }], { read: { content } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'final', tool_calls: null },
    ])

    await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
      maxIterations: 3,
    })

    const [first, second] = toolResultMessages(llm)
    expect(first).toContain(`"spillover_ref":"${FIRST_REF}"`)
    expect(second).toBe(inline('srv__read', content))
    expect(offeredTools(llm)[2]).toEqual([])
  })

  it('still stores a result on the last iteration of a required step, where no call follows', async () => {
    const persisted = () =>
      metricTotal('clerum_workflow_step_spillover_persisted_total', { tool: 'srv__read' })
    const before = await persisted()
    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(big(200 * 1024)) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
      maxIterations: 1,
      toolChoice: 'required',
    })

    expect(res.status).toBe('completed')
    expect(providerCalls(llm)).toHaveLength(1)
    expect(await persisted()).toBe(before + 1)
  })
})

describe('WorkflowService step spillover — kill switch', () => {
  it('keeps the full result inline and never offers the read tool', async () => {
    vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED', 'false')
    const payload = sdk(big(300 * 1024))
    const client = mockMcpClient([{ name: 'read' }], { read: { content: payload } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    expect(toolResultMessages(llm)[0]).toBe(inline('srv__read', payload))
    for (const names of offeredTools(llm)) expect(names).not.toContain(READ_TOOL)
    expect(await fs.readdir(outputDir)).toEqual([])
  })
})

describe('WorkflowService step spillover — configured threshold', () => {
  it('spills an 8 KiB result with a 4 KiB threshold', async () => {
    vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD', '4096')
    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(big(8 * 1024)) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(toolResultMessages(llm)[0]).toContain('of at most 4096 bytes.]')
    expect(offeredTools(llm)[1]).toContain(READ_TOOL)
  })
})

describe('WorkflowService step spillover — configured budget', () => {
  it('applies the configured budget to the step', async () => {
    // 1 MiB is the smallest budget the resolver accepts; each result is
    // ~700 KiB, so only the first fits.
    vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES', '1048576')
    const payload = sdk(big(700 * 1024))
    const client = mockMcpClient([{ name: 'read' }], { read: { content: payload } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const [first, second] = toolResultMessages(llm)
    expect(first).toContain(`"spillover_ref":"${FIRST_REF}"`)
    expect(second).toBe(inline('srv__read', payload))
  })
})

describe('WorkflowService step spillover — first-party flag', () => {
  const firstPartyEnabled = config.toolSpilloverEnabled

  afterEach(() => {
    config.toolSpilloverEnabled = firstPartyEnabled
  })

  it('still spills when the first-party spillover is disabled', async () => {
    vi.stubEnv('CLERUM_TOOL_SPILLOVER_ENABLED', 'false')
    config.toolSpilloverEnabled = false
    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(big(300 * 1024)) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      { content: 'done', tool_calls: null },
    ])

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    expect(toolResultMessages(llm)[0]).toContain(`"spillover_ref":"${FIRST_REF}"`)
    expect(offeredTools(llm)[1]).toContain(READ_TOOL)
  })
})

describe('WorkflowService step spillover — other executions', () => {
  it('keeps the blobs of an execution when another execution of the same step ends', async () => {
    const payloadA = 'A'.repeat(300 * 1024)
    const payloadB = 'B'.repeat(300 * 1024)
    const client = mockMcpClient([{ name: 'a' }, { name: 'b' }], {
      a: { content: sdk(payloadA) },
      b: { content: sdk(payloadB) },
    })

    // Responses are routed by the step instruction, so both executions can
    // share the provider. Execution A's second response is held until B ends.
    let releaseA: () => void = () => undefined
    const holdA = new Promise<void>(resolve => {
      releaseA = resolve
    })
    let markReached: () => void = () => undefined
    const reachedA = new Promise<void>(resolve => {
      markReached = resolve
    })
    const scripts: Record<string, MockResponse[]> = {
      'run A': [
        { content: null, tool_calls: [{ name: 'srv__a', arguments: {} }] },
        {
          content: null,
          tool_calls: [
            { name: READ_TOOL, arguments: { ref: FIRST_REF, range: { start: 0, end: 20 } } },
          ],
        },
        { content: 'A done', tool_calls: null },
      ],
      'run B': [
        { content: null, tool_calls: [{ name: 'srv__b', arguments: {} }] },
        { content: 'B done', tool_calls: null },
      ],
    }
    const index: Record<string, number> = { 'run A': 0, 'run B': 0 }
    const llm = mockLlmProvider([])
    vi.mocked(llm.completeSingleTurnWithTools).mockImplementation(async messages => {
      const key = (messages as Array<{ role: string; content: string }>).some(
        m => m.role === 'user' && m.content === 'run A'
      )
        ? 'run A'
        : 'run B'
      const n = index[key]!
      index[key] = n + 1
      if (key === 'run A' && n === 1) {
        markReached()
        await holdA
      }
      const r = scripts[key]![n] ?? { content: 'done', tool_calls: null }
      return {
        content: r.content,
        tool_calls: r.tool_calls?.map((call, k) => ({ id: `${key}-${n}-${k}`, ...call })) ?? null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: r.tool_calls ? FinishReason.ToolUse : FinishReason.Stop,
      }
    })
    const svc = service(llm, client)

    const runA = svc.executeStep({ stepId: STEP_ID, instruction: 'run A', mcpServers: SERVERS })
    await reachedA
    const resB = await svc.executeStep({
      stepId: STEP_ID,
      instruction: 'run B',
      mcpServers: SERVERS,
    })
    expect(resB.status).toBe('completed')
    releaseA()
    const resA = await runA

    expect(resA.status).toBe('completed')
    expect(resA.toolsCalled?.[1]?.result).toEqual({ success: true, ref: FIRST_REF, bytes: 20 })
    const readMessage = vi
      .mocked(llm.completeSingleTurnWithTools)
      .mock.calls.map(([messages]) => messages as Array<{ role: string; content: string }>)
      .filter(messages => messages.some(m => m.content === 'run A'))
      .at(-1)!
      .find(m => m.content.startsWith(`<tool-result server="${READ_TOOL}"`))
    expect(readMessage?.content).toContain('AAAAAAAAAA')
    expect(readMessage?.content).not.toContain('BBBBBBBBBB')
  })
})

async function metricTotal(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (!metric) throw new Error(`metric ${name} is not registered`)
  const { values } = await metric.get()
  // A histogram reports _bucket, _sum and _count series; count observations only.
  const series = (v: object): string => (v as { metricName?: string }).metricName ?? name
  return values
    .filter(v => !series(v).endsWith('_bucket') && !series(v).endsWith('_sum'))
    .filter(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0)
}

describe('WorkflowService step spillover — metrics', () => {
  it('reports a spilled result and its read under the workflow-step counters only', async () => {
    // The module exports are the instruments the registry serves, so a delta
    // of 0 below cannot come from an unregistered duplicate.
    expect(register.getSingleMetric('clerum_spillover_persisted_total')).toBe(
      clerumSpilloverPersistedTotal
    )
    expect(register.getSingleMetric('clerum_spillover_reads_total')).toBe(clerumSpilloverReadsTotal)
    expect(register.getSingleMetric('clerum_tool_output_bytes')).toBe(clerumToolOutputBytes)
    expect(register.getSingleMetric('clerum_workflow_step_spillover_persisted_total')).toBe(
      clerumWorkflowStepSpilloverPersistedTotal
    )
    expect(register.getSingleMetric('clerum_workflow_step_spillover_reads_total')).toBe(
      clerumWorkflowStepSpilloverReadsTotal
    )

    const before = {
      stepPersisted: await metricTotal('clerum_workflow_step_spillover_persisted_total', {
        tool: 'srv__read',
      }),
      stepReads: await metricTotal('clerum_workflow_step_spillover_reads_total', {
        with_range: 'true',
      }),
      persisted: await metricTotal('clerum_spillover_persisted_total'),
      reads: await metricTotal('clerum_spillover_reads_total'),
      outputBytes: await metricTotal('clerum_tool_output_bytes'),
    }

    const client = mockMcpClient([{ name: 'read' }], { read: { content: sdk(big(300 * 1024)) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      {
        content: null,
        tool_calls: [
          { name: READ_TOOL, arguments: { ref: FIRST_REF, range: { start: 0, end: 10 } } },
        ],
      },
      { content: 'done', tool_calls: null },
    ])
    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    expect(toolResultMessages(llm)[0]).toContain(`"spillover_ref":"${FIRST_REF}"`)
    expect(res.toolsCalled?.[1]?.result).toEqual({ success: true, ref: FIRST_REF, bytes: 10 })
    expect(
      await metricTotal('clerum_workflow_step_spillover_persisted_total', { tool: 'srv__read' })
    ).toBe(before.stepPersisted + 1)
    expect(
      await metricTotal('clerum_workflow_step_spillover_reads_total', { with_range: 'true' })
    ).toBe(before.stepReads + 1)
    expect(await metricTotal('clerum_spillover_persisted_total')).toBe(before.persisted)
    expect(await metricTotal('clerum_spillover_reads_total')).toBe(before.reads)
    expect(await metricTotal('clerum_tool_output_bytes')).toBe(before.outputBytes)
  })
})
