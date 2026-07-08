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
