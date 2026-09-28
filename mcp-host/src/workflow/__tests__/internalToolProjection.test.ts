import { describe, expect, it } from 'vitest'
import { projectInternalToolResult } from '../internalToolProjection'
import type { InternalToolResult } from '../types'

const image = {
  source: {
    kind: 'gfs' as const,
    drive: 'main',
    resourceId: 'a'.repeat(32),
    gfsUri: `gfs://main/${'a'.repeat(32)}`,
    version: 1,
    name: 'photo.png',
  },
  mimeType: 'image/png' as const,
  // This unit checks projection only; decoding belongs to imageValidation tests.
  dataBase64: 'payload-must-not-be-recorded',
  sizeBytes: 12,
  width: 1,
  height: 1,
}

describe('nonvisual workflow result projection', () => {
  it('preserves existing text and generated artifact contracts', () => {
    const result: InternalToolResult = {
      success: true,
      content: 'report',
      artifact: {
        name: 'report.pdf',
        format: 'pdf',
        path: '/output/report.pdf',
        sizeBytes: 5,
        createdAt: '2026-09-16T00:00:00Z',
      },
    }
    expect(projectInternalToolResult(result)).toEqual(result)
    expect(projectInternalToolResult(result).artifact).not.toBe(result.artifact)
  })

  it('replaces visual success with references and never spreads hidden binary fields', () => {
    const result = {
      success: true,
      content: JSON.stringify({ delivery: 'image_input' }),
      images: [image],
      unexpected: { bytes: Buffer.from('not-for-workflow') },
    }
    const projected = projectInternalToolResult(result)
    expect(JSON.parse(projected.content!)).toMatchObject({
      delivery: 'reference_only',
      reason: 'image_input_unavailable_in_workflow',
      resources: [{ source: image.source }],
    })
    expect(JSON.stringify(projected)).not.toContain(image.dataBase64)
    expect(projected).not.toHaveProperty('images')
    expect(projected).not.toHaveProperty('unexpected')
  })

  it('drops any visual or artifact payload from failed results', () => {
    expect(projectInternalToolResult({ success: false, error: 'denied', images: [image] })).toEqual(
      { success: false, error: 'denied' }
    )
  })
})
