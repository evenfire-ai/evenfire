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
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '@/uiTypes'
import { entryNameFitsZipFields, finalizeEntryName } from '../../../../../src/gfs/zipEntryName'
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

// R1-M6 (round 2): starting states must be VALID composer states. A generator
// that can produce `existing` above the cap tests states production can never
// hold, so every invariant below was provable against garbage. The existing
// arrays are constrained to at-most-cap; incoming stays arbitrary.
const heldImagesArbitrary = fc
  .uniqueArray(imageArbitrary, {
    minLength: 0,
    maxLength: COMPOSER_MAX_IMAGE_ATTACHMENTS,
    selector: item => `${item.mimeType}:${item.sizeBytes}:${item.dataBase64}`,
  })
  .map(items => items as ComposerImageAttachment[])

const heldReferencesArbitrary = fc
  .uniqueArray(referenceArbitrary, {
    minLength: 0,
    maxLength: FILE_REFERENCE_MAX_COUNT,
    selector: item => item.id,
  })
  .map(items => items as ComposerReferenceAttachment[])

describe('composer merge invariants (R1-M6)', () => {
  it('counts a cap-time duplicate as a duplicate, not a drop (R2-L1)', () => {
    // Composer already at the cap; the restore payload is byte-identical to
    // what is held. Nothing is lost — reporting a drop would be a lie.
    const held = Array.from({ length: COMPOSER_MAX_IMAGE_ATTACHMENTS }, (_, index) => ({
      ...({} as ComposerImageAttachment),
      id: `held-${index}`,
      name: `held-${index}.png`,
      mimeType: 'image/png' as const,
      dataBase64: `aGVsZA-${index}`,
      sizeBytes: 4,
      previewDataUrl: `data:image/png;base64,aGVsZA-${index}`,
    }))
    const restore = [held[3]!, held[7]!]
    const outcome = mergeComposerImageAttachments(held, restore)
    expect(outcome.duplicates).toBe(2)
    expect(outcome.dropped).toBe(0)
    expect(outcome.kept).toBe(0)
    expect(outcome.next).toHaveLength(COMPOSER_MAX_IMAGE_ATTACHMENTS)
    // The exact same set survives: restoring dropped nothing new.
    expect(outcome.next).toEqual(held)
  })

  it('image merge: cap, count conservation, and existing-set stability', () => {
    fc.assert(
      fc.property(
        heldImagesArbitrary,
        fc.array(imageArbitrary, { maxLength: 30 }),
        (existing, incoming) => {
          // Valid starting state (R1-M6 round 2): a real composer is never
          // above the cap, and never holds byte-duplicates.
          expect(existing.length).toBeLessThanOrEqual(COMPOSER_MAX_IMAGE_ATTACHMENTS)
          const outcome = mergeComposerImageAttachments(
            existing,
            incoming as ComposerImageAttachment[]
          )
          expect(outcome.next.length).toBeLessThanOrEqual(COMPOSER_MAX_IMAGE_ATTACHMENTS)
          expect(outcome.kept + outcome.duplicates + outcome.dropped).toBe(incoming.length)
          // The composer never loses what it already held.
          expect(outcome.next.slice(0, existing.length)).toEqual(existing)
          // Duplicates never consume slots: keeping room is consistent with counts.
          expect(outcome.kept).toBe(outcome.next.length - existing.length)
          // Decision path (R2-L1): drops can only be NOT-held incoming items.
          const heldKeys = new Set(
            existing.map(item => `${item.mimeType}:${item.sizeBytes}:${item.dataBase64}`)
          )
          const notHeldIncoming = incoming.filter(
            item => !heldKeys.has(`${item.mimeType}:${item.sizeBytes}:${item.dataBase64}`)
          )
          expect(outcome.dropped).toBeLessThanOrEqual(notHeldIncoming.length)
        }
      ),
      { numRuns: 80 }
    )
  })

  it('image merge at cap: incoming duplicates never count as drops (decision path)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: COMPOSER_MAX_IMAGE_ATTACHMENTS }),
        fc.array(imageArbitrary, { maxLength: 10 }),
        (heldCount, extra) => {
          // A composer at the cap whose restore payload includes held images:
          // every held image reports as a duplicate and dropped is exactly the
          // not-held overflow.
          const held = Array.from({ length: heldCount }, (_, index) => ({
            ...({} as ComposerImageAttachment),
            id: `h-${index}`,
            name: `h-${index}.png`,
            mimeType: 'image/png' as const,
            dataBase64: `aGQt${index}`,
            sizeBytes: index,
            previewDataUrl: `data:image/png;base64,aGQt${index}`,
          }))
          const payload = [
            ...held.slice(0, Math.min(3, heldCount)),
            ...(extra as ComposerImageAttachment[]),
          ]
          const outcome = mergeComposerImageAttachments(held, payload)
          expect(outcome.next).toEqual(
            held.length ? expect.arrayContaining(held) : expect.anything()
          )
          expect(outcome.next.length).toBe(Math.max(heldCount, 0) + outcome.kept)
          const notHeld = payload.filter(
            item =>
              !held.some(h => h.dataBase64 === item.dataBase64 && h.sizeBytes === item.sizeBytes)
          )
          expect(outcome.dropped).toBe(
            Math.max(0, notHeld.length - Math.max(0, COMPOSER_MAX_IMAGE_ATTACHMENTS - heldCount))
          )
        }
      ),
      { numRuns: 60 }
    )
  })

  it('image merge idempotence: a second identical restore changes nothing', () => {
    fc.assert(
      fc.property(
        heldImagesArbitrary,
        fc.array(imageArbitrary, { maxLength: 15 }),
        (existing, incoming) => {
          const first = mergeComposerImageAttachments(
            existing,
            incoming as ComposerImageAttachment[]
          )
          const second = mergeComposerImageAttachments(
            first.next,
            incoming as ComposerImageAttachment[]
          )
          // State stability: nothing new is kept, the composer is unchanged, and
          // the payload still accounts entirely to duplicates + (persistent,
          // cap-driven) drops — never to new losses.
          expect(second.kept).toBe(0)
          expect(second.next).toEqual(first.next)
          expect(second.duplicates + second.dropped).toBe(incoming.length)
        }
      ),
      { numRuns: 60 }
    )
  })

  it('reference merge: file cap, count conservation, and id uniqueness', () => {
    fc.assert(
      fc.property(
        heldReferencesArbitrary,
        fc.array(referenceArbitrary, { maxLength: 25 }),
        (existing, incoming) => {
          const outcome = mergeComposerReferenceAttachments(
            existing,
            incoming as ComposerReferenceAttachment[]
          )
          expect(existing.length).toBeLessThanOrEqual(FILE_REFERENCE_MAX_COUNT)
          expect(outcome.next.length).toBeLessThanOrEqual(FILE_REFERENCE_MAX_COUNT)
          expect(outcome.kept + outcome.duplicates + outcome.dropped).toBe(incoming.length)
          const ids = new Set(outcome.next.map(item => item.id))
          expect(ids.size).toBe(outcome.next.length)
          // Held references are never dropped (dedupe runs first).
          expect(outcome.next.slice(0, existing.length)).toEqual(existing)
        }
      ),
      { numRuns: 80 }
    )
  })

  it('reference merge idempotence: a second identical restore changes nothing', () => {
    fc.assert(
      fc.property(
        heldReferencesArbitrary,
        fc.array(referenceArbitrary, { maxLength: 10 }),
        (existing, incoming) => {
          const first = mergeComposerReferenceAttachments(
            existing,
            incoming as ComposerReferenceAttachment[]
          )
          const second = mergeComposerReferenceAttachments(
            first.next,
            incoming as ComposerReferenceAttachment[]
          )
          expect(second.kept).toBe(0)
          expect(second.next).toEqual(first.next)
          expect(second.duplicates + second.dropped).toBe(incoming.length)
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

  it('finalized entry names never collide case-folded and always fit the 16-bit fields', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 30 }),
        names => {
          const usedFolded = new Set<string>()
          const written: string[] = []
          for (const name of names) {
            const finalized = finalizeEntryName(name, usedFolded)
            usedFolded.add(finalized.folded)
            written.push(finalized.name)
          }
          const folded = new Set(written.map(name => name.toLowerCase()))
          expect(folded.size).toBe(written.length)
          expect(written).toHaveLength(names.length)
          for (const name of written) expect(entryNameFitsZipFields(name)).toBe(true)
        }
      ),
      { numRuns: 60 }
    )
  })
})
