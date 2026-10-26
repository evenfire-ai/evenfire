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

// These values are inputs to the pure merge helper, not claims about what the
// file-intake UI produces. Shrinking can yield whitespace IDs/base64 and
// zero-byte sizes. Keep this broad domain for helper-only robustness properties;
// ComposerPanel's file-input tests cover producer output.
const helperImageArbitrary = fc
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

function producerShapedImage(
  id: string,
  bytes: readonly number[],
  mimeType: ComposerImageAttachment['mimeType'] = 'image/png'
): ComposerImageAttachment {
  const dataBase64 = btoa(String.fromCharCode(...bytes))
  const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png'
  return {
    id,
    name: `${id}.${extension}`,
    mimeType,
    dataBase64,
    sizeBytes: bytes.length,
    previewDataUrl: `blob:${id}`,
  }
}

// This arbitrary matches ComposerPanel's prepared attachment shape: UUID,
// accepted MIME, non-empty base64, and File.size matching the source bytes.
// The pure helper does not decode images; real intake/cancellation behavior is
// exercised in ComposerPanel and cancellation producer tests.
const producerShapedImageArbitrary = fc
  .record({
    id: fc.uuid(),
    bytes: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 }),
    mimeType: fc.constantFrom('image/png' as const, 'image/jpeg' as const),
  })
  .map(({ id, bytes, mimeType }) => producerShapedImage(id, bytes, mimeType))

function imageIdentityKey(
  image: Pick<ComposerImageAttachment, 'mimeType' | 'sizeBytes' | 'dataBase64'>
): string {
  return JSON.stringify([image.mimeType, image.sizeBytes, image.dataBase64])
}

type ImageMergeCounts = Pick<
  ReturnType<typeof mergeComposerImageAttachments>,
  'kept' | 'duplicates' | 'dropped'
>

type ImageMergeExpectation = ImageMergeCounts & {
  keptIncoming: ComposerImageAttachment[]
}

/**
 * Independent reference model: group incoming identities in first-seen order,
 * then allocate one slot per new group. Copies of held or accepted identities
 * are duplicates; groups after capacity is exhausted are drops. This does not
 * replay the helper's item-by-item acceptance loop.
 */
function expectedImageMergeCounts(
  existing: ComposerImageAttachment[],
  incoming: ComposerImageAttachment[],
  occupiedByFiles = 0
): ImageMergeExpectation {
  const heldIdentities = new Set(existing.map(imageIdentityKey))
  const incomingGroups = new Map<string, { first: ComposerImageAttachment; copies: number }>()
  for (const image of incoming) {
    const identity = imageIdentityKey(image)
    const group = incomingGroups.get(identity)
    if (group) group.copies += 1
    else incomingGroups.set(identity, { first: image, copies: 1 })
  }

  let availableSlots = Math.max(0, COMPOSER_MAX_ATTACHMENTS - existing.length - occupiedByFiles)
  const expected: ImageMergeExpectation = {
    kept: 0,
    duplicates: 0,
    dropped: 0,
    keptIncoming: [],
  }
  for (const [identity, group] of incomingGroups) {
    const { first, copies } = group
    if (heldIdentities.has(identity)) {
      expected.duplicates += copies
    } else if (availableSlots > 0) {
      expected.kept += 1
      expected.keptIncoming.push(first)
      expected.duplicates += copies - 1
      availableSlots -= 1
    } else {
      expected.dropped += copies
    }
  }
  return expected
}

function imageOutputKey(image: ComposerImageAttachment): string {
  return JSON.stringify([image.id, imageIdentityKey(image)])
}

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
  .uniqueArray(producerShapedImageArbitrary, {
    minLength: 0,
    maxLength: COMPOSER_MAX_ATTACHMENTS,
    selector: imageIdentityKey,
  })
  .map(items => items as ComposerImageAttachment[])

const imageMergeInputsWithFileOccupancyArbitrary = fc
  .integer({ min: 0, max: COMPOSER_MAX_ATTACHMENTS })
  .chain(occupiedByFiles =>
    fc
      .uniqueArray(producerShapedImageArbitrary, {
        minLength: 0,
        maxLength: COMPOSER_MAX_ATTACHMENTS - occupiedByFiles,
        selector: imageIdentityKey,
      })
      .map(existing => ({
        existing: existing as ComposerImageAttachment[],
        occupiedByFiles,
      }))
  )

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
        fc.array(helperImageArbitrary, { maxLength: 30 }),
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
        fc.array(helperImageArbitrary, { maxLength: 10 }),
        (heldCount, extra) => {
          // Existing entries are producer-shaped and unique. Incoming values
          // intentionally use the broader helper-only domain, which can shrink
          // to malformed records that normal file intake cannot produce.
          const held = Array.from({ length: heldCount }, (_, index) =>
            producerShapedImage(`h-${index}`, [index, 255])
          )
          const payload = [
            ...held.slice(0, Math.min(3, heldCount)),
            ...(extra as ComposerImageAttachment[]),
          ]
          const outcome = mergeComposerImageAttachments(held, payload)
          const expected = expectedImageMergeCounts(held, payload)
          // The incoming sequential classifier is equivalent here: rejected identity groups
          // never enter the accepted set. Keep this oracle independent of that implementation.
          expect(outcome.next).toEqual(
            held.length ? expect.arrayContaining(held) : expect.anything()
          )
          expect(outcome.next.length).toBe(Math.max(heldCount, 0) + outcome.kept)
          expect(outcome.next.map(imageOutputKey)).toEqual(
            [...held, ...expected.keptIncoming].map(imageOutputKey)
          )
          expect(outcome.next.length).toBe(held.length + expected.kept)
          expect(outcome.kept).toBe(expected.kept)
          expect(outcome.duplicates).toBe(expected.duplicates)
          expect(outcome.dropped).toBe(expected.dropped)
        }
      ),
      { numRuns: PROPERTY_RUNS }
    )
  })

  it('producer-shaped image batches match identity-group capacity counts', () => {
    fc.assert(
      fc.property(
        imageMergeInputsWithFileOccupancyArbitrary,
        fc.array(producerShapedImageArbitrary, { maxLength: 30 }),
        ({ existing, occupiedByFiles }, incoming) => {
          const outcome = mergeComposerImageAttachments(
            existing,
            incoming,
            () => 0,
            occupiedByFiles
          )
          const expected = expectedImageMergeCounts(existing, incoming, occupiedByFiles)
          expect(outcome.next.map(imageOutputKey)).toEqual(
            [...existing, ...expected.keptIncoming].map(imageOutputKey)
          )
          expect(outcome.next.length).toBe(existing.length + expected.kept)
          expect(outcome.kept).toBe(expected.kept)
          expect(outcome.duplicates).toBe(expected.duplicates)
          expect(outcome.dropped).toBe(expected.dropped)
        }
      ),
      { numRuns: PROPERTY_RUNS }
    )
  })

  it('counts same-batch copies after the first accepted image as duplicates', () => {
    const held = Array.from({ length: COMPOSER_MAX_ATTACHMENTS - 6 }, (_, index) =>
      producerShapedImage(`held-${index}`, [index, 255])
    )
    const copies = Array.from({ length: 7 }, (_, index) =>
      producerShapedImage(`copy-${index}`, [201, 202])
    )
    const payload = [...held.slice(0, 3), ...copies]
    const outcome = mergeComposerImageAttachments(held, payload, () => 900)

    expect(outcome).toMatchObject({ kept: 1, duplicates: 9, dropped: 0 })
    expect(outcome.next).toHaveLength(held.length + 1)
    expect(outcome.next.at(-1)).toMatchObject({
      id: 'copy-0',
      dataBase64: copies[0]?.dataBase64,
      addedOrder: 900,
    })
  })

  it('drops only distinct image groups beyond remaining capacity', () => {
    const held = Array.from({ length: COMPOSER_MAX_ATTACHMENTS - 6 }, (_, index) =>
      producerShapedImage(`held-${index}`, [index, 255])
    )
    const distinct = Array.from({ length: 7 }, (_, index) =>
      producerShapedImage(`new-${index}`, [200, index, 255])
    )
    const outcome = mergeComposerImageAttachments(held, distinct)

    expect(outcome).toMatchObject({ kept: 6, duplicates: 0, dropped: 1 })
    expect(outcome.next).toHaveLength(COMPOSER_MAX_ATTACHMENTS)
    expect(outcome.next.map(item => item.id)).toEqual([
      ...held.map(item => item.id),
      ...distinct.slice(0, 6).map(item => item.id),
    ])
  })

  it('accounts for file attachments in shared image restoration capacity', () => {
    const occupiedByFiles = 1
    const held = Array.from(
      { length: COMPOSER_MAX_ATTACHMENTS - occupiedByFiles - 1 },
      (_, index) => producerShapedImage(`held-${index}`, [index, 255])
    )
    const first = producerShapedImage('first', [201, 202])
    const duplicate = producerShapedImage('same-content', [201, 202])
    const overflow = producerShapedImage('overflow', [203, 204])
    const incoming = [first, duplicate, overflow]
    const outcome = mergeComposerImageAttachments(held, incoming, () => 900, occupiedByFiles)

    expect(outcome).toMatchObject({ kept: 1, duplicates: 1, dropped: 1 })
    expect(outcome.next.map(imageOutputKey)).toEqual([...held, first].map(imageOutputKey))
  })

  it('keeps MIME type in image duplicate identity', () => {
    const bytes = [137, 80, 78, 71]
    const png = producerShapedImage('png-copy', bytes, 'image/png')
    const jpeg = producerShapedImage('jpeg-copy', bytes, 'image/jpeg')
    const outcome = mergeComposerImageAttachments([], [png, jpeg])

    expect(outcome).toMatchObject({ kept: 2, duplicates: 0, dropped: 0 })
    expect(outcome.next).toHaveLength(2)
  })

  it('image merge idempotence: a second identical restore changes nothing', () => {
    fc.assert(
      fc.property(
        heldImagesArbitrary,
        fc.array(helperImageArbitrary, { maxLength: 15 }),
        (existing, incoming) => {
          const first = mergeComposerImageAttachments(
            existing,
            incoming as ComposerImageAttachment[]
          )
          const second = mergeComposerImageAttachments(
            first.next,
            incoming as ComposerImageAttachment[]
          )
          const originalSet = mergeComposerImageAttachments(first.next, existing)
          // State stability: nothing new is kept, the composer is unchanged, and
          // the payload still accounts entirely to duplicates + (persistent,
          // cap-driven) drops — never to new losses.
          expect(second.kept).toBe(0)
          expect(second.next).toEqual(first.next)
          expect(second.duplicates + second.dropped).toBe(incoming.length)
          // Composability: restoring the original held set after any merge is
          // state-stable and classifies every original item as a duplicate.
          expect(originalSet.next).toEqual(first.next)
          expect(originalSet).toMatchObject({
            kept: 0,
            duplicates: existing.length,
            dropped: 0,
          })
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
