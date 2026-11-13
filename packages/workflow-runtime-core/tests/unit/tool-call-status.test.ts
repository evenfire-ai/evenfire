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

// --- R1-M1: the limits also count serialized UTF-8 bytes -------------------

// The most one args or result value costs once serialized: a preview of
// 2 x 1,024 bytes inside its `{"truncated":true,"preview":""}` wrapper (31 bytes).
const MAX_VALUE_BYTES = 2 * STATUS_TOOL_RESULT_PREVIEW_LIMIT + 31
const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const fill = (unit: string, chars: number) =>
  unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
const HEAVY_UNITS = ['日本語テキスト', '\u0001\u001b', '"\\']
const rejectedArtifact = { name: 'a/b', format: 'pdf', path: '/output/x' }

/**
 * Multi-byte text, control characters and quotes in args and results. A call
 * past the first MAX_STATUS_TOOL_CALLS is kept only when its result parses as an
 * artifact result, so those carry an artifact WRC rejects and stay previews.
 */
const heavyCall = (i: number) => {
  const unit = HEAVY_UNITS[i % HEAVY_UNITS.length]
  return {
    serverName: 'srv',
    toolName: 'tool',
    durationMs: 1,
    args: i % 2 ? { query: fill(unit, 5_000) } : fill(unit, 1_024),
    result:
      i >= MAX_STATUS_TOOL_CALLS
        ? { success: true, artifact: rejectedArtifact, content: fill(unit, 5_000) }
        : i % 2
          ? fill(unit, 1_024)
          : [{ type: 'text', text: fill(unit, 5_000) }],
  }
}

describe('serialized size of bounded tool calls', () => {
  it('bounds multi-byte, control-character and quoted args and results by serialized bytes', () => {
    const calls = Array.from({ length: 2 * MAX_STATUS_TOOL_CALLS }, (_, i) => heavyCall(i))

    const bounded = boundToolsCalledForStatus(calls) as Array<{
      args?: unknown
      result?: { truncated?: boolean; preview?: string }
    }>

    // Liveness: every call is still reported and the previews carry text.
    expect(bounded).toHaveLength(2 * MAX_STATUS_TOOL_CALLS)
    const overLongResults = bounded.filter((_, i) => i >= MAX_STATUS_TOOL_CALLS || i % 2 === 0)
    expect(overLongResults).toHaveLength(75)
    for (const call of overLongResults) {
      expect(call.result).toEqual({ truncated: true, preview: expect.any(String) })
      expect(call.result?.preview?.length).toBeGreaterThan(300)
    }
    const total = serializedBytes(bounded)
    expect(total).toBeGreaterThan(200 * 1024)

    for (const [i, call] of bounded.entries()) {
      if (i < MAX_STATUS_TOOL_CALLS) {
        expect(call.args).toBeDefined()
        expect(serializedBytes(call.args)).toBeLessThanOrEqual(MAX_VALUE_BYTES)
      }
      expect(serializedBytes(call.result)).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    }
    // 150 values plus at most 80 bytes of names, duration and punctuation per call.
    expect(total).toBeLessThanOrEqual(150 * MAX_VALUE_BYTES + 100 * 80)
  })

  it.each([
    ['a string of control characters', '\u0001'.repeat(1_024)],
    ['a string of CJK text', '日'.repeat(1_024)],
    ['a string of lone surrogates', '\ud83d'.repeat(1_024)],
    ['a record of CJK text', { q: '日'.repeat(1_000) }],
    ['an array of CJK text', ['日'.repeat(1_000)]],
  ])('previews %s that fits the character limit but not the byte limit', (_name, value) => {
    for (const normalize of [normalizeToolResultForStatus, normalizeToolArgsForStatus]) {
      const out = normalize(value) as { preview: string }
      expect(out).toEqual({ truncated: true, preview: expect.any(String) })
      // The cut keeps as much as the byte limit allows (within one character of it).
      expect(serializedBytes(out)).toBeLessThanOrEqual(MAX_VALUE_BYTES)
      expect(serializedBytes(out)).toBeGreaterThan(MAX_VALUE_BYTES - 6)
    }
  })

  it.each([
    ['quotes', '"'.repeat(1_024)],
    ['backslashes', '\\'.repeat(1_024)],
    ['newlines', '\n'.repeat(1_024)],
    ['accented Latin text', 'é'.repeat(1_024)],
    ['emoji', '😀'.repeat(512)],
    ['ANSI-coloured terminal output', '\u001b[31mERR\u001b[0m '.repeat(78)],
  ])('keeps %s within the character limit whole', (_name, value) => {
    expect(normalizeToolResultForStatus(value)).toBe(value)
    const record = { text: value.slice(0, 400) }
    expect(normalizeToolArgsForStatus(record)).toBe(record)
  })

  it('cuts a preview at the byte limit on a code-point boundary', () => {
    const cjk = normalizeToolResultForStatus('日'.repeat(5_000)) as { preview: string }
    expect(cjk.preview).toBe('日'.repeat(682))

    const control = normalizeToolArgsForStatus('\u0001'.repeat(5_000)) as { preview: string }
    expect(control.preview).toBe('\u0001'.repeat(341))

    // 1,024 UTF-16 units end inside the 512th emoji; the cut drops that half.
    const emoji = normalizeToolResultForStatus(`x${'😀'.repeat(600)}`) as { preview: string }
    expect(emoji.preview).toBe(`x${'😀'.repeat(511)}`)
  })

  it('counts the {value} wrapper of non-record args, so a second pass reaches the same byte verdict', () => {
    // 12 bytes of wrapper put each of these over the byte limit although the text fits it.
    for (const args of ['日'.repeat(680), '"'.repeat(1_020), '\u0001'.repeat(340)]) {
      const once = normalizeToolArgsForStatus(args)
      expect(once).toEqual({ truncated: true, preview: args })
      expect(normalizeToolArgsForStatus(once)).toBe(once)
    }
    // Witness: just under the limit with the wrapper, the value is still sent whole.
    const whole = '日'.repeat(678)
    const wrapped = normalizeToolArgsForStatus(whole)
    expect(wrapped).toEqual({ value: whole })
    expect(normalizeToolArgsForStatus(wrapped)).toBe(wrapped)
  })

  it('normalizing byte-heavy values twice changes nothing', () => {
    const values: unknown[] = [
      '日'.repeat(1_024),
      '\u0001'.repeat(5_000),
      { q: '日'.repeat(1_000) },
      { q: '"'.repeat(5_000) },
      [{ type: 'text', text: fill(HEAVY_UNITS[0], 5_000) }],
    ]
    for (const value of values) {
      for (const normalize of [normalizeToolResultForStatus, normalizeToolArgsForStatus]) {
        const once = normalize(value)
        expect(once).toEqual({ truncated: true, preview: expect.any(String) })
        expect(normalize(once)).toEqual(once)
      }
    }
  })
})

// --- R1-L6 (only if the owner includes the guard change) --------------------

describe('preview pass-through guard, serialized size', () => {
  it('re-bounds a preview-shaped value whose text is over the byte limit', () => {
    const crafted = { truncated: true, preview: '\u0001'.repeat(1_024) }
    for (const normalize of [normalizeToolResultForStatus, normalizeToolArgsForStatus]) {
      const out = normalize(crafted) as { preview: string }
      expect(out).not.toBe(crafted)
      expect(out).toEqual({ truncated: true, preview: expect.any(String) })
      expect(out.preview.length).toBeGreaterThan(300)
      expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(
        2 * STATUS_TOOL_RESULT_PREVIEW_LIMIT + 31
      )
      expect(normalize(out)).toBe(out)
    }
  })

  it('still passes a preview within both limits through', () => {
    for (const preview of ['"'.repeat(1_024), '日'.repeat(682), 'x'.repeat(1_024)]) {
      const value = { truncated: true, preview }
      expect(normalizeToolResultForStatus(value)).toBe(value)
      expect(normalizeToolArgsForStatus(value)).toBe(value)
    }
  })
})
