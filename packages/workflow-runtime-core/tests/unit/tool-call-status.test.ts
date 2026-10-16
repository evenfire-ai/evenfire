import { describe, expect, it } from 'vitest'
import {
  MAX_STATUS_TOOL_CALLS,
  STATUS_TOOL_ARGS_PREVIEW_LIMIT,
  STATUS_TOOL_RESULT_PREVIEW_LIMIT,
  boundToolsCalledForStatus,
  normalizeToolArgsForStatus,
  normalizeToolResultForStatus,
} from '../../src/status-reporter/toolCallStatus'

const artifactResult = (name: string) => ({
  success: true,
  artifact: {
    name,
    format: 'docx',
    path: `/output/${name}`,
    sizeBytes: 2048,
    createdAt: '2026-10-16T00:00:00.000Z',
  },
})

const bigCall = (index: number, resultChars = 30_000) => ({
  serverName: 'git',
  toolName: 'read_file',
  args: { path: `src/file-${index}.ts`, padding: 'a'.repeat(5_000) },
  result: [{ type: 'text', text: 'x'.repeat(resultChars) }],
  durationMs: 12,
})

describe('normalizeToolResultForStatus', () => {
  it('keeps results within the preview limit unchanged', () => {
    const result = [{ type: 'text', text: 'short' }]
    expect(normalizeToolResultForStatus(result)).toBe(result)
  })

  it('replaces an oversized result with a bounded preview', () => {
    const normalized = normalizeToolResultForStatus('y'.repeat(5_000))
    expect(normalized).toEqual({
      truncated: true,
      preview: 'y'.repeat(STATUS_TOOL_RESULT_PREVIEW_LIMIT),
    })
  })

  it('is idempotent for an already-truncated preview', () => {
    const once = normalizeToolResultForStatus({ blob: 'z'.repeat(5_000) })
    expect(normalizeToolResultForStatus(once)).toEqual(once)
  })
})

describe('preview pass-through guard', () => {
  it('re-bounds a preview-shaped value that carries extra keys', () => {
    const smuggled = { truncated: true, preview: 'p', payload: 'z'.repeat(5_000) }
    for (const normalize of [normalizeToolResultForStatus, normalizeToolArgsForStatus]) {
      const out = normalize(smuggled) as { preview: string }
      expect(out).not.toBe(smuggled)
      expect(out.preview).toHaveLength(1024)
    }
  })

  it('re-bounds a preview whose text exceeds the limit', () => {
    const oversized = { truncated: true, preview: 'x'.repeat(100_000) }
    const out = normalizeToolResultForStatus(oversized) as { preview: string }
    expect(out).not.toBe(oversized)
    expect(out.preview).toHaveLength(STATUS_TOOL_RESULT_PREVIEW_LIMIT)
  })
})

describe('normalizeToolArgsForStatus', () => {
  it('replaces oversized args with a bounded preview', () => {
    const normalized = normalizeToolArgsForStatus({ query: 'q'.repeat(5_000) })
    expect(normalized).toEqual({
      truncated: true,
      preview: expect.any(String),
    })
    expect((normalized as { preview: string }).preview).toHaveLength(STATUS_TOOL_ARGS_PREVIEW_LIMIT)
  })

  it('wraps non-object args and is idempotent', () => {
    const once = normalizeToolArgsForStatus('plain')
    expect(once).toEqual({ value: 'plain' })
    expect(normalizeToolArgsForStatus(once)).toEqual(once)
    const truncated = normalizeToolArgsForStatus({ q: 'q'.repeat(5_000) })
    expect(normalizeToolArgsForStatus(truncated)).toEqual(truncated)
  })
})

describe('boundToolsCalledForStatus', () => {
  it('bounds 22 tool calls totalling ~600 KB to a small payload', () => {
    const calls = Array.from({ length: 22 }, (_, i) => bigCall(i, 27_000))
    expect(JSON.stringify(calls).length).toBeGreaterThan(600_000)

    const bounded = boundToolsCalledForStatus(calls)

    expect(bounded).toHaveLength(22)
    expect(JSON.stringify(bounded).length).toBeLessThan(64 * 1024)
    expect(bounded[0]).toEqual({
      serverName: 'git',
      toolName: 'read_file',
      args: { truncated: true, preview: expect.any(String) },
      result: { truncated: true, preview: expect.any(String) },
      durationMs: 12,
    })
  })

  it('keeps the first MAX_STATUS_TOOL_CALLS calls in order', () => {
    const calls = Array.from({ length: 80 }, (_, i) => bigCall(i, 10))
    const bounded = boundToolsCalledForStatus(calls) as Array<{ args: { path: string } }>
    expect(bounded).toHaveLength(MAX_STATUS_TOOL_CALLS)
    expect(bounded[MAX_STATUS_TOOL_CALLS - 1].args).toEqual(
      normalizeToolArgsForStatus(calls[MAX_STATUS_TOOL_CALLS - 1].args)
    )
  })

  it('keeps artifact results after the first MAX_STATUS_TOOL_CALLS calls, without args', () => {
    const calls: unknown[] = Array.from({ length: 55 }, (_, i) => bigCall(i, 10))
    calls.push({
      serverName: 'clerum',
      toolName: 'generate_docx',
      args: { content: 'c'.repeat(50_000) },
      result: artifactResult('report.docx'),
      durationMs: 40,
    })
    calls.push({
      serverName: 'clerum',
      toolName: 'generate_md',
      args: {},
      result: JSON.stringify(artifactResult('notes.md')),
      durationMs: 5,
    })

    const bounded = boundToolsCalledForStatus(calls)

    expect(bounded).toHaveLength(MAX_STATUS_TOOL_CALLS + 2)
    expect(bounded[MAX_STATUS_TOOL_CALLS]).toEqual({
      serverName: 'clerum',
      toolName: 'generate_docx',
      result: artifactResult('report.docx'),
      durationMs: 40,
    })
    expect(bounded[MAX_STATUS_TOOL_CALLS + 1]).toEqual({
      serverName: 'clerum',
      toolName: 'generate_md',
      result: JSON.stringify(artifactResult('notes.md')),
      durationMs: 5,
    })
  })

  it('caps artifact calls kept after the first MAX_STATUS_TOOL_CALLS calls', () => {
    const calls: unknown[] = Array.from({ length: MAX_STATUS_TOOL_CALLS }, (_, i) => bigCall(i, 10))
    for (let i = 0; i < MAX_STATUS_TOOL_CALLS + 10; i++) {
      calls.push({
        serverName: 'clerum',
        toolName: 'generate_md',
        args: {},
        result: artifactResult(`a-${i}.md`),
        durationMs: 1,
      })
    }
    expect(boundToolsCalledForStatus(calls)).toHaveLength(MAX_STATUS_TOOL_CALLS * 2)
  })

  it('reduces an oversized artifact result to the artifact instead of a preview', () => {
    const oversized = { ...artifactResult('big.pdf'), content: 'q'.repeat(5_000) }
    const calls = [
      { serverName: 'clerum', toolName: 'generate_pdf', args: {}, result: oversized },
      {
        serverName: 'clerum',
        toolName: 'generate_pdf',
        args: {},
        result: JSON.stringify(oversized),
      },
    ]

    const bounded = boundToolsCalledForStatus(calls) as Array<{ result: unknown }>

    expect(bounded[0].result).toEqual(artifactResult('big.pdf'))
    expect(bounded[1].result).toEqual(artifactResult('big.pdf'))
  })

  it('reduces an oversized artifact result to the artifact WRC would accept', () => {
    const result = {
      success: true,
      content: 'q'.repeat(5_000),
      artifact: {
        name: `${' '.repeat(1_030)}report.pdf`,
        format: 'pdf',
        path: '/output/report.pdf',
        sizeBytes: 10,
        createdAt: '2026-10-16T00:00:00.000Z',
        extra: 'e',
      },
    }
    const bounded = boundToolsCalledForStatus([
      { serverName: 'clerum', toolName: 'generate_pdf', result },
    ]) as Array<{ result: { artifact: Record<string, unknown> } }>

    expect(bounded[0].result.artifact).toEqual({
      name: 'report.pdf',
      format: 'pdf',
      path: '/output/report.pdf',
      sizeBytes: 10,
      createdAt: '2026-10-16T00:00:00.000Z',
    })
  })

  it('previews an oversized artifact result that WRC would reject', () => {
    const result = {
      success: true,
      artifact: { name: `abc${' '.repeat(1_030)}\u0000`, format: 'pdf', path: '/output/x' },
    }
    const bounded = boundToolsCalledForStatus([
      { serverName: 'clerum', toolName: 'generate_pdf', result },
    ]) as Array<{ result: unknown }>

    expect(bounded[0].result).toEqual({ truncated: true, preview: expect.any(String) })
  })

  it('keeps 100 oversized multi-byte artifact results under the WRC body limit', () => {
    const calls = Array.from({ length: 100 }, (_, i) => ({
      serverName: 'clerum',
      toolName: 'generate_pdf',
      result: {
        success: true,
        artifact: {
          name: `${'€'.repeat(2_000)}${i}`,
          format: '€'.repeat(2_000),
          path: `/output/${'€'.repeat(2_000)}`,
          createdAt: '€'.repeat(2_000),
          sizeBytes: 1,
        },
        content: '€'.repeat(5_000),
      },
    }))
    const bytes = Buffer.byteLength(JSON.stringify(boundToolsCalledForStatus(calls)))
    expect(bytes).toBeLessThan(512 * 1024)
  })

  it('passes malformed entries through for the server to reject', () => {
    const calls = [{ toolName: 'no-server', args: {}, result: 'ok' }, 'not-a-record']
    expect(boundToolsCalledForStatus(calls)).toEqual([
      { toolName: 'no-server', args: {}, result: 'ok' },
      'not-a-record',
    ])
  })
})
