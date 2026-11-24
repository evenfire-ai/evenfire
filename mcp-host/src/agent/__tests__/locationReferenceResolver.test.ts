/**
 * Location references: route-level parsing and joint resolution with file
 * references under one deadline. Every gfsc body is the real `toView` envelope
 * captured in fixtures/gfsc-resolve-views.json.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type FileReferenceV1,
  type LocationReferenceV1,
  buildGfsFileReference,
  buildGfsLocationReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { GfscHttpError } from '../../internalTools/gfsClient'
import { VISUAL_INPUT_LIMITS } from '../../visualInput/policy'
import {
  type FileReferenceGfscClient,
  parseIncomingLocationReferences,
  resolveMessageReferences,
} from '../fileReferenceResolver'
import views from './fixtures/gfsc-resolve-views.json'

type ViewIndex = keyof typeof views.directory

const rid = (n: number) => n.toString(16).padStart(32, '0')

function folder(n: number, name = `Folder-${n}`): LocationReferenceV1 {
  const built = buildGfsLocationReference({
    drive: 'main',
    resourceId: rid(n),
    gfsUri: `gfs://main/${rid(n)}`,
    name,
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

function file(n: number): FileReferenceV1 {
  const name = `notes-${n}.md`
  const built = buildGfsFileReference({
    drive: 'main',
    resourceId: rid(n),
    gfsUri: `gfs://main/${rid(n)}`,
    version: 3,
    name,
    declaredMediaType: 'text/markdown',
    byteLength: 120,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: 120,
      declaredMediaType: 'text/markdown',
      filename: name,
    }),
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

const directoryView = (n: number) => views.directory[String(n) as ViewIndex]
const fileView = (n: number) => views.file[String(n) as ViewIndex]

function client(answer: (uri: string) => unknown | Promise<unknown>) {
  const resolve = vi.fn<FileReferenceGfscClient['resolve']>(async ({ uri }) => answer(uri))
  return { resolve } satisfies FileReferenceGfscClient
}

describe('parseIncomingLocationReferences', () => {
  it('treats an absent field as a message without locations', () => {
    expect(parseIncomingLocationReferences(undefined, 1)).toEqual({ ok: true, references: [] })
  })

  it('returns the parsed reference', () => {
    const ref = folder(1)
    expect(parseIncomingLocationReferences([ref], 1)).toEqual({ ok: true, references: [ref] })
  })

  it.each([null, {}, 'gfs://main/x', 3])('rejects a non-list value %j', value => {
    expect(parseIncomingLocationReferences(value, 1)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
    })
  })

  it('rejects more locations than the limit', () => {
    expect(parseIncomingLocationReferences([folder(1)], 1)).toMatchObject({ ok: true })
    expect(parseIncomingLocationReferences([folder(1), folder(2)], 1)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
    })
  })

  it('rejects the same folder twice, dashed or not', () => {
    const plain = folder(1)
    const dashed = buildGfsLocationReference({
      drive: 'main',
      resourceId: '00000000-0000-0000-0000-000000000001',
      gfsUri: `gfs://main/${rid(1)}`,
      name: 'Folder-1',
    })
    if (!dashed.ok) throw new Error(dashed.message)
    // Witness: two different folders fit a limit of two.
    expect(parseIncomingLocationReferences([plain, folder(2)], 2)).toMatchObject({ ok: true })
    expect(dashed.value.id).not.toBe(plain.id)
    expect(parseIncomingLocationReferences([plain, dashed.value], 2)).toEqual({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
      message: 'Each location reference must appear once.',
    })
  })

  it('keeps the schema-version code from the parser', () => {
    expect(parseIncomingLocationReferences([{ ...folder(1), schemaVersion: 2 }], 1)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED',
    })
  })

  it('rejects a file reference sent as a location', () => {
    expect(parseIncomingLocationReferences([file(1)], 1)).toMatchObject({
      ok: false,
      code: 'FILE_REFERENCE_INVALID',
    })
  })
})

describe('parseIncomingLocationReferences — package golden vectors', () => {
  // The contract's own vectors, read from the linked package, so the Host
  // and Desktop parse exactly the inputs the package pins.
  const { vectors } = JSON.parse(
    readFileSync(
      join(
        dirname(require.resolve('@clerum/gfs-interaction-policy')),
        'fixtures',
        'location-reference-vectors.v1.json'
      ),
      'utf8'
    )
  ) as {
    vectors: Array<{ name: string; input: unknown; expected: { ok: boolean; code?: string } }>
  }

  it('loads accepted and refused vectors', () => {
    expect(vectors.filter(v => v.expected.ok).length).toBeGreaterThan(0)
    expect(vectors.filter(v => !v.expected.ok).length).toBeGreaterThan(0)
  })

  it.each(vectors.map(v => [v.name, v] as const))('%s', (_name, vector) => {
    const parsed = parseIncomingLocationReferences([vector.input], 1)
    if (vector.expected.ok) {
      expect(parsed).toEqual({ ok: true, references: [vector.input] })
    } else {
      expect(parsed).toEqual({
        ok: false,
        code: vector.expected.code,
        message: expect.any(String),
      })
    }
  })
})

describe('resolveMessageReferences — locations', () => {
  it('reports a directory as available, with the name gfsc reports', async () => {
    const ref = folder(1)
    const gfsc = client(() => directoryView(1))
    expect(await resolveMessageReferences([], [ref], gfsc)).toEqual({
      ok: true,
      resolutions: [],
      locationResolutions: [
        { availability: 'available', reference: ref, name: 'Folder-1', nameSource: 'gfsc' },
      ],
    })
    expect(gfsc.resolve).toHaveBeenCalledTimes(1)
    expect(gfsc.resolve.mock.calls[0]![0]).toEqual({ uri: ref.source.gfsUri })
  })

  it.each([
    [403, 'denied'],
    [404, 'not_found'],
    [410, 'not_found'],
  ] as const)(
    'T-H3: maps gfsc %i to %s and keeps the desktop name',
    async (status, availability) => {
      const ref = folder(1, 'My Folder')
      const gfsc = client(() => Promise.reject(new GfscHttpError(status, 'x')))
      expect(await resolveMessageReferences([], [ref], gfsc)).toEqual({
        ok: true,
        resolutions: [],
        locationResolutions: [
          { availability, reference: ref, name: 'My Folder', nameSource: 'client' },
        ],
      })
    }
  )

  it('T-H4: reports a resource id that names a file as not_a_folder', async () => {
    const ref = folder(2)
    const result = await resolveMessageReferences(
      [],
      [ref],
      client(() => fileView(2))
    )
    expect(result).toMatchObject({
      ok: true,
      locationResolutions: [{ availability: 'not_a_folder', reference: ref }],
    })
  })

  it('T-H9: shows the name gfsc reports after a rename or move', async () => {
    const ref = folder(1, 'Old Name')
    const result = await resolveMessageReferences(
      [],
      [ref],
      client(() => views.renamedDirectory)
    )
    expect(result).toMatchObject({
      ok: true,
      locationResolutions: [
        {
          availability: 'available',
          reference: ref,
          name: 'Q3 Reports (moved)',
          nameSource: 'gfsc',
        },
      ],
    })
  })

  it('T-H9: falls back to the desktop name when the gfsc name breaks the name rules', async () => {
    const ref = folder(1, 'Old Name')
    const result = await resolveMessageReferences(
      [],
      [ref],
      client(() => views.badNameDirectory)
    )
    expect(result).toMatchObject({
      ok: true,
      locationResolutions: [
        { availability: 'available', reference: ref, name: 'Old Name', nameSource: 'client' },
      ],
    })
  })

  it('marks a location unsupported without gfsc when the Host has no client', async () => {
    const ref = folder(1)
    expect(await resolveMessageReferences([], [ref], null)).toEqual({
      ok: true,
      resolutions: [],
      locationResolutions: [
        { availability: 'unsupported', reference: ref, name: 'Folder-1', nameSource: 'client' },
      ],
    })
  })

  it.each([
    [
      'a gfsc 400',
      () => Promise.reject(new GfscHttpError(400, 'path_invalid')),
      {
        failure: 'invalid',
        errorClass: 'GfscHttpError',
        status: 400,
      },
    ],
    [
      'a gfsc 503',
      () => Promise.reject(new GfscHttpError(503, 'down')),
      {
        failure: 'transient',
        errorClass: 'GfscHttpError',
        status: 503,
      },
    ],
    [
      'a gfsc 401',
      () => Promise.reject(new GfscHttpError(401, 'unauthorized')),
      {
        failure: 'credentials',
        errorClass: 'GfscHttpError',
        status: 401,
      },
    ],
    [
      'a network failure',
      () => Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') })),
      {
        failure: 'transient',
        errorClass: 'TypeError',
      },
    ],
    [
      'metadata about another folder',
      () => directoryView(2),
      {
        failure: 'contract',
        errorClass: 'UnexpectedMetadata',
      },
    ],
  ])('fails the check on %s', async (_label, answer, expected) => {
    const result = await resolveMessageReferences([], [folder(1)], client(answer))
    expect(result).toEqual({ ok: false, ...expected })
  })

  // Leniency for a shape gfsc does not send today: every toView body carries
  // version and bytes, but a folder's identity never depends on them.
  it('accepts a directory body without version or bytes (leniency, not a gfsc shape)', async () => {
    const ref = folder(1)
    const { version: _v, bytes: _b, ...data } = directoryView(1).data
    const result = await resolveMessageReferences(
      [],
      [ref],
      client(() => ({ ok: true, data }))
    )
    expect(result).toMatchObject({
      ok: true,
      locationResolutions: [{ availability: 'available', reference: ref }],
    })
  })
})

describe('resolveMessageReferences — files and locations together', () => {
  it('resolves both lists, each in its own order, one resolve per reference', async () => {
    const files = [file(1), file(2)]
    const location = folder(3)
    const gfsc = client(uri =>
      uri.endsWith(rid(3)) ? directoryView(3) : uri.endsWith(rid(1)) ? fileView(1) : fileView(2)
    )
    const result = await resolveMessageReferences(files, [location], gfsc)
    expect(result).toMatchObject({
      ok: true,
      resolutions: [
        { availability: 'available', reference: files[0] },
        { availability: 'available', reference: files[1] },
      ],
      locationResolutions: [{ availability: 'available', reference: location }],
    })
    expect(gfsc.resolve.mock.calls.map(call => call[0].uri).sort()).toEqual(
      [rid(1), rid(2), rid(3)].map(r => `gfs://main/${r}`)
    )
  })

  it('T-H1: a file check failure after the location resolved rejects the whole message', async () => {
    let locationResolved = false
    let release!: () => void
    const fileGate = new Promise<void>(resolve => {
      release = resolve
    })
    const gfsc: FileReferenceGfscClient = {
      resolve: vi.fn(async ({ uri }) => {
        if (uri.endsWith(rid(3))) {
          locationResolved = true
          release()
          return directoryView(3)
        }
        await fileGate
        throw new GfscHttpError(503, 'down')
      }),
    }
    const result = await resolveMessageReferences([file(1)], [folder(3)], gfsc)
    // Witness: the location had already resolved when the file failed.
    expect(locationResolved).toBe(true)
    expect(result).toEqual({
      ok: false,
      failure: 'transient',
      errorClass: 'GfscHttpError',
      status: 503,
    })
  })

  it('shares one signal between file and location calls and aborts it on failure', async () => {
    const signals: AbortSignal[] = []
    const gfsc: FileReferenceGfscClient = {
      resolve: vi.fn(({ uri }, call) => {
        signals.push(call.signal)
        if (uri.endsWith(rid(1))) return Promise.reject(new GfscHttpError(503, 'down'))
        return new Promise((_resolve, reject) =>
          call.signal.addEventListener('abort', () => reject(call.signal.reason))
        )
      }),
    }
    const result = await resolveMessageReferences([file(1)], [folder(2)], gfsc)
    expect(result).toMatchObject({ ok: false, failure: 'transient', status: 503 })
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBe(signals[1])
    expect(signals[0]!.aborted).toBe(true)
  })

  it('T-H2: fails transient when a location does not answer before the deadline', async () => {
    vi.useFakeTimers()
    try {
      const gfsc: FileReferenceGfscClient = {
        resolve: vi.fn(
          (_args, call) =>
            new Promise((_resolve, reject) =>
              call.signal.addEventListener('abort', () => reject(call.signal.reason))
            )
        ),
      }
      const pending = resolveMessageReferences([], [folder(1)], gfsc)
      await vi.advanceTimersByTimeAsync(VISUAL_INPUT_LIMITS.validationTimeoutMs)
      expect(await pending).toEqual({ ok: false, failure: 'transient', errorClass: 'AbortError' })
    } finally {
      vi.useRealTimers()
    }
  })
})
