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

  it('serializes a non-string output the way WRC does', () => {
    const bounded = boundStepStatusBody({ stepId: 's1', phase: 'completed', output: { a: 1 } })
    expect(bounded.output).toBe('{"a":1}')
  })

  it('leaves a body without output without output fields', () => {
    const bounded = boundStepStatusBody({ stepId: 's1', phase: 'running' })
    expect(bounded).toEqual({ stepId: 's1', phase: 'running' })
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

  it('drops tool-call previews when needed but keeps artifact results', () => {
    const artifactResult = { success: true, artifact: artifact(0) }
    const body = {
      stepId: 's1',
      phase: 'completed',
      output: 'short',
      toolsCalled: [
        { serverName: 'files', toolName: 'write', args: { path: 'a' }, result: artifactResult },
        ...Array.from({ length: 49 }, (_, i) => ({
          serverName: 'git',
          toolName: `read-${i}`,
          args: { blob: '\u0001'.repeat(1000) },
          result: '\u0001'.repeat(1000),
        })),
      ],
    }
    const bounded = boundStepStatusBody(body)
    const calls = bounded.toolsCalled as Array<Record<string, unknown>>
    expect(calls).toHaveLength(50)
    expect(calls[0]).toEqual({ serverName: 'files', toolName: 'write', result: artifactResult })
    expect(calls[1]).toEqual({ serverName: 'git', toolName: 'read-0' })
    expect(bounded.output).toBe('short')
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
})
