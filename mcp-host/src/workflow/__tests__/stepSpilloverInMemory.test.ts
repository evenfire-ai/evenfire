// The step store keeps spilled results in memory: these tests cover where the
// results live, and that they are dropped however the step execution ends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { McpToolRegistryAdapter } from '../../core/adapters/toolRegistryAdapter'
import { LlmErrorCode } from '../../core/errors'
import { BasicSafety } from '../../core/safety/safety'
import { SpilloverStorage } from '../../core/spillover'
import type { SingleTurnProvider } from '../../llm'
import { logger } from '../../logger'
import type { McpClientConnection } from '../stepRouter'
import { createStepSpillover } from '../stepSpillover'
import type { StepSpillover } from '../stepSpillover'
import { WorkflowService } from '../workflowService'

const captured = vi.hoisted(() => ({ stores: [] as unknown[] }))
vi.mock('../stepSpillover', async importOriginal => {
  const actual = await importOriginal<typeof import('../stepSpillover')>()
  return {
    ...actual,
    // The real store; the test keeps a reference to look at it after the step.
    createStepSpillover: (opts: Parameters<typeof actual.createStepSpillover>[0]) => {
      const store = actual.createStepSpillover(opts)
      if (store) captured.stores.push(store)
      return store
    },
  }
})

const THRESHOLD = 4096
const content = 'w'.repeat(THRESHOLD * 2)
const make = (stepId = 'review'): StepSpillover =>
  createStepSpillover({ stepId, thresholdBytes: THRESHOLD, budgetBytes: 1 << 20 })!
const persist = (s: StepSpillover, callId: string, text = content) =>
  s.persist({
    callId,
    toolName: 'srv__read',
    content: text,
    inlineBytes: Buffer.byteLength(text, 'utf8'),
    isError: false,
  })
const read = (s: StepSpillover, callId: string, stepId = 'review') =>
  s.readTool.execute(
    { ref: `spillover://${stepId}/${callId}.json`, range: { start: 0, end: 4 } },
    ''
  )

let outputDir: string
beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-spill-memory-'))
  vi.stubEnv('CLERUM_OUTPUT_DIR', outputDir)
  captured.stores.length = 0
  diskDuringStep.length = 0
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fs.rm(outputDir, { recursive: true, force: true })
})

describe('createStepSpillover — results are kept in memory', () => {
  it.each([
    ['with a trailing line feed', `${'row\n'.repeat(2000)}`],
    ['without a trailing line feed', `${'row\n'.repeat(2000)}last`],
    ['with blank lines', `${'row\n\n'.repeat(1500)}end\n`],
  ])('counts lines as the first-party store does for raw text %s', async (_label, text) => {
    const firstParty = new SpilloverStorage({
      workspacePath: outputDir,
      thresholdBytes: THRESHOLD,
      ttlMs: 0,
      gcIntervalMs: 0,
    })
    const expected = await firstParty.maybePersist({
      taskId: 'review',
      toolCallId: 'c1',
      toolName: 'srv__read',
      content: text,
      isError: false,
    })
    // Witness: the input is large enough to be stored by both stores.
    expect(expected).not.toBeNull()

    const res = await persist(make(), 'c1', text)

    expect(res.spilled).toBe(true)
    const summary = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1))
    expect(summary.line_count).toBe(expected!.line_count)
    expect(summary).toEqual(expected)
  })

  it('reads a stored result back, and finds nothing after release', async () => {
    const s = make()
    expect((await persist(s, 'c1')).spilled).toBe(true)
    // Witness: the result is readable until the store is released.
    expect(await read(s, 'c1')).toEqual({ success: true, content: 'wwww' })

    s.release()

    expect(await read(s, 'c1')).toEqual({ success: false, error: 'spillover blob not found' })
  })

  it('keeps the results of two executions of the same step apart', async () => {
    const a = make()
    const b = make()
    expect((await persist(a, 'c1')).spilled).toBe(true)
    // Witness: the ref resolves in the execution that stored it.
    expect((await read(a, 'c1')).success).toBe(true)

    expect(await read(b, 'c1')).toEqual({ success: false, error: 'spillover blob not found' })
  })

  it('keeps a result inline, with a warning, when its call id is not a valid ref segment', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const s = make()
    const bad = await s.persist({
      callId: 'a/b',
      toolName: 't',
      content,
      inlineBytes: Buffer.byteLength(content, 'utf8'),
      isError: false,
    })
    expect(bad).toEqual({ text: content, spilled: false })
    const refused = warn.mock.calls.filter(([, msg]) =>
      String(msg).includes('Call id is not a valid spillover segment')
    )
    expect(refused).toHaveLength(1)
    expect(refused[0]![0]).toMatchObject({ stepId: 'review', toolName: 't' })
    // A refused call id does not stop later results from being stored.
    expect((await persist(s, 'c2')).spilled).toBe(true)
  })

  it('keeps a result inline when it would take the execution over its budget, and still stores a later one that fits', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const s = createStepSpillover({
      stepId: 'review',
      thresholdBytes: THRESHOLD,
      budgetBytes: THRESHOLD * 3,
    })!
    expect((await persist(s, 'c1')).spilled).toBe(true)

    const over = await persist(s, 'c2')
    const fits = await persist(s, 'c3', 'w'.repeat(THRESHOLD))

    expect(over).toEqual({ text: content, spilled: false })
    expect(fits.spilled).toBe(true)
    // Witness: the store is live (c1 and c3 are readable); only c2 was kept out.
    expect((await read(s, 'c1')).success).toBe(true)
    expect((await read(s, 'c3')).success).toBe(true)
    expect(await read(s, 'c2')).toEqual({ success: false, error: 'spillover blob not found' })
    expect(
      warn.mock.calls.filter(([, msg]) =>
        String(msg).includes('does not fit in the step spillover budget')
      )
    ).toHaveLength(1)
  })
})

// ── through WorkflowService ─────────────────────────────────────────────
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
// The output folder as listed at every provider call, that is, while results are stored.
const diskDuringStep: string[][] = []
function provider(
  responses: Array<{ tool?: { name: string; arguments: Record<string, unknown> }; fail?: boolean }>
): SingleTurnProvider & { prompts: string[][] } {
  let i = 0
  const prompts: string[][] = []
  return {
    prompts,
    completeSingleTurn: vi
      .fn()
      .mockResolvedValue({ content: 'done', usage, finish_reason: 'stop' }),
    completeSingleTurnWithTools: vi
      .fn()
      .mockImplementation(async (msgs: Array<{ content: string }>) => {
        prompts.push(msgs.map(m => m.content))
        diskDuringStep.push(await fs.readdir(outputDir))
        const r = responses[i++] ?? {}
        if (r.fail) throw new Error('provider failed')
        return r.tool
          ? { content: null, tool_calls: [r.tool], usage, finish_reason: 'tool_use' }
          : { content: 'done', tool_calls: null, usage, finish_reason: 'stop' }
      }),
    getProviderType: () => 'openai',
    classifyError: vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: 'mock',
    })),
  }
}
// The MCP client returns the SDK CallToolResult: `content` is a block array.
type SdkResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean }
const sdkResult = (...texts: string[]): SdkResult => ({
  content: texts.map(text => ({ type: 'text' as const, text })),
  isError: false,
})
function client(result: string | SdkResult): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([{ name: 'read', description: '' }]),
    callTool: vi.fn().mockResolvedValue(typeof result === 'string' ? sdkResult(result) : result),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}
function service(llm: SingleTurnProvider, mcp: McpClientConnection): WorkflowService {
  const svc = new WorkflowService('test-recipe', {
    llmFactory: () => llm,
    mcpClientFactory: () => mcp,
  })
  svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-123' })
  return svc
}
const REF = 'spillover://review/i1c0.json'
const SERVERS = [{ name: 'srv', url: 'http://srv' }]
const READ = {
  name: 'clerum__spillover_read',
  arguments: { ref: REF, range: { start: 0, end: 10 } },
}
const afterStepRead = () =>
  (captured.stores[0] as StepSpillover).readTool.execute(
    { ref: REF, range: { start: 0, end: 10 } },
    ''
  )

describe('WorkflowService step spillover — results are kept in memory', () => {
  it('summarises the text the first-party adapter produces for the same MCP result', async () => {
    // Two text blocks with real line feeds; the last block does not end with one.
    const mcpResult = sdkResult('row line\n'.repeat(40000), 'last block')
    const llm = provider([{ tool: { name: 'srv__read', arguments: {} } }, {}])

    const res = await service(llm, client(mcpResult)).executeStep({
      stepId: 'review',
      instruction: 'go',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    const stored = llm.prompts[1]!.find(m => m.includes(`"spillover_ref":"${REF}"`))!
    const stepSummary = JSON.parse(stored.split('\n')[2]!)

    // The text the first-party loop gets from the same MCP result.
    const adapter = new McpToolRegistryAdapter({
      getAllTools: () => [
        { name: 'srv__read', description: '', inputSchema: {}, serverName: 'srv' },
      ],
      callTool: async () => ({ result: mcpResult, isError: false }),
    } as never)
    const firstPartyText = (await adapter.get('srv__read')!.execute({})).content
    const firstParty = new SpilloverStorage({
      workspacePath: outputDir,
      thresholdBytes: THRESHOLD,
      ttlMs: 0,
      gcIntervalMs: 0,
    })
    const overText = await firstParty.maybePersist({
      taskId: 'review',
      toolCallId: 'i1c0',
      toolName: 'srv__read',
      content: firstPartyText,
      isError: false,
    })
    expect(overText).not.toBeNull()
    expect(stepSummary).toEqual(overText)

    // The first-party loop stores that text inside its tool-output envelope.
    const wrapped = new BasicSafety().previewOutputForLlm('srv__read', firstPartyText)
    expect(wrapped).toBe(
      `<tool_output name="srv__read" sanitized="false">\n${firstPartyText}\n</tool_output>`
    )
    const overWrapped = await firstParty.maybePersist({
      taskId: 'review',
      toolCallId: 'w1',
      toolName: 'srv__read',
      content: wrapped,
      isError: false,
    })
    expect(Object.keys(stepSummary).sort()).toEqual(Object.keys(overWrapped!).sort())
    expect(overWrapped!.line_count).toBe(stepSummary.line_count + 2)
  })

  it('does not use the first-party spillover store during a step that stores a result', async () => {
    const persistSpy = vi.spyOn(SpilloverStorage.prototype, 'maybePersist')
    const loadSpy = vi.spyOn(SpilloverStorage.prototype, 'load')
    const llm = provider([{ tool: { name: 'srv__read', arguments: {} } }, { tool: READ }, {}])

    const res = await service(llm, client(sdkResult('L'.repeat(300 * 1024)))).executeStep({
      stepId: 'review',
      instruction: 'go',
      mcpServers: SERVERS,
    })

    expect(res.status).toBe('completed')
    // Witness: the step stored the result and read it back.
    expect(llm.prompts[1]!.some(m => m.includes(`"spillover_ref":"${REF}"`))).toBe(true)
    expect(res.toolsCalled?.[1]?.result).toEqual({ success: true, ref: REF, bytes: 10 })
    expect(persistSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()

    // Witness: the spies do observe a first-party store at work.
    const firstParty = new SpilloverStorage({
      workspacePath: outputDir,
      thresholdBytes: THRESHOLD,
      ttlMs: 0,
      gcIntervalMs: 0,
    })
    await firstParty.maybePersist({
      taskId: 'review',
      toolCallId: 'c1',
      toolName: 't',
      content: 'z'.repeat(THRESHOLD),
      isError: false,
    })
    await firstParty.load('spillover://review/c1.json')
    expect(persistSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'completes',
      [{ tool: { name: 'srv__read', arguments: {} } }, { tool: READ }, {}],
      'completed',
    ],
    [
      'fails',
      [{ tool: { name: 'srv__read', arguments: {} } }, { tool: READ }, { fail: true }],
      'failed',
    ],
  ] as const)(
    'writes nothing to the output folder and drops the results when the step %s',
    async (_label, responses, status) => {
      const llm = provider([...responses])
      const payload = 'L'.repeat(300 * 1024)

      const res = await service(llm, client(payload)).executeStep({
        stepId: 'review',
        instruction: 'go',
        mcpServers: SERVERS,
      })

      expect(res.status).toBe(status)
      // Witness: the result was stored outside the prompt and read back during the step.
      expect(llm.prompts[1]!.some(m => m.includes(`"spillover_ref":"${REF}"`))).toBe(true)
      expect(res.toolsCalled?.[1]?.result).toEqual({ success: true, ref: REF, bytes: 10 })
      // Listed while the result was stored (calls 2 and 3), not only after the step.
      expect(diskDuringStep).toEqual([[], [], []])
      expect(await fs.readdir(outputDir)).toEqual([])
      expect(captured.stores).toHaveLength(1)
      expect(await afterStepRead()).toEqual({ success: false, error: 'spillover blob not found' })
    }
  )

  it('drops the results when the step is aborted after a result was stored', async () => {
    const controller = new AbortController()
    const llm = provider([{ tool: { name: 'srv__read', arguments: {} } }, {}])
    vi.mocked(llm.completeSingleTurnWithTools).mockImplementationOnce((async () => ({
      content: null,
      tool_calls: [{ name: 'srv__read', arguments: {} }],
      usage,
      finish_reason: 'tool_use',
    })) as never)
    // Recorded inside the provider and asserted after the step: an assertion that
    // threw inside the provider would only make the step fail, as expected anyway.
    let readableWhenAborted: Awaited<ReturnType<typeof afterStepRead>> | undefined
    vi.mocked(llm.completeSingleTurnWithTools).mockImplementationOnce((async () => {
      readableWhenAborted = await afterStepRead()
      controller.abort('client-disconnected')
      return { content: 'done', tool_calls: null, usage, finish_reason: 'stop' }
    }) as never)

    const res = await service(llm, client('L'.repeat(300 * 1024))).executeStep(
      { stepId: 'review', instruction: 'go', mcpServers: SERVERS },
      undefined,
      { signal: controller.signal }
    )

    // Witness: the first result was stored and readable when the abort arrived.
    expect(readableWhenAborted?.success).toBe(true)
    expect(res.status).toBe('failed')
    expect(res.error).toContain('client-disconnected')
    expect(await fs.readdir(outputDir)).toEqual([])
    expect(await afterStepRead()).toEqual({ success: false, error: 'spillover blob not found' })
  })

  it('drops the results when the step times out after a result was stored', async () => {
    const llm = provider([{ tool: { name: 'srv__read', arguments: {} } }, {}])
    vi.mocked(llm.completeSingleTurnWithTools).mockImplementationOnce((async () => ({
      content: null,
      tool_calls: [{ name: 'srv__read', arguments: {} }],
      usage,
      finish_reason: 'tool_use',
    })) as never)
    let readableAtTimeout: Awaited<ReturnType<typeof afterStepRead>> | undefined
    vi.mocked(llm.completeSingleTurnWithTools).mockImplementationOnce((async () => {
      readableAtTimeout = await afterStepRead()
      // Outlasts the step's 1 s timeout.
      await new Promise(resolve => setTimeout(resolve, 1500))
      return { content: 'done', tool_calls: null, usage, finish_reason: 'stop' }
    }) as never)

    const res = await service(llm, client('L'.repeat(300 * 1024))).executeStep({
      stepId: 'review',
      instruction: 'go',
      mcpServers: SERVERS,
      timeoutSeconds: 1,
    })

    // Witness: the first result was stored and readable while the step ran.
    expect(readableAtTimeout?.success).toBe(true)
    expect(res).toMatchObject({ status: 'failed', error: 'step-timeout' })
    expect(await fs.readdir(outputDir)).toEqual([])
    expect(await afterStepRead()).toEqual({ success: false, error: 'spillover blob not found' })
  }, 10_000)
})
