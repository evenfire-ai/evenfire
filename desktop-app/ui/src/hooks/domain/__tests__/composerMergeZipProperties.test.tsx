// @vitest-environment jsdom
/**
 * R1-M6 — property/invariant coverage for the merge, dedupe, cap and path
 * normalization rules the cancel-restore and folder-zip paths rely on. These
 * complement the example tests: the examples pin behavior at the boundaries,
 * the properties pin the invariants for arbitrary inputs.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import { COMPOSER_MAX_IMAGE_ATTACHMENTS } from '@constants/attachments'
import { GFS_ZIP_MAX_SEGMENT_NAME_BYTES, sanitizeZipSegment } from '@lib/gfsFolderZip'
import { createZipWriter } from '@lib/zipWriter'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '@/uiTypes'
import {
  mergeComposerImageAttachments,
  mergeComposerReferenceAttachments,
} from '../useComposerAttachments'

const imageArbitrary = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    dataBase64: fc.string({ minLength: 1, maxLength: 8 }),
    sizeBytes: fc.nat(1000),
  })
  .map(record => ({
    ...record,
    name: `${record.id}.png`,
    mimeType: 'image/png' as const,
    previewDataUrl: `data:image/png;base64,${record.dataBase64}`,
  }))

const referenceArbitrary = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    label: fc.string({ minLength: 0, maxLength: 12 }),
  })
  .map(record => ({
    ...record,
    type: 'plugin' as const,
    namespace: 'ns',
    name: record.id,
  }))

describe('composer merge invariants (R1-M6)', () => {
  it('image merge: cap, count conservation, and existing-set stability', () => {
    fc.assert(
      fc.property(
        fc.array(imageArbitrary, { maxLength: 30 }),
        fc.array(imageArbitrary, { maxLength: 30 }),
        (existing, incoming) => {
          const outcome = mergeComposerImageAttachments(
            existing as ComposerImageAttachment[],
            incoming as ComposerImageAttachment[]
          )
          expect(outcome.next.length).toBeLessThanOrEqual(COMPOSER_MAX_IMAGE_ATTACHMENTS)
          expect(outcome.kept + outcome.duplicates + outcome.dropped).toBe(incoming.length)
          // The composer never loses what it already held.
          expect(outcome.next.slice(0, existing.length)).toEqual(existing)
          // Duplicates never consume slots: keeping room is consistent with counts.
          expect(outcome.kept).toBe(outcome.next.length - existing.length)
        }
      ),
      { numRuns: 60 }
    )
  })

  it('reference merge: file cap, count conservation, and id uniqueness', () => {
    fc.assert(
      fc.property(
        fc.array(referenceArbitrary, { maxLength: 25 }),
        fc.array(referenceArbitrary, { maxLength: 25 }),
        (existing, incoming) => {
          const outcome = mergeComposerReferenceAttachments(
            existing as ComposerReferenceAttachment[],
            incoming as ComposerReferenceAttachment[]
          )
          expect(outcome.next.length).toBeLessThanOrEqual(FILE_REFERENCE_MAX_COUNT)
          expect(outcome.kept + outcome.duplicates + outcome.dropped).toBe(incoming.length)
          const ids = new Set(outcome.next.map(item => item.id))
          expect(ids.size).toBe(outcome.next.length)
        }
      ),
      { numRuns: 60 }
    )
  })
})

describe('zip path normalization invariants (R1-M6)', () => {
  it('sanitized segments never carry separators, reserved chars, or excess length', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), raw => {
        const segment = sanitizeZipSegment(raw)
        expect(segment.length).toBeGreaterThan(0)
        expect(segment).not.toMatch(/[/\\:*?"<>|\u0000]/)
        expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(
          GFS_ZIP_MAX_SEGMENT_NAME_BYTES
        )
        expect(segment).not.toBe('.')
        expect(segment).not.toBe('..')
      }),
      { numRuns: 200 }
    )
  })

  it('built archives never contain case-folded duplicate entry names', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 30 }),
        names => {
          const writer = createZipWriter()
          for (const [index, name] of names.entries()) writer.addFile(name, new Uint8Array([index]))
          const written = archiveEntryNames(writer.build())
          const folded = new Set(written.map(name => name.toLowerCase()))
          expect(folded.size).toBe(written.length)
          expect(written).toHaveLength(names.length)
        }
      ),
      { numRuns: 60 }
    )
  })
})

/** Minimal central-directory reader (name column only). */
function archiveEntryNames(archive: Uint8Array): string[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()
  const eocdOffset = archive.length - 22
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  const names: string[] = []
  let cursor = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = view.getUint16(cursor + 28, true)
    names.push(decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength)))
    cursor += 46 + nameLength
  }
  return names
}
