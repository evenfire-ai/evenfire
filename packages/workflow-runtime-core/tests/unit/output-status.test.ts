import { describe, expect, it } from 'vitest'
import {
  STATUS_ERROR_MAX_CHARS,
  STATUS_OUTPUT_MAX_CHARS,
  STATUS_REPORT_MAX_BYTES,
  boundOutputForStatus,
  boundStepStatusBody,
  extractOutputArtifactsForStatus,
  serializeOutputForStatus,
} from '../../src/status-reporter/outputStatus'
import {
  boundToolsCalledForStatus,
  normalizeArtifactForStatus,
  parseArtifactToolResult,
} from '../../src/status-reporter/toolCallStatus'

function artifact(i: number, path = `/output/report-${i}.md`) {
  return { name: `report-${i}.md`, format: 'md', sizeBytes: 10, path, createdAt: '2026-11-12' }
}

function bodyBytes(body: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(body))
}

/** A large step status body whose bytes far exceed its character counts. */
function hostileBody(unit: string): Record<string, unknown> {
  return {
    stepId: 's1',
    phase: 'failed',
    output: unit.repeat(Math.ceil(STATUS_OUTPUT_MAX_CHARS / unit.length)),
    failureReason: unit.repeat(Math.ceil(100_000 / unit.length)),
    toolsCalled: Array.from({ length: 100 }, (_, i) => ({
      serverName: 'git',
      toolName: `tool-${i}`,
      args: { blob: unit.repeat(Math.ceil(2000 / unit.length)) },
      result: unit.repeat(Math.ceil(2000 / unit.length)),
      durationMs: 1,
    })),
  }
}

describe('serializeOutputForStatus', () => {
  it('keeps strings as they are', () => {
    expect(serializeOutputForStatus('plain text')).toBe('plain text')
  })

  it('serializes undefined as the string undefined', () => {
    expect(serializeOutputForStatus(undefined)).toBe('undefined')
  })

  it('serializes objects as JSON', () => {
    expect(serializeOutputForStatus({ a: 1, b: ['x'] })).toBe('{"a":1,"b":["x"]}')
  })

  it('serializes circular objects safely', () => {
    const value: Record<string, unknown> = { name: 'root' }
    value.self = value
    expect(serializeOutputForStatus(value)).toBe('{"name":"root","self":"[Circular]"}')
  })
})

describe('extractOutputArtifactsForStatus', () => {
  it('reads artifact and artifacts[] from an object or a JSON string', () => {
    const output = { artifact: artifact(0), artifacts: [artifact(1), artifact(2)] }
    expect(extractOutputArtifactsForStatus(output).map(a => a.path)).toEqual([
      '/output/report-0.md',
      '/output/report-1.md',
      '/output/report-2.md',
    ])
    expect(extractOutputArtifactsForStatus(JSON.stringify(output))).toHaveLength(3)
  })

  it('returns nothing for text that is not a JSON object', () => {
    expect(extractOutputArtifactsForStatus('{"artifacts": [')).toEqual([])
    expect(extractOutputArtifactsForStatus('plain text')).toEqual([])
  })
})

describe('boundOutputForStatus', () => {
  it('keeps a short output whole and does not extract artifacts', () => {
    const output = JSON.stringify({ artifacts: [artifact(0)] })
    const bounded = boundOutputForStatus(output)
    expect(bounded).toEqual({ output, outputLength: output.length, outputTruncated: false })
    // Witness: the same output does declare an artifact.
    expect(extractOutputArtifactsForStatus(output)).toHaveLength(1)
  })

  it('cuts a long output to the WRC preview maximum and records the original length', () => {
    const output = 'x'.repeat(200_000)
    const bounded = boundOutputForStatus(output)
    expect(bounded.output).toBe(output.slice(0, STATUS_OUTPUT_MAX_CHARS))
    expect(bounded.output).toHaveLength(65_536)
    expect(bounded.outputLength).toBe(200_000)
    expect(bounded.outputTruncated).toBe(true)
    expect(bounded).not.toHaveProperty('outputArtifacts')
  })

  it('extracts the artifacts a cut JSON output declares, at most 20, dropping invalid ones', () => {
    const output = JSON.stringify({
      report: 'r'.repeat(100_000),
      artifacts: [
        artifact(0, '/etc/passwd'),
        ...Array.from({ length: 30 }, (_, i) => artifact(i + 1)),
      ],
    })
    const bounded = boundOutputForStatus(output)
    expect(bounded.outputTruncated).toBe(true)
    expect(bounded.outputArtifacts).toHaveLength(19)
    expect(bounded.outputArtifacts?.map(a => a.path)).not.toContain('/etc/passwd')
    expect(bounded.outputArtifacts?.[0]).toEqual({
      name: 'report-1.md',
      format: 'md',
      sizeBytes: 10,
      path: '/output/report-1.md',
      createdAt: '2026-11-12',
    })
  })
})

describe('boundStepStatusBody', () => {
  it('does not mutate its input', () => {
    const body = hostileBody('\u0001')
    const before = structuredClone(body)
    const bounded = boundStepStatusBody(body)
    expect(bounded).not.toBe(body)
    expect(body).toEqual(before)
    // Witness: the bounded body did change.
    expect(bounded.output).not.toEqual(body.output)
  })

  it('leaves a small body unchanged apart from the output fields', () => {
    const body = { stepId: 's1', phase: 'completed', output: 'done', executor: 'snippet' }
    expect(boundStepStatusBody(body)).toEqual({
      ...body,
      outputLength: 4,
      outputTruncated: false,
    })
  })

  it('serializes a non-string output as its JSON text', () => {
    const bounded = boundStepStatusBody({ stepId: 's1', phase: 'completed', output: { a: 1 } })
    expect(bounded.output).toBe('{"a":1}')
  })

  it('leaves a body without output without output fields', () => {
    const bounded = boundStepStatusBody({ stepId: 's1', phase: 'running' })
    expect(bounded).toEqual({ stepId: 's1', phase: 'running' })
  })

  it('leaves a null output as it is, without output fields', () => {
    const body = { stepId: 's1', phase: 'completed', output: null }
    expect(boundStepStatusBody(body)).toEqual(body)
    // Witness: an output that is falsy but not null does get the output fields.
    expect(boundStepStatusBody({ ...body, output: 0 })).toEqual({
      ...body,
      output: '0',
      outputLength: 1,
      outputTruncated: false,
    })
  })

  it('is idempotent on a body that needed no cut', () => {
    const body = { stepId: 's1', phase: 'completed', output: 'done', toolsCalled: [] }
    const once = boundStepStatusBody(body)
    expect(boundStepStatusBody(once)).toEqual(once)
  })

  it.each([
    ['control characters', '\u0001'],
    ['emoji (surrogate pairs)', '\u{1F600}'],
    ['CJK text', '中文'],
  ])('keeps the serialized body under the byte ceiling for %s', (_label, unit) => {
    const body = hostileBody(unit)
    // Witness: the input really is over the ceiling.
    expect(bodyBytes(body)).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)
    expect(bodyBytes(boundStepStatusBody(body))).toBeLessThanOrEqual(STATUS_REPORT_MAX_BYTES)
  })

  it('stops after cutting the error when that is enough, keeping tool-call args', () => {
    const body = {
      stepId: 's1',
      phase: 'failed',
      output: 'short',
      failureReason: '\u0001'.repeat(60_000),
      toolsCalled: [{ serverName: 'git', toolName: 'read', args: { path: 'a' }, result: 'ok' }],
    }
    expect(bodyBytes(body)).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)
    const bounded = boundStepStatusBody(body)
    expect(bounded.failureReason).toHaveLength(STATUS_ERROR_MAX_CHARS)
    expect(bounded.toolsCalled).toEqual(body.toolsCalled)
    expect(bounded.output).toBe('short')
  })

  it('removes tool-call previews when needed and keeps the artifact metadata WRC would register', () => {
    // The result mcp-host records for its artifact tools
    // (mcp-host/src/workflow/artifactOutput.ts:265-275). mcp-host is not a
    // dependency of this package, so the shape is written out.
    const mcpHostResult = (n: number) => ({
      success: true,
      artifact: artifact(n),
      content: `File generated: report-${n}.md (md).`,
    })
    const body = {
      stepId: 's1',
      phase: 'completed',
      // Not cut (65,536 characters) and three bytes per character.
      output: '中'.repeat(STATUS_OUTPUT_MAX_CHARS),
      toolsCalled: [
        ...Array.from({ length: 47 }, (_, i) => ({
          serverName: 'git',
          toolName: `read-${i}`,
          args: { blob: '中'.repeat(1000) },
          result: '中'.repeat(1000),
        })),
        // Last, because previews are removed from the last call backwards.
        {
          serverName: 'clerum',
          toolName: 'generate_markdown',
          args: { title: 'report-0' },
          result: mcpHostResult(0),
        },
        {
          serverName: 'clerum',
          toolName: 'generate_markdown',
          args: { title: 'report-1' },
          result: JSON.stringify(mcpHostResult(1)),
        },
        {
          serverName: 'clerum',
          toolName: 'generate_markdown',
          args: { title: 'report-2' },
          result: { success: true, artifact: artifact(2) },
        },
      ],
    }
    const firstPass = boundToolsCalledForStatus(body.toolsCalled)
    // Witness: after the first pass the body is still over the ceiling, so the
    // tool-call step has to run.
    expect(bodyBytes({ ...body, toolsCalled: firstPass })).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)

    const bounded = boundStepStatusBody(body)
    const calls = bounded.toolsCalled as Array<Record<string, unknown>>
    expect(calls).toHaveLength(50)
    for (const n of [0, 1, 2]) {
      expect(calls[47 + n]).toEqual({
        serverName: 'clerum',
        toolName: 'generate_markdown',
        result: { success: true, artifact: artifact(n) },
      })
    }
    // The first call keeps its previews: only as many calls as needed were reduced.
    expect(calls[0]).toEqual(firstPass[0])
    expect(bodyBytes(bounded)).toBeLessThanOrEqual(STATUS_REPORT_MAX_BYTES)
    // The tool-call step, not the halving, made the body fit.
    expect(bounded.output).toBe(body.output)
    expect(bounded.outputTruncated).toBe(false)
  })

  it('halves the output last, keeping the artifacts of the original output', () => {
    // Under the character cap (so step 1 does not cut it) but three bytes per character.
    const output = JSON.stringify({ report: '中'.repeat(60_000), artifact: artifact(0) })
    expect(output.length).toBeLessThan(STATUS_OUTPUT_MAX_CHARS)
    const body = {
      stepId: 's1',
      phase: 'failed',
      output,
      error: '\u0001'.repeat(20_000),
      failureReason: '\u0001'.repeat(20_000),
    }
    const bounded = boundStepStatusBody(body)
    expect(bodyBytes(bounded)).toBeLessThanOrEqual(STATUS_REPORT_MAX_BYTES)
    expect(bounded.error).toHaveLength(STATUS_ERROR_MAX_CHARS)
    expect(bounded.failureReason).toHaveLength(STATUS_ERROR_MAX_CHARS)
    expect(bounded.outputTruncated).toBe(true)
    expect(bounded.outputLength).toBe(output.length)
    expect((bounded.output as string).length).toBeLessThan(output.length)
    expect(output.startsWith(bounded.output as string)).toBe(true)
    expect(bounded.outputArtifacts).toEqual([artifact(0)])
  })

  it('removes previews from the last calls only, as many as the body needs', () => {
    const body = {
      stepId: 's1',
      phase: 'completed',
      executor: 'agentic',
      output: '中'.repeat(STATUS_OUTPUT_MAX_CHARS),
      toolsCalled: Array.from({ length: 30 }, (_, i) => ({
        serverName: 'git',
        toolName: `read-${i}`,
        args: { blob: '中'.repeat(1000) },
        result: '中'.repeat(1000),
        durationMs: 1,
      })),
    }
    const firstPass = boundToolsCalledForStatus(body.toolsCalled)
    // Witnesses: WRC would accept the raw body, and after the first pass the
    // body is still over the ceiling.
    expect(bodyBytes(body)).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)
    expect(bodyBytes(body)).toBeLessThan(512 * 1024)
    expect(bodyBytes({ ...body, toolsCalled: firstPass })).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)

    const bounded = boundStepStatusBody(body)
    const calls = bounded.toolsCalled as Array<Record<string, unknown>>
    const k = calls.findIndex(call => !('args' in call))
    expect(k).toBeGreaterThan(0)
    expect(k).toBeLessThan(30)
    expect(calls.slice(0, k)).toEqual(firstPass.slice(0, k))
    for (const call of calls.slice(k)) {
      expect(call).not.toHaveProperty('args')
      expect(call).not.toHaveProperty('result')
    }
    expect(bodyBytes(bounded)).toBeLessThanOrEqual(STATUS_REPORT_MAX_BYTES)
    // Minimal: with call k's previews put back the body is over the ceiling.
    const oneMore = calls.map((call, i) => (i === k ? firstPass[i] : call))
    expect(bodyBytes({ ...bounded, toolsCalled: oneMore })).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)
    expect(bounded.output).toHaveLength(STATUS_OUTPUT_MAX_CHARS)
    expect(bounded.outputTruncated).toBe(false)
  })

  it('leaves a call as it is when removing its previews would not make it smaller', () => {
    // A result with partial artifact metadata. WRC accepts it, and its
    // normalized form (`format`, `sizeBytes` and `createdAt` added) is larger.
    const partialArtifactCall = (i: number) => ({
      serverName: 'custom',
      toolName: 'write_file',
      result: {
        success: true,
        artifact: { name: `partial-${i}.md`, path: `/output/partial-${i}.md` },
      },
    })
    // A result whose normalized form has exactly the same size: the unknown
    // field it loses is as long as the `format` and `sizeBytes` it gains.
    const sameSizeArtifact = {
      name: 'same.md',
      path: '/output/same.md',
      createdAt: '2026-11-12',
      pad: 'x'.repeat(17),
    }
    const sameSizeCall = {
      serverName: 'custom',
      toolName: 'write_file',
      result: { success: true, artifact: sameSizeArtifact },
    }
    const sameSizeReduced = {
      serverName: 'custom',
      toolName: 'write_file',
      result: { success: true, artifact: normalizeArtifactForStatus(sameSizeArtifact) },
    }
    const body = {
      stepId: 's1',
      phase: 'completed',
      output: '中'.repeat(STATUS_OUTPUT_MAX_CHARS),
      toolsCalled: [
        ...Array.from({ length: 50 }, (_, i) => ({
          serverName: 'git',
          toolName: `read-${i}`,
          args: { blob: 'a'.repeat(1000) },
          result: 'b'.repeat(1000),
        })),
        ...Array.from({ length: 49 }, (_, i) => partialArtifactCall(i)),
        sameSizeCall,
      ],
    }
    const firstPass = boundToolsCalledForStatus(body.toolsCalled)
    // Witnesses: the first pass sends all 100 calls, and the body is over the ceiling.
    expect(firstPass).toHaveLength(100)
    expect(bodyBytes({ ...body, toolsCalled: firstPass })).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)
    // Witness: the last call's reduced form differs from it and has the same size.
    expect(sameSizeReduced).not.toEqual(sameSizeCall)
    expect(bodyBytes(sameSizeReduced)).toBe(bodyBytes(sameSizeCall))

    const bounded = boundStepStatusBody(body)
    const calls = bounded.toolsCalled as Array<Record<string, unknown>>
    expect(bodyBytes(bounded)).toBeLessThanOrEqual(STATUS_REPORT_MAX_BYTES)
    // Witness: the removal went past the 50 artifact calls and reduced earlier ones.
    const k = calls.findIndex(call => !('args' in call))
    expect(k).toBeGreaterThan(0)
    expect(k).toBeLessThan(50)
    expect(calls.slice(0, k)).toEqual(firstPass.slice(0, k))
    // Only as many as needed: the first-pass calls with one reduction fewer are over the ceiling.
    const oneFewer = firstPass.map((call, i) => (i > k && i < 50 ? calls[i] : call))
    expect(bodyBytes({ ...bounded, toolsCalled: oneFewer })).toBeGreaterThan(
      STATUS_REPORT_MAX_BYTES
    )
    // The artifact calls are sent as the first pass left them.
    expect(calls.slice(50)).toEqual(firstPass.slice(50))
    expect(bounded.outputTruncated).toBe(false)
  })

  it('keeps only the artifact metadata WRC accepts when it removes the previews of a call', () => {
    const body = {
      stepId: 's1',
      phase: 'completed',
      output: '中'.repeat(STATUS_OUTPUT_MAX_CHARS),
      toolsCalled: [
        ...Array.from({ length: 30 }, (_, i) => ({
          serverName: 'git',
          toolName: `read-${i}`,
          args: { blob: '中'.repeat(1000) },
          result: '中'.repeat(1000),
        })),
        // Last, because previews are removed from the last call backwards.
        {
          serverName: 'custom',
          toolName: 'write_file',
          args: { title: 'rejected' },
          result: { success: true, artifact: artifact(1, '/etc/passwd'), content: 'x' },
        },
        {
          serverName: 'custom',
          toolName: 'write_file',
          args: { title: 'untrimmed' },
          result: {
            success: true,
            artifact: { ...artifact(2), name: '  report-2.md  ', extra: 'y'.repeat(300) },
            content: 'x',
          },
        },
      ],
    }
    const firstPass = boundToolsCalledForStatus(body.toolsCalled)
    // Witnesses: the first pass sends both results as they are, and the body
    // is over the ceiling.
    expect(firstPass[30]).toEqual(body.toolsCalled[30])
    expect(firstPass[31]).toEqual(body.toolsCalled[31])
    expect(bodyBytes({ ...body, toolsCalled: firstPass })).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)

    const calls = boundStepStatusBody(body).toolsCalled as Array<Record<string, unknown>>
    // WRC rejects a path outside /output, so nothing of that result is kept.
    expect(calls[30]).toEqual({ serverName: 'custom', toolName: 'write_file' })
    // The accepted artifact is sent as WRC would store it: trimmed, known fields only.
    expect(calls[31]).toEqual({
      serverName: 'custom',
      toolName: 'write_file',
      result: { success: true, artifact: artifact(2) },
    })
  })

  it('sends no outputArtifacts for an uncut output when cutting the error is enough', () => {
    const output = JSON.stringify({ artifact: artifact(0), pad: 'x'.repeat(2_000) })
    const body = { stepId: 's1', phase: 'failed', output, failureReason: '\u0001'.repeat(60_000) }
    // Witnesses: the body is over the ceiling, and the output is longer than
    // the 1,024-character halving floor and declares an artifact.
    expect(bodyBytes(body)).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)
    expect(output.length).toBeGreaterThan(1024)
    expect(extractOutputArtifactsForStatus(output)).toEqual([artifact(0)])

    // The cut failureReason is the witness that the error step ran.
    expect(boundStepStatusBody(body)).toEqual({
      stepId: 's1',
      phase: 'failed',
      output,
      outputLength: output.length,
      outputTruncated: false,
      failureReason: '\u0001'.repeat(STATUS_ERROR_MAX_CHARS),
    })
  })

  it('sends no outputArtifacts for an uncut output when removing previews is enough', () => {
    const output = JSON.stringify({ artifact: artifact(0), pad: '中'.repeat(60_000) })
    const body = {
      stepId: 's1',
      phase: 'completed',
      output,
      toolsCalled: Array.from({ length: 30 }, (_, i) => ({
        serverName: 'git',
        toolName: `read-${i}`,
        args: { blob: '中'.repeat(1000) },
        result: '中'.repeat(1000),
      })),
    }
    const firstPass = boundToolsCalledForStatus(body.toolsCalled)
    // Witnesses: the output is under the character cap and declares an
    // artifact, and after the first pass the body is over the ceiling.
    expect(output.length).toBeLessThan(STATUS_OUTPUT_MAX_CHARS)
    expect(extractOutputArtifactsForStatus(output)).toEqual([artifact(0)])
    expect(bodyBytes({ ...body, toolsCalled: firstPass })).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)

    const bounded = boundStepStatusBody(body)
    const calls = bounded.toolsCalled as Array<Record<string, unknown>>
    // Witness: the preview removal ran and made the body fit.
    expect(calls.some(call => !('args' in call))).toBe(true)
    expect(bodyBytes(bounded)).toBeLessThanOrEqual(STATUS_REPORT_MAX_BYTES)
    expect(bounded.output).toBe(output)
    expect(bounded.outputLength).toBe(output.length)
    expect(bounded.outputTruncated).toBe(false)
    expect(Object.keys(bounded).sort()).toEqual([
      'output',
      'outputLength',
      'outputTruncated',
      'phase',
      'stepId',
      'toolsCalled',
    ])
  })

  it.each([65_536, 60_000, 2_000, 1_500, 1_025, 1_024, 500])(
    'does not halve the output below 1,024 characters (start length %i)',
    start => {
      // A 300,000-character modelUsed is never reduced, so the body never fits.
      const body = {
        stepId: 's1',
        phase: 'completed',
        output: 'o'.repeat(start),
        modelUsed: 'm'.repeat(300_000),
      }
      const bounded = boundStepStatusBody(body)
      // Witness: still over the ceiling, so the halving loop ran to its end.
      expect(bodyBytes(bounded)).toBeGreaterThan(STATUS_REPORT_MAX_BYTES)
      expect(bounded.output).toHaveLength(Math.min(start, 1024))
    }
  )

  it('sends the artifacts of an output it cut', () => {
    const output = JSON.stringify({
      report: 'r'.repeat(100_000),
      artifact: artifact(0),
      artifacts: [artifact(1), artifact(2)],
    })
    const bounded = boundStepStatusBody({ stepId: 's1', phase: 'completed', output })
    // Witness: the body fits without any reduction, so only the cut ran.
    expect(bodyBytes(bounded)).toBeLessThan(STATUS_REPORT_MAX_BYTES)
    expect(bounded.outputTruncated).toBe(true)
    expect(bounded.outputArtifacts).toEqual([artifact(0), artifact(1), artifact(2)])
  })

  it('holds its properties over a table of generated bodies', () => {
    const tableArtifact = (i: number, name = `r-${i}.md`, path = `/output/r-${i}.md`) => ({
      name,
      format: 'md',
      path,
      sizeBytes: 10,
      createdAt: '2026-11-12',
    })
    const declared = (count: number): Record<string, unknown> => {
      if (count === 0) return {}
      if (count === 1) return { artifact: tableArtifact(0) }
      if (count === 21) {
        return {
          artifact: tableArtifact(0),
          artifacts: Array.from({ length: 20 }, (_, i) => tableArtifact(i + 1)),
        }
      }
      // 25 entries, with a repeated name and a repeated path.
      return {
        artifact: tableArtifact(0),
        artifacts: [
          tableArtifact(0),
          tableArtifact(1, 'other.md'),
          ...Array.from({ length: 23 }, (_, i) => tableArtifact(i + 1)),
        ],
      }
    }
    const makeOutput = (length: number, unit: string, kind: 'text' | number): string => {
      if (kind === 'text') return unit.repeat(length)
      const head = JSON.stringify({ ...declared(kind), pad: '' })
      return JSON.stringify({
        ...declared(kind),
        pad: unit.repeat(Math.max(0, length - head.length)),
      })
    }
    const makeCalls = (count: number, unit: string): Array<Record<string, unknown>> => [
      ...Array.from({ length: count - 2 }, (_, i) => ({
        serverName: 'git',
        toolName: `read-${i}`,
        args: { blob: unit.repeat(1000) },
        result: unit.repeat(1000),
        durationMs: 1,
      })),
      // The two shapes mcp-host records for artifact tools: an object and a JSON string.
      {
        serverName: 'clerum',
        toolName: 'generate_markdown',
        args: { t: 1 },
        result: {
          success: true,
          content: 'File generated: tool-a.md (md).',
          artifact: tableArtifact(100, 'tool-a.md'),
        },
        durationMs: 1,
      },
      {
        serverName: 'clerum',
        toolName: 'generate_markdown',
        args: { t: 1 },
        result: JSON.stringify({
          success: true,
          content: 'File generated: tool-b.md (md).',
          artifact: tableArtifact(101, 'tool-b.md'),
        }),
        durationMs: 1,
      },
    ]
    const toolArtifactNames = (calls: unknown): string[] =>
      (Array.isArray(calls) ? calls : []).slice(0, 100).flatMap(call => {
        const found = parseArtifactToolResult((call as Record<string, unknown>).result)
        const accepted = found ? normalizeArtifactForStatus(found) : null
        return accepted ? [accepted.name] : []
      })
    const outputArtifactNames = (body: Record<string, unknown>): string[] => [
      ...extractOutputArtifactsForStatus(body.output).map(a => a.name),
      ...((body.outputArtifacts as Array<{ name: string }> | undefined) ?? []).map(a => a.name),
    ]

    const counts = { firstPass: 0, errorCut: 0, previews: 0, halved: 0 }
    let total = 0
    for (const length of [0, 1_000, 65_536, 65_537, 150_000]) {
      for (const unit of ['a', '中', '\u0001']) {
        for (const kind of ['text', 0, 1, 21, 25] as const) {
          for (const callCount of [0, 30, 60]) {
            for (const withReason of [false, true]) {
              total += 1
              const raw: Record<string, unknown> = {
                stepId: 's1',
                phase: withReason ? 'failed' : 'completed',
                output: makeOutput(length, unit, kind),
              }
              const calls = callCount > 0 ? makeCalls(callCount, unit) : undefined
              if (calls) raw.toolsCalled = calls
              if (withReason) raw.failureReason = unit.repeat(100_000)
              const before = structuredClone(raw)

              const result = boundStepStatusBody(raw)

              expect(raw).toEqual(before)
              expect(bodyBytes(result)).toBeLessThanOrEqual(STATUS_REPORT_MAX_BYTES)
              if (result.outputTruncated === false) {
                expect(boundStepStatusBody(result)).toEqual(result)
              }
              const keptOutputArtifacts = new Set(outputArtifactNames(result))
              for (const found of extractOutputArtifactsForStatus(raw.output)) {
                expect(keptOutputArtifacts.has(found.name)).toBe(true)
              }
              const keptToolArtifacts = new Set(toolArtifactNames(result.toolsCalled))
              for (const name of toolArtifactNames(raw.toolsCalled)) {
                expect(keptToolArtifacts.has(name)).toBe(true)
              }

              // Which branch produced the result.
              const firstPassCalls = calls ? boundToolsCalledForStatus(calls) : []
              const resultCalls = (result.toolsCalled ?? []) as Array<Record<string, unknown>>
              const lostPreviews = resultCalls.some(
                (call, i) => 'args' in (firstPassCalls[i] as object) && !('args' in call)
              )
              const output = raw.output as string
              if (
                (result.output as string).length < Math.min(output.length, STATUS_OUTPUT_MAX_CHARS)
              ) {
                counts.halved += 1
              } else if (lostPreviews) {
                counts.previews += 1
              } else if (
                withReason &&
                (result.failureReason as string).length < (raw.failureReason as string).length
              ) {
                counts.errorCut += 1
              } else {
                counts.firstPass += 1
              }
            }
          }
        }
      }
    }
    expect(total).toBe(450)
    // A table that never leaves the first branch would prove nothing.
    expect(counts.firstPass).toBeGreaterThan(0)
    expect(counts.errorCut).toBeGreaterThan(0)
    expect(counts.previews).toBeGreaterThan(0)
    expect(counts.halved).toBeGreaterThan(0)
    expect(counts.firstPass + counts.errorCut + counts.previews + counts.halved).toBe(450)
  }, 120_000)
})

describe('boundOutputForStatus with a live output value', () => {
  const sharedLeaf = { id: 1 }
  const sameObject = { name: 'x' }

  it.each([
    ['an object with a shared reference', { first: sharedLeaf, second: sharedLeaf }],
    ['an array with the same object twice', [sameObject, sameObject]],
    ['a top-level Date', new Date('2026-11-12T00:00:00.000Z')],
    ['a String object', new String('boxed')],
    ['a nested Date', { at: new Date('2026-11-12T00:00:00.000Z') }],
    ['an object whose toJSON returns a record', { toJSON: () => ({ artifact: artifact(0) }) }],
    ['a Map', new Map([[1, 2]])],
    ['a number', 5],
    ['false', false],
    ['an empty string', ''],
    ['an array', [1, 2]],
  ])('reports the JSON text WRC would have received for %s', (_label, output) => {
    // What WRC received before this PR: the output after JSON transport, then its serializer.
    const received = JSON.parse(JSON.stringify({ output })).output
    const expected = serializeOutputForStatus(received)
    const bounded = boundOutputForStatus(output)
    expect(bounded.output).toBe(expected)
    expect(bounded.outputLength).toBe(expected.length)
    expect(bounded.outputTruncated).toBe(false)
  })

  function f() {
    return 1
  }

  it.each([
    ['NaN', NaN, 'null'],
    ['Infinity', Infinity, 'null'],
    ['a function', f, String(f)],
    ['a symbol', Symbol('x'), 'Symbol(x)'],
    ['an object whose toJSON returns null', { toJSON: () => null }, 'null'],
    ['an object whose toJSON returns undefined', { toJSON: () => undefined }, '[object Object]'],
  ])('keeps the reported value for an output JSON cannot carry: %s', (_label, output, expected) => {
    const bounded = boundOutputForStatus(output)
    expect(bounded.output).toBe(expected)
    expect(bounded.outputLength).toBe(expected.length)
    expect(bounded.outputTruncated).toBe(false)
  })

  it.each([
    [
      'an object that contains itself',
      () => {
        const cyc: Record<string, unknown> = { k: 1 }
        cyc.self = cyc
        return cyc
      },
      '{"k":1,"self":"[Circular]"}',
    ],
    [
      'a repeated leaf next to two cycles',
      () => {
        const leaf = { id: 1 }
        const node: Record<string, unknown> & { list: unknown[] } = {
          leaf,
          again: leaf,
          list: [leaf, leaf],
        }
        node.self = node
        node.list.push(node)
        return node
      },
      '{"leaf":{"id":1},"again":{"id":1},"list":[{"id":1},{"id":1},"[Circular]"],"self":"[Circular]"}',
    ],
    [
      'a cycle that passes through a toJSON result',
      () => {
        const inner: Record<string, unknown> = { name: 'inner', holder: null }
        const viaToJSON = { toJSON: () => inner }
        inner.holder = viaToJSON
        return { start: viaToJSON }
      },
      '{"start":{"name":"inner","holder":"[Circular]"}}',
    ],
    [
      'a cycle at depth, then the same subtree as a later sibling',
      () => {
        const b: Record<string, unknown> = { c: {} }
        const deep: Record<string, unknown> = { a: { b }, sibling: null }
        ;(b.c as Record<string, unknown>).top = deep
        deep.sibling = b
        return deep
      },
      '{"a":{"b":{"c":{"top":"[Circular]"}}},"sibling":{"c":{"top":"[Circular]"}}}',
    ],
  ])('marks an object as circular only where it contains itself: %s', (_label, make, expected) => {
    expect(boundOutputForStatus(make()).output).toBe(expected)
  })

  it('throws when JSON cannot serialize the output', () => {
    expect(() => boundOutputForStatus({ n: 1n })).toThrow(TypeError)
    expect(() => boundOutputForStatus(10n)).toThrow(TypeError)
    const throwing = {
      toJSON: () => {
        throw new Error('boom')
      },
    }
    expect(() => boundOutputForStatus(throwing)).toThrow('boom')
  })

  const liveArtifacts = () => [
    { ...artifact(1), createdAt: new Date('2026-01-02T03:04:05.000Z') },
    { ...artifact(2), sizeBytes: NaN },
  ]

  it('extracts the artifacts of a cut object output from its serialized form', () => {
    const bounded = boundOutputForStatus({ report: 'r'.repeat(70_000), artifacts: liveArtifacts() })
    expect(bounded.outputTruncated).toBe(true)
    expect(bounded.outputArtifacts).toHaveLength(2)
    expect(bounded.outputArtifacts?.[0].createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(bounded.outputArtifacts?.[1].sizeBytes).toBe(0)
  })

  it('extracts the artifacts of a halved object output from its serialized form', () => {
    const output = { report: '中'.repeat(60_000), artifacts: liveArtifacts() }
    const serializedLength = JSON.stringify(output).length
    const bounded = boundStepStatusBody({
      stepId: 's1',
      phase: 'failed',
      output,
      error: '\u0001'.repeat(20_000),
      failureReason: '\u0001'.repeat(20_000),
    })
    // Witness: step 1 did not cut the output, the halving did.
    expect(serializedLength).toBeLessThan(STATUS_OUTPUT_MAX_CHARS)
    expect(bounded.outputTruncated).toBe(true)
    expect((bounded.output as string).length).toBeLessThan(serializedLength)
    const outputArtifacts = bounded.outputArtifacts as Array<Record<string, unknown>>
    expect(outputArtifacts).toHaveLength(2)
    expect(outputArtifacts[0].createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(outputArtifacts[1].sizeBytes).toBe(0)
  })
})
