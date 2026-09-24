/**
 * #666 — route-level parsing and gfsc resolution of structured file references.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type FileReferenceV1,
  buildAttachmentFileReference,
  buildGfsFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { GfscHttpError } from '../../internalTools/gfsClient'
import { VISUAL_INPUT_LIMITS } from '../../visualInput/policy'
import {
  FILE_REFERENCE_AVAILABILITY_CODES,
  type FileReferenceGfscClient,
  parseIncomingFileReferences,
  referencedFilesForTurnContext,
  resolveFileReferences,
} from '../fileReferenceResolver'

const RID = '1234567890abcdef1234567890abcdef'
const RID_2 = 'abcdefabcdefabcdefabcdefabcdefab'

function gfsReference(
  overrides: { resourceId?: string; version?: number; byteLength?: number; drive?: string } = {}
): FileReferenceV1 {
  const resourceId = overrides.resourceId ?? RID
  const drive = overrides.drive ?? 'main'
  const byteLength = overrides.byteLength ?? 120
  const built = buildGfsFileReference({
    drive,
    resourceId,
    gfsUri: `gfs://${drive}/${resourceId.replace(/-/g, '').toLowerCase()}`,
    version: overrides.version ?? 3,
    name: 'notes.md',
    declaredMediaType: 'text/markdown',
    byteLength,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: byteLength,
      declaredMediaType: 'text/markdown',
      filename: 'notes.md',
    }),
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

function attachmentReference(): FileReferenceV1 {
  const bytes = new TextEncoder().encode('hello')
  const built = buildAttachmentFileReference({
    attachmentId: 'a1',
    messageId: 'm1',
    name: 'hello.txt',
    declaredMediaType: 'text/plain',
    byteLength: bytes.length,
    digestHex: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    classification: classifyBytes({
      bytes,
      totalByteLength: bytes.length,
      declaredMediaType: 'text/plain',
      filename: 'hello.txt',
    }),
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

function view(fields: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      resourceId: RID,
      rid: RID,
      drive: 'main',
      gfsUri: `gfs://main/${RID}`,
      kind: 'file',
      name: 'notes.md',
      version: 3,
      bytes: 120,
      ...fields,
    },
  }
}

function client(answer: (uri: string) => unknown | Promise<unknown>) {
  const resolve = vi.fn<FileReferenceGfscClient['resolve']>(async ({ uri }) => answer(uri))
  return { resolve } satisfies FileReferenceGfscClient
}

describe('parseIncomingFileReferences (#666)', () => {
  it('treats an absent field as a message without references', () => {
    expect(parseIncomingFileReferences(undefined, 10)).toEqual({ ok: true, references: [] })
  })

  it('returns the parsed references in order', () => {
    const first = gfsReference()
    const second = gfsReference({ resourceId: RID_2 })
    const parsed = parseIncomingFileReferences([first, second], 10)
    expect(parsed).toEqual({ ok: true, references: [first, second] })
  })

  it.each([null, {}, 'gfs://main/x', 3])('rejects a non-list value %j', value => {
    expect(parseIncomingFileReferences(value, 10)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
    })
  })

  it('rejects more references than the limit, and accepts exactly the limit', () => {
    const refs = [gfsReference(), gfsReference({ resourceId: RID_2 })]
    expect(parseIncomingFileReferences(refs, 2)).toMatchObject({ ok: true })
    expect(parseIncomingFileReferences(refs, 1)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
    })
  })

  it('keeps the schema-version code from the parser', () => {
    const ref = { ...gfsReference(), schemaVersion: 2 }
    expect(parseIncomingFileReferences([ref], 10)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED',
    })
  })

  it('rejects a reference whose id does not match its source', () => {
    const ref = { ...gfsReference(), id: `gfs:main:${RID}@v9` }
    expect(parseIncomingFileReferences([ref], 10)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
    })
  })

  it('rejects the same reference twice', () => {
    const ref = gfsReference()
    expect(parseIncomingFileReferences([ref, ref], 10)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
      message: 'Each file reference must appear once.',
    })
  })

  it.each([
    ['another drive', `gfs://other/${RID}`],
    ['another resource', `gfs://main/${RID_2}`],
  ])('rejects a gfsUri that names %s', (_label, gfsUri) => {
    const ref = gfsReference()
    const tampered = { ...ref, source: { ...ref.source, gfsUri } }
    expect(parseIncomingFileReferences([tampered], 10)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
      message: 'The gfsUri of a file reference must name its drive and resourceId.',
    })
  })

  it('accepts a dashed resourceId whose gfsUri carries the normalized rid', () => {
    const dashed = '12345678-90ab-cdef-1234-567890abcdef'
    expect(parseIncomingFileReferences([gfsReference({ resourceId: dashed })], 10)).toMatchObject({
      ok: true,
    })
  })
})

describe('resolveFileReferences (#666)', () => {
  it('reports available when gfsc returns the same file at the same version', async () => {
    const gfsc = client(() => view())
    const ref = gfsReference()
    const result = await resolveFileReferences([ref], gfsc)
    expect(result).toEqual({
      ok: true,
      resolutions: [{ availability: 'available', reference: ref }],
    })
    expect(gfsc.resolve).toHaveBeenCalledTimes(1)
    expect(gfsc.resolve.mock.calls[0]![0]).toEqual({ uri: `gfs://main/${RID}` })
    expect(gfsc.resolve.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
  })

  it('reports stale with the current version when the file changed', async () => {
    const gfsc = client(() => view({ version: 4, bytes: 999 }))
    const result = await resolveFileReferences([gfsReference()], gfsc)
    expect(result).toMatchObject({
      ok: true,
      resolutions: [{ availability: 'stale', resolvedVersion: 4 }],
    })
  })

  it('reports not_a_file for a directory', async () => {
    const gfsc = client(() => view({ kind: 'directory', bytes: 0 }))
    const result = await resolveFileReferences([gfsReference()], gfsc)
    expect(result).toMatchObject({ ok: true, resolutions: [{ availability: 'not_a_file' }] })
  })

  it('reports too_large above the per-file ceiling, and available at it', async () => {
    const limit = VISUAL_INPUT_LIMITS.fileBytes
    const atLimit = await resolveFileReferences(
      [gfsReference({ byteLength: limit })],
      client(() => view({ bytes: limit }))
    )
    expect(atLimit).toMatchObject({ ok: true, resolutions: [{ availability: 'available' }] })
    const above = await resolveFileReferences(
      [gfsReference({ byteLength: limit + 1 })],
      client(() => view({ bytes: limit + 1 }))
    )
    expect(above).toMatchObject({ ok: true, resolutions: [{ availability: 'too_large' }] })
  })

  it.each([
    [403, 'denied'],
    [404, 'not_found'],
    [410, 'not_found'],
  ])('maps gfsc %i to %s', async (status, availability) => {
    const gfsc = client(() => {
      throw new GfscHttpError(status, 'no')
    })
    const result = await resolveFileReferences([gfsReference()], gfsc)
    expect(gfsc.resolve).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, resolutions: [{ availability }] })
  })

  it('marks every reference unsupported without calling gfsc when the Host has no read scope', async () => {
    const refs = [gfsReference(), gfsReference({ resourceId: RID_2 })]
    const result = await resolveFileReferences(refs, null)
    expect(result).toEqual({
      ok: true,
      resolutions: refs.map(reference => ({ availability: 'unsupported', reference })),
    })
  })

  it('marks an attachment-sourced reference unsupported and still resolves the GFS one', async () => {
    const gfsc = client(() => view())
    const result = await resolveFileReferences([attachmentReference(), gfsReference()], gfsc)
    expect(result).toMatchObject({
      ok: true,
      resolutions: [{ availability: 'unsupported' }, { availability: 'available' }],
    })
    // Witness: only the GFS reference reached gfsc.
    expect(gfsc.resolve).toHaveBeenCalledTimes(1)
  })

  it.each([429, 500, 502, 503, 401])('fails transient on gfsc %i', async status => {
    const gfsc = client(() => {
      throw new GfscHttpError(status, 'busy')
    })
    expect(await resolveFileReferences([gfsReference()], gfsc)).toEqual({
      ok: false,
      failure: 'transient',
    })
    expect(gfsc.resolve).toHaveBeenCalledTimes(1)
  })

  it('fails transient on a network error', async () => {
    const gfsc = client(() => {
      throw new TypeError('fetch failed')
    })
    expect(await resolveFileReferences([gfsReference()], gfsc)).toEqual({
      ok: false,
      failure: 'transient',
    })
  })

  it('fails invalid on a gfsc 400', async () => {
    const gfsc = client(() => {
      throw new GfscHttpError(400, 'path_invalid')
    })
    expect(await resolveFileReferences([gfsReference()], gfsc)).toEqual({
      ok: false,
      failure: 'invalid',
    })
  })

  it('fails invalid when the same version reports a different size', async () => {
    const gfsc = client(() => view({ bytes: 121 }))
    expect(await resolveFileReferences([gfsReference()], gfsc)).toEqual({
      ok: false,
      failure: 'invalid',
    })
    expect(gfsc.resolve).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a non-ok envelope', { ok: false }],
    ['a text body', 'not json'],
    ['another drive', view({ drive: 'other' })],
    ['another resource', view({ resourceId: RID_2, rid: RID_2, gfsUri: `gfs://main/${RID_2}` })],
    ['another gfsUri', view({ gfsUri: `gfs://main/${RID_2}` })],
    ['an unknown kind', view({ kind: 'link' })],
    ['a fractional version', view({ version: 3.5 })],
    ['a negative size', view({ bytes: -1 })],
  ])('fails contract on %s', async (_label, body) => {
    const gfsc = client(() => body)
    expect(await resolveFileReferences([gfsReference()], gfsc)).toEqual({
      ok: false,
      failure: 'contract',
    })
    expect(gfsc.resolve).toHaveBeenCalledTimes(1)
  })

  it('resolves in parallel and aborts the calls still in flight on the first failure', async () => {
    const signals: AbortSignal[] = []
    let started = 0
    const gfsc: FileReferenceGfscClient = {
      resolve: vi.fn(({ uri }, call) => {
        started += 1
        signals.push(call.signal)
        if (uri.endsWith(RID_2)) return Promise.reject(new GfscHttpError(503, 'down'))
        return new Promise((_resolve, reject) =>
          call.signal.addEventListener('abort', () => reject(new Error('aborted')))
        )
      }),
    }
    const result = await resolveFileReferences(
      [gfsReference(), gfsReference({ resourceId: RID_2 })],
      gfsc
    )
    expect(result).toEqual({ ok: false, failure: 'transient' })
    // Witness: both calls started before either finished (one shared signal).
    expect(started).toBe(2)
    expect(signals[0]).toBe(signals[1])
    expect(signals[0]!.aborted).toBe(true)
  })

  it('fails transient when gfsc does not answer before the deadline', async () => {
    vi.useFakeTimers()
    try {
      let deadlineMs = 0
      const gfsc: FileReferenceGfscClient = {
        resolve: vi.fn((_args, call) => {
          deadlineMs = call.deadlineMs
          return new Promise((_resolve, reject) =>
            call.signal.addEventListener('abort', () => reject(new Error('aborted')))
          )
        }),
      }
      const startedAt = Date.now()
      const pending = resolveFileReferences([gfsReference()], gfsc)
      expect(deadlineMs).toBe(startedAt + VISUAL_INPUT_LIMITS.validationTimeoutMs)
      await vi.advanceTimersByTimeAsync(VISUAL_INPUT_LIMITS.validationTimeoutMs - 1)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toEqual({ ok: false, failure: 'transient' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('names a code for every unavailable availability', () => {
    expect(FILE_REFERENCE_AVAILABILITY_CODES).toEqual({
      not_found: 'FILE_REFERENCE_NOT_FOUND',
      denied: 'FILE_REFERENCE_DENIED',
      stale: 'FILE_REFERENCE_STALE',
      not_a_file: 'FILE_REFERENCE_NOT_A_FILE',
      too_large: 'FILE_REFERENCE_TOO_LARGE',
      unsupported: 'FILE_REFERENCE_UNSUPPORTED',
    })
  })
})

describe('referencedFilesForTurnContext (#666)', () => {
  it('maps each resolution in order, with its code and the current version', () => {
    const available = gfsReference()
    const stale = gfsReference({ resourceId: RID_2, version: 1 })
    const attachment = attachmentReference()
    expect(
      referencedFilesForTurnContext([
        { availability: 'available', reference: available },
        { availability: 'stale', reference: stale, resolvedVersion: 4 },
        { availability: 'unsupported', reference: attachment },
      ])
    ).toEqual([
      {
        referenceId: available.id,
        name: 'notes.md',
        class: 'markdown',
        byteLength: 120,
        sourceKind: 'gfs',
        gfs: { drive: 'main', resourceId: RID, version: 3 },
        availability: 'available',
      },
      {
        referenceId: stale.id,
        name: 'notes.md',
        class: 'markdown',
        byteLength: 120,
        sourceKind: 'gfs',
        gfs: { drive: 'main', resourceId: RID_2, version: 1 },
        availability: 'stale',
        code: 'FILE_REFERENCE_STALE',
        currentVersion: 4,
      },
      {
        referenceId: attachment.id,
        name: 'hello.txt',
        class: attachment.class,
        byteLength: 5,
        sourceKind: 'attachment',
        availability: 'unsupported',
        code: 'FILE_REFERENCE_UNSUPPORTED',
      },
    ])
  })

  it('lists nothing for a message without resolutions', () => {
    // Witness: the same function lists a resolution when one is present.
    expect(
      referencedFilesForTurnContext([{ availability: 'denied', reference: gfsReference() }])
    ).toEqual([expect.objectContaining({ availability: 'denied', code: 'FILE_REFERENCE_DENIED' })])
    expect(referencedFilesForTurnContext(undefined)).toEqual([])
    expect(referencedFilesForTurnContext([])).toEqual([])
  })
})
