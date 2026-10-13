import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/types'
import { PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'
import { gfsImageParts, projectGfsMessages } from './messageProjection'

const source = {
  kind: 'gfs' as const,
  toolCallId: 'read-image',
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  version: 7,
  name: 'unit.png',
}
const receipt = {
  delivery: 'workspace_file',
  id: 'unit-transfer',
  source,
  path: '.gfs-downloads/unit-transfer/source',
  sha256: 'b'.repeat(64),
  sizeBytes: Buffer.from(PNG_2X2_BASE64, 'base64').byteLength,
  expiresAt: '2026-10-09T00:00:00.000Z',
  visualDelivery: 'included',
  usage: { visualDelivery: 'included', processLocally: true, wholeFileToContextAllowed: false },
  metadata: { label: 'unit-retained-metadata' },
}

function messages(content = JSON.stringify(receipt)): ChatMessage[] {
  return [
    { role: 'tool', name: 'clerum__gfs_read', tool_call_id: source.toolCallId, content },
    {
      role: 'user',
      content: '',
      imageOrigin: 'tool_result',
      contentParts: [
        { type: 'image', mimeType: 'image/png', data: PNG_2X2_BASE64, source, width: 2, height: 2 },
      ],
    },
  ]
}

describe('per-attempt GFS receipt projection', () => {
  it('demotes workspace pixels while preserving every receipt field and canonical input', () => {
    const original = messages()
    const before = structuredClone(original)
    const projected = projectGfsMessages(
      original,
      new Set(gfsImageParts(original)),
      'model_image_input_unavailable'
    )
    expect(gfsImageParts(projected)).toEqual([])
    expect(JSON.parse(projected[0]!.content)).toEqual({
      ...receipt,
      visualDelivery: 'not_included',
      visualReason: 'model_image_input_unavailable',
      usage: {
        ...receipt.usage,
        visualDelivery: 'not_included',
        visualReason: 'model_image_input_unavailable',
      },
    })
    expect(original).toEqual(before)
  })

  it('keeps legacy image receipts as bounded references', () => {
    const original = messages(JSON.stringify({ delivery: 'image_input', resource: source }))
    const projected = projectGfsMessages(
      original,
      new Set(gfsImageParts(original)),
      'image_input_limit_exceeded'
    )
    expect(JSON.parse(projected[0]!.content)).toMatchObject({
      delivery: 'reference_only',
      reason: 'image_input_limit_exceeded',
      resource: { kind: 'gfs', resourceId: source.resourceId, version: 7 },
    })
  })

  it.each([
    { drive: 'other' },
    { resourceId: 'b'.repeat(32) },
    { gfsUri: `gfs://main/${'b'.repeat(32)}` },
    { version: 8 },
  ])('does not relabel a receipt from another source: %j', changed => {
    const original = messages(JSON.stringify({ ...receipt, source: { ...source, ...changed } }))
    const before = structuredClone(original)
    expect(() =>
      projectGfsMessages(
        original,
        new Set(gfsImageParts(original)),
        'model_image_input_unavailable'
      )
    ).toThrow('invalid_response')
    expect(original).toEqual(before)
  })
})
