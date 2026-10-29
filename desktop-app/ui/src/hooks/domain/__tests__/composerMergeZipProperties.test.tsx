// @vitest-environment jsdom
/**
 * R1-M6 — property/invariant coverage for the merge, dedupe, cap and path
 * normalization rules the cancel-restore and folder-zip paths rely on. These
 * complement the example tests: the examples pin behavior at the boundaries,
 * the properties pin the invariants for arbitrary inputs.
 *
 * The property runs are deliberately LARGE: the merge and allocation rules
 * interact (caps, dedupe, ordering, case folding), and a small sample proves
 * little about a rule that only misbehaves in a rare combination. Every run
 * starts from a VALID composer state, so the invariants are provable against
 * states production can actually hold.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import { COMPOSER_MAX_ATTACHMENTS } from '@constants/attachments'
import { GFS_ZIP_MAX_SEGMENT_NAME_BYTES, sanitizeZipSegment } from '@lib/gfsFolderZip'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '@/uiTypes'
import { ZipEntryNameAllocator, entryNameFitsZipFields } from '../../../../../src/gfs/zipEntryName'
import {
  mergeComposerImageAttachments,
  mergeComposerReferenceAttachments,
} from '../useComposerAttachments'

/**
 * Tens of thousands of cases per property. The properties are small (arrays
 * of short strings), so this costs seconds, not minutes — and it is the
 * difference between "the invariant held for 80 samples" and "the invariant
 * held for 25 000".
 */
const PROPERTY_RUNS = 25_000

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
    maxLength: COMPOSER_MAX_ATTACHMENTS,
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
    const held = Array.from({ length: COMPOSER_MAX_ATTACHMENTS }, (_, index) => ({
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
    expect(outcome.next).toHaveLength(COMPOSER_MAX_ATTACHMENTS)
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
          expect(existing.length).toBeLessThanOrEqual(COMPOSER_MAX_ATTACHMENTS)
          const outcome = mergeComposerImageAttachments(
            existing,
            incoming as ComposerImageAttachment[]
          )
          expect(outcome.next.length).toBeLessThanOrEqual(COMPOSER_MAX_ATTACHMENTS)
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
      { numRuns: PROPERTY_RUNS }
    )
  })

  it('image merge at cap: incoming duplicates never count as drops (decision path)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: COMPOSER_MAX_ATTACHMENTS }),
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
          // The drop count replays the documented classification (R2-L1/R4-L1)
          // sequentially: an incoming item that duplicates ANYTHING already
          // accepted — the held set or an earlier incoming item — is a
          // duplicate, never a drop; only non-duplicates past the free slots
          // are dropped. Counting not-held items individually (the old
          // formula) treated identical incoming duplicates as overflow drops
          // and contradicted this property's own title.
          const acceptedKeys = new Set(
            held.map(item => `${item.mimeType}:${item.sizeBytes}:${item.dataBase64}`)
          )
          let freeSlots = Math.max(0, COMPOSER_MAX_ATTACHMENTS - heldCount)
          let expectedDropped = 0
          for (const item of payload) {
            const key = `${item.mimeType}:${item.sizeBytes}:${item.dataBase64}`
            if (acceptedKeys.has(key)) continue
            if (freeSlots === 0) {
              expectedDropped += 1
              continue
            }
            freeSlots -= 1
            acceptedKeys.add(key)
          }
          expect(outcome.dropped).toBe(expectedDropped)
        }
      ),
      { numRuns: PROPERTY_RUNS }
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
      { numRuns: PROPERTY_RUNS }
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
      { numRuns: PROPERTY_RUNS }
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
      { numRuns: PROPERTY_RUNS }
    )
  })

  it('image merge: a duplicate arriving AFTER the cap is reached is a duplicate (R4-L1)', () => {
    // The composer is full. The payload's FIRST item is unique — it is
    // dropped — and the SECOND is a byte-identical copy of an image the
    // composer already holds. Nothing was lost by the second item, so it is a
    // DUPLICATE, not another drop: stopping the scan at the cap would
    // classify it without looking at it and report a lost attachment.
    const held = Array.from({ length: COMPOSER_MAX_ATTACHMENTS }, (_, index) => ({
      ...({} as ComposerImageAttachment),
      id: `held-${index}`,
      name: `held-${index}.png`,
      mimeType: 'image/png' as const,
      dataBase64: `aGQt${index}`,
      sizeBytes: index,
      previewDataUrl: `data:image/png;base64,aGQt${index}`,
    }))
    const outcome = mergeComposerImageAttachments(held, [
      {
        id: 'unique',
        name: 'unique.png',
        mimeType: 'image/png' as const,
        dataBase64: 'dW5pcXVl',
        sizeBytes: 7,
        previewDataUrl: 'data:image/png;base64,dW5pcXVl',
      },
      // A byte-identical copy of the FIRST held image.
      {
        id: 'held-0',
        name: 'held-0.png',
        mimeType: 'image/png' as const,
        dataBase64: 'aGQt0',
        sizeBytes: 0,
        previewDataUrl: 'data:image/png;base64,aGQt0',
      },
    ])
    expect(outcome.kept).toBe(0)
    expect(outcome.duplicates).toBe(1)
    expect(outcome.dropped).toBe(1)
    expect(outcome.next).toEqual(held)
  })

  it('reference merge: a duplicate arriving AFTER the cap is reached is a duplicate (R4-L1)', () => {
    const held = Array.from({ length: FILE_REFERENCE_MAX_COUNT }, (_, index) => ({
      ...({} as ComposerReferenceAttachment),
      id: `held-${index}`,
      type: 'plugin' as const,
      namespace: 'ns',
      name: `held-${index}`,
      label: `held ${index}`,
    }))
    const outcome = mergeComposerReferenceAttachments(held, [
      {
        id: 'unique',
        type: 'plugin' as const,
        namespace: 'ns',
        name: 'unique',
        label: 'unique',
      },
      // A copy of the FIRST held reference.
      {
        id: 'held-0',
        type: 'plugin' as const,
        namespace: 'ns',
        name: 'held-0',
        label: 'held 0',
      },
    ])
    expect(outcome.kept).toBe(0)
    expect(outcome.duplicates).toBe(1)
    expect(outcome.dropped).toBe(1)
    expect(outcome.next).toEqual(held)
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
        // A Windows DEVICE name is not a name: `CON` is the console device.
        expect(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)).toBe(false)
      }),
      { numRuns: PROPERTY_RUNS }
    )
  })

  it('allocated entry names never collide case-folded and always fit the 16-bit fields', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 30 }),
        names => {
          const allocator = new ZipEntryNameAllocator()
          const written: string[] = []
          for (const name of names) {
            const plan = allocator.plan(name)
            if (!plan.fits) continue
            allocator.commit(plan)
            written.push(plan.name)
          }
          const folded = new Set(written.map(name => name.toLowerCase()))
          expect(folded.size).toBe(written.length)
          expect(written).toHaveLength(names.length)
          for (const name of written) expect(entryNameFitsZipFields(name)).toBe(true)
        }
      ),
      { numRuns: PROPERTY_RUNS }
    )
  })

  it('never lets a FILE and a DIRECTORY share a path (R3-M5)', () => {
    // The invariant that keeps an archive valid on a case-insensitive
    // extractor: no committed file may sit at a path another committed file
    // implies as a directory.
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 4 }),
          { maxLength: 20 }
        ),
        paths => {
          const allocator = new ZipEntryNameAllocator()
          const committed: string[] = []
          for (const segments of paths) {
            const plan = allocator.plan(segments.join('/'))
            if (!plan.fits) continue
            allocator.commit(plan)
            committed.push(plan.name)
          }
          const files = new Set(committed.map(name => name.toLowerCase()))
          const directories = new Set<string>()
          for (const name of committed) {
            const parts = name.split('/')
            parts.pop()
            let current = ''
            for (const part of parts) {
              current = current === '' ? part : `${current}/${part}`
              directories.add(current.toLowerCase())
            }
          }
          for (const file of files) {
            expect(directories.has(file)).toBe(false)
          }
        }
      ),
      { numRuns: PROPERTY_RUNS }
    )
  })

  it('allocates deterministically: the same inputs give the same names', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 16 }), { maxLength: 20 }),
        names => {
          const allocate = () => {
            const allocator = new ZipEntryNameAllocator()
            return names.map(name => {
              const plan = allocator.plan(name)
              if (plan.fits) allocator.commit(plan)
              return plan.name
            })
          }
          expect(allocate()).toEqual(allocate())
        }
      ),
      { numRuns: PROPERTY_RUNS }
    )
  })
})
