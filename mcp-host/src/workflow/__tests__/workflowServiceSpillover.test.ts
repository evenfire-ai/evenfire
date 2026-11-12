import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { config } from '../../config'
import { LlmErrorCode } from '../../core/errors'
import { FinishReason } from '../../core/types'
import type { SingleTurnProvider } from '../../llm'
import type { McpClientConnection, McpClientFactory } from '../stepRouter'
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
          : { content: `result-${name}`, isError: false }
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

const big = (size: number): string => 'L'.repeat(size)

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
  it('spills a 100 KiB MCP result, then offers the read tool, and cleans up', async () => {
    const payload = big(100 * 1024)
    const client = mockMcpClient([{ name: 'read' }], { read: { content: payload } })
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
    expect(res.toolsCalled?.[0]?.result).toBe(payload)
    expect(offeredTools(llm)[0]).not.toContain(READ_TOOL)
    expect(offeredTools(llm)[1]).toContain(READ_TOOL)
    expect(await exists(path.join(outputDir, '.spill'))).toBe(false)
  })

  it('leaves a step with small results unchanged', async () => {
    const payload = big(1024)
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
    const expectedResult = `<tool-result server="srv__read" data-only="true">\n${JSON.stringify(payload)}\n</tool-result>`
    expect(toolResultMessages(llm)).toEqual([expectedResult, expectedResult])
    const offered = offeredTools(llm)
    expect(offered).toHaveLength(3)
    for (const names of offered) expect(names).toEqual(offered[0])
    expect(offered[0]).not.toContain(READ_TOOL)
    expect(await fs.readdir(outputDir)).toEqual([])
  })

  it('makes the read tool callable under an allowlist only after a spill', async () => {
    const client = mockMcpClient([{ name: 'read' }], { read: { content: big(64 * 1024) } })
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
    // After the spill it is callable (64 KiB > threshold, so a whole read is refused
    // by the size limit, not by the allowlist).
    expect(records[2]?.result).toMatchObject({ success: false })
    expect(JSON.stringify(records[2]?.result)).toContain('pass range')
    // An internal tool the allowlist does not name stays rejected.
    expect(records[3]?.toolName).toBe('generate_markdown')
    expect(JSON.stringify(records[3]?.result)).toContain('is not allowed in this step')
  })

  it('returns a byte range and records only ref and size', async () => {
    const payload = Array.from({ length: 50 * 1024 }, (_, i) =>
      String.fromCharCode(97 + (i % 26))
    ).join('')
    const serialized = JSON.stringify(payload)
    const client = mockMcpClient([{ name: 'read' }], { read: { content: payload } })
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
    const slice = serialized.slice(1000, 1100)
    const readResult = toolResultMessages(llm)[1]
    expect(readResult).toContain(`server="${READ_TOOL}"`)
    expect(readResult).toContain(JSON.stringify(slice).slice(1, -1))
    expect(res.toolsCalled?.[1]?.result).toEqual({ success: true, ref: FIRST_REF, bytes: 100 })
    expect(JSON.stringify(res.toolsCalled?.[1])).not.toContain(slice)
  })

  it('answers a whole read of a large blob with a recoverable error', async () => {
    const client = mockMcpClient([{ name: 'read' }], { read: { content: big(100 * 1024) } })
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
    const payload = big(100 * 1024)
    const client = mockMcpClient([{ name: 'read' }], {
      read: { content: payload, isError: true },
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
      notes: big(64 * 1024),
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

  it('removes the spill directory when the step fails after spilling', async () => {
    const client = mockMcpClient([{ name: 'read' }], { read: { content: big(100 * 1024) } })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
    ])
    let calls = 0
    vi.mocked(llm.completeSingleTurnWithTools).mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          content: null,
          tool_calls: [{ id: 'call-1', name: 'srv__read', arguments: {} }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: FinishReason.ToolUse,
        })
      }
      return Promise.reject(new Error('provider exploded'))
    })

    const res = await service(llm, client).executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('failed')
    expect(await exists(path.join(outputDir, '.spill'))).toBe(false)
  })

  it('removes the spill directory when the step is aborted after spilling', async () => {
    const client = mockMcpClient([{ name: 'read' }], { read: { content: big(100 * 1024) } })
    const llm = mockLlmProvider([])
    const controller = new AbortController()
    let calls = 0
    vi.mocked(llm.completeSingleTurnWithTools).mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          content: null,
          tool_calls: [{ id: 'call-1', name: 'srv__read', arguments: {} }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: FinishReason.ToolUse,
        })
      }
      // The spill already happened; abort while the next call is pending.
      setTimeout(() => controller.abort('step-timeout'), 0)
      return new Promise(() => undefined)
    })

    const res = await service(llm, client).executeStep(
      { stepId: STEP_ID, instruction: 'review', mcpServers: SERVERS },
      undefined,
      { signal: controller.signal }
    )

    expect(res.status).toBe('failed')
    expect(await exists(path.join(outputDir, '.spill'))).toBe(false)
  })
})

describe('WorkflowService step spillover — kill switch', () => {
  it('keeps the full result inline and never offers the read tool', async () => {
    vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED', 'false')
    const payload = big(100 * 1024)
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
    expect(toolResultMessages(llm)[0]).toBe(
      `<tool-result server="srv__read" data-only="true">\n${JSON.stringify(payload)}\n</tool-result>`
    )
    for (const names of offeredTools(llm)) expect(names).not.toContain(READ_TOOL)
    expect(await fs.readdir(outputDir)).toEqual([])
  })
})

describe('WorkflowService step spillover — configured threshold', () => {
  it('spills an 8 KiB result with a 4 KiB threshold', async () => {
    vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD', '4096')
    const client = mockMcpClient([{ name: 'read' }], { read: { content: big(8 * 1024) } })
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
    const payload = big(700 * 1024)
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
    expect(second).toBe(
      `<tool-result server="srv__read" data-only="true">\n${JSON.stringify(payload)}\n</tool-result>`
    )
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
    const client = mockMcpClient([{ name: 'read' }], { read: { content: big(100 * 1024) } })
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

function blobFile(content: string): string {
  return JSON.stringify({
    version: 1,
    tool_call_id: 'i9c9',
    tool_name: 'srv__read',
    task_id: STEP_ID,
    created_at_ms: Date.now(),
    byte_size: Buffer.byteLength(content, 'utf8'),
    line_count: 1,
    content_type: 'text',
    fingerprint_sha256: 'x',
    content,
  })
}

async function seedSpill(rel: string, body: string): Promise<string> {
  const file = path.join(outputDir, '.spill', rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
  return file
}

describe('WorkflowService step spillover — files of other executions', () => {
  it.each([
    ['enabled', undefined],
    ['disabled', 'false'],
  ])(
    'removes spill files left by an earlier process before the first step (%s)',
    async (_label, enabled) => {
      if (enabled !== undefined) vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED', enabled)
      const leftovers = [
        await seedSpill('spillover/review/i1c0.json', blobFile('OLD-LAYOUT-MARKER')),
        await seedSpill('deadbeefdeadbeef/spillover/review/i1c0.json', blobFile('DEAD-MARKER')),
      ]
      const unrelated = await seedSpill('keep.txt', 'not written by spillover')
      for (const f of [...leftovers, unrelated]) expect(await exists(f)).toBe(true)

      const payload = big(1024)
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
      expect(llm.completeSingleTurnWithTools).toHaveBeenCalledTimes(2)
      expect(toolResultMessages(llm)).toEqual([
        `<tool-result server="srv__read" data-only="true">\n${JSON.stringify(payload)}\n</tool-result>`,
      ])
      expect(await fs.readdir(path.join(outputDir, '.spill'))).toEqual(['keep.txt'])
    }
  )

  it('does not let a step read a blob left under the same ref by another execution', async () => {
    const llm = mockLlmProvider([
      // Step 1 (text only) runs the once-per-process removal first.
      { content: 'warm-up done' },
      // Step 2: spill, read a foreign ref, read its own ref.
      { content: null, tool_calls: [{ name: 'srv__read', arguments: {} }] },
      {
        content: null,
        tool_calls: [{ name: READ_TOOL, arguments: { ref: `spillover://${STEP_ID}/i9c9.json` } }],
      },
      {
        content: null,
        tool_calls: [
          { name: READ_TOOL, arguments: { ref: FIRST_REF, range: { start: 0, end: 50 } } },
        ],
      },
      { content: 'done', tool_calls: null },
    ])
    const payload = big(100 * 1024)
    const svc = service(llm, mockMcpClient([{ name: 'read' }], { read: { content: payload } }))
    const warmUp = await svc.executeStep({ stepId: 'warm-up', instruction: 'warm up' })
    expect(warmUp.status).toBe('completed')

    await seedSpill('spillover/review/i9c9.json', blobFile('FOREIGN-OLD-LAYOUT'))
    await seedSpill('0123456789abcdef/spillover/review/i9c9.json', blobFile('FOREIGN-EXECUTION'))

    const res = await svc.executeStep({
      stepId: STEP_ID,
      instruction: 'review',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const records = res.toolsCalled ?? []
    expect(records[1]?.result).toEqual({
      success: false,
      ref: `spillover://${STEP_ID}/i9c9.json`,
      error: 'spillover blob not found',
    })
    expect(records[2]?.result).toEqual({ success: true, ref: FIRST_REF, bytes: 50 })
    const prompt = providerCalls(llm).flatMap(([messages]) => messages.map(m => m.content))
    for (const text of prompt) {
      expect(text).not.toContain('FOREIGN-OLD-LAYOUT')
      expect(text).not.toContain('FOREIGN-EXECUTION')
    }
  })

  it('keeps the blobs of an execution when another execution of the same step ends', async () => {
    const payloadA = 'A'.repeat(100 * 1024)
    const payloadB = 'B'.repeat(100 * 1024)
    const client = mockMcpClient([{ name: 'a' }, { name: 'b' }], {
      a: { content: payloadA },
      b: { content: payloadB },
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
    expect(await exists(path.join(outputDir, '.spill'))).toBe(false)
  })
})
