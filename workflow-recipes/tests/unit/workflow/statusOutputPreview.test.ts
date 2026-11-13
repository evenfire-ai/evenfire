import { describe, expect, it } from 'vitest'
import { buildStatusOutputPreview } from '../../../src/workflow/statusOutputPreview'

describe('buildStatusOutputPreview', () => {
  it('keeps short string outputs with explicit non-truncated metadata', () => {
    expect(buildStatusOutputPreview('short report', 32)).toEqual({
      output: 'short report',
      outputTruncated: false,
      outputLength: 12,
      outputPreviewMaxChars: 32,
    })
  })

  it('truncates long string outputs and records original length', () => {
    expect(buildStatusOutputPreview('abcdef', 3)).toEqual({
      output: 'abc',
      outputTruncated: true,
      outputLength: 6,
      outputPreviewMaxChars: 3,
    })
  })

  it('serializes object outputs before applying the preview limit', () => {
    const preview = buildStatusOutputPreview({ report: 'x'.repeat(20) }, 16)

    expect(preview.output).toHaveLength(16)
    expect(preview.outputTruncated).toBe(true)
    expect(preview.outputLength).toBeGreaterThan(16)
    expect(preview.outputPreviewMaxChars).toBe(16)
  })

  it('serializes circular object outputs safely', () => {
    const value: Record<string, unknown> = { name: 'root' }
    value.self = value

    const preview = buildStatusOutputPreview(value, 128)

    expect(preview.output).toContain('"self":"[Circular]"')
    expect(preview.outputTruncated).toBe(false)
  })
})

describe('buildStatusOutputPreview with the length the client reported', () => {
  it('gives the same result as without a hint when the hint is absent', () => {
    expect(buildStatusOutputPreview('abcdef', 3, undefined)).toEqual(
      buildStatusOutputPreview('abcdef', 3)
    )
    expect(buildStatusOutputPreview('abc', 8, {})).toEqual({
      output: 'abc',
      outputTruncated: false,
      outputLength: 3,
      outputPreviewMaxChars: 8,
    })
  })

  it('honours a valid hint: truncated with a longer original length', () => {
    expect(
      buildStatusOutputPreview('abc', 8, { outputTruncated: true, outputLength: 200_000 })
    ).toEqual({
      output: 'abc',
      outputTruncated: true,
      outputLength: 200_000,
      outputPreviewMaxChars: 8,
    })
  })

  it.each([
    ['a shorter length', { outputTruncated: true, outputLength: 2 }],
    ['a non-integer length', { outputTruncated: true, outputLength: 10.5 }],
    ['a string length', { outputTruncated: true, outputLength: '10' }],
    ['an unsafe integer length', { outputTruncated: true, outputLength: 2 ** 53 }],
    ['no truncation flag', { outputLength: 10 }],
    ['a false truncation flag', { outputTruncated: false, outputLength: 10 }],
    ['a string truncation flag', { outputTruncated: 'true', outputLength: 10 }],
  ])('ignores a hint with %s', (_label, reported) => {
    expect(buildStatusOutputPreview('abc', 8, reported)).toEqual({
      output: 'abc',
      outputTruncated: false,
      outputLength: 3,
      outputPreviewMaxChars: 8,
    })
  })

  it('accepts a truncated hint whose length equals what WRC received', () => {
    expect(buildStatusOutputPreview('abc', 8, { outputTruncated: true, outputLength: 3 })).toEqual({
      output: 'abc',
      outputTruncated: false,
      outputLength: 3,
      outputPreviewMaxChars: 8,
    })
  })

  it('still marks an output WRC cut as truncated when the hint says otherwise', () => {
    expect(
      buildStatusOutputPreview('abcdef', 3, { outputTruncated: false, outputLength: 6 })
    ).toEqual({
      output: 'abc',
      outputTruncated: true,
      outputLength: 6,
      outputPreviewMaxChars: 3,
    })
  })
})
