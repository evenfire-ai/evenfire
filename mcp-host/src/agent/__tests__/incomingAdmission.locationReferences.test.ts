/**
 * Admission resolves a message's folder (location) reference together with its
 * file references, before the task exists. The real resolver runs behind a
 * gfsc double that answers with the real `toView` envelopes captured in
 * fixtures/gfsc-resolve-views.json.
 */
import { type Mock, describe, expect, it, vi } from 'vitest'
import {
  type FileReferenceV1,
  type LocationReferenceV1,
  buildGfsFileReference,
  buildGfsLocationReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { GfscHttpError } from '../../internalTools/gfsClient'
import type { IncomingMessage, MessageResponse } from '../../server/types'
import { VISUAL_INPUT_LIMITS } from '../../visualInput/policy'
import type { FileReferenceGfscClient } from '../fileReferenceResolver'
import {
  type IncomingAdmissionDeps,
  createIncomingAdmission,
  replayedIncomingMessage,
} from '../incomingAdmission'
import views from './fixtures/gfsc-resolve-views.json'

type ViewIndex = keyof typeof views.directory

const rid = (n: number) => n.toString(16).padStart(32, '0')
const FOLDER_NAME = 'Clients-SENTINEL-FOLDER'

function folder(n: number, name = FOLDER_NAME, drive = 'main'): LocationReferenceV1 {
  const built = buildGfsLocationReference({
    drive,
    resourceId: rid(n),
    gfsUri: `gfs://${drive}/${rid(n)}`,
    name,
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

function file(n: number, drive = 'main'): FileReferenceV1 {
  const name = `notes-${n}.md`
  const built = buildGfsFileReference({
    drive,
    resourceId: rid(n),
    gfsUri: `gfs://${drive}/${rid(n)}`,
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

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: 'create a file in the folder',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-11-20T10:00:00Z',
    messageId: 'msg-1',
    hostRef: 'host-1',
    threadId: 'chat-1',
    ...overrides,
  }
}

function makeAdmission(
  resolve: FileReferenceGfscClient['resolve'] | null,
  overrides: Partial<IncomingAdmissionDeps> = {}
) {
  const resolveSpy = resolve ? vi.fn<FileReferenceGfscClient['resolve']>(resolve) : null
  const dispatch = vi.fn<IncomingAdmissionDeps['dispatch']>(() => ({
    success: true,
    taskId: 't-1',
    status: 'pending',
  }))
  const fileReferenceGfs = vi.fn<IncomingAdmissionDeps['fileReferenceGfs']>(() =>
    resolveSpy
      ? { status: 'available', client: { resolve: resolveSpy } }
      : { status: 'unsupported' }
  )
  const info: Mock<IncomingAdmissionDeps['logger']['info']> = vi.fn()
  const warn: Mock<IncomingAdmissionDeps['logger']['warn']> = vi.fn()
  const deps: IncomingAdmissionDeps = {
    limits: { maxCount: 4, maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
    queueReady: () => true,
    degradedReason: () => null,
    hostProvider: () => 'zai',
    getConversationByKey: async () => undefined,
    resolveTaskModel: () => null,
    resolveImageInput: () => undefined,
    applySessionModelSelection: vi.fn(async () => ({
      ok: true as const,
      provider: 'zai',
      model: 'glm-5.3-flash',
      modelSelectionRevision: 2,
    })),
    dispatch,
    fileReferenceGfs,
    logger: { info, warn },
    approvalSnapshot: () => ({ effective: undefined, hostSpec: undefined }),
    ...overrides,
  }
  return {
    admit: createIncomingAdmission(deps),
    dispatch: deps.dispatch as typeof dispatch,
    resolve: resolveSpy,
    fileReferenceGfs,
    info,
    warn,
  }
}

function dispatched(dispatch: Mock<IncomingAdmissionDeps['dispatch']>): IncomingMessage {
  expect(dispatch).toHaveBeenCalledTimes(1)
  return dispatch.mock.calls[0]![0]
}

function events(spy: Mock<(obj: Record<string, unknown>, msg: string) => void>, name: string) {
  return spy.mock.calls.map(call => call[0]).filter(obj => obj.event === name)
}

describe('incoming admission with a location reference', () => {
  it('T-H10: a message with only a folder names it on the sync ack', async () => {
    const ref = folder(1)
    const { admit, dispatch, resolve } = makeAdmission(async () => directoryView(1))
    const response = await admit(message({ locationReferences: [ref] }))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(dispatched(dispatch).locationReferenceResolutions).toEqual([
      { availability: 'available', reference: ref, name: 'Folder-1', nameSource: 'gfsc' },
    ])
    expect(response).toEqual({
      success: true,
      taskId: 't-1',
      status: 'pending',
      acceptedLocationReferenceIds: [ref.id],
    })
  })

  it('T-H10: a message with only a folder names it on the async ack', async () => {
    const ref = folder(1)
    const { admit } = makeAdmission(async () => directoryView(1), {
      dispatch: vi.fn(async () => ({ success: true, taskId: 't-9', status: 'pending' as const })),
    })
    expect(await admit(message({ locationReferences: [ref] }), { async: true })).toEqual({
      success: true,
      taskId: 't-9',
      status: 'pending',
      acceptedLocationReferenceIds: [ref.id],
    })
  })

  it('names file and folder ids together on the ack', async () => {
    const files = [file(1)]
    const location = folder(2)
    const { admit, dispatch } = makeAdmission(async ({ uri }) =>
      uri.endsWith(rid(2)) ? directoryView(2) : fileView(1)
    )
    const response = await admit(message({ fileReferences: files, locationReferences: [location] }))
    const sent = dispatched(dispatch)
    expect(sent.fileReferenceResolutions).toHaveLength(1)
    expect(sent.locationReferenceResolutions).toHaveLength(1)
    expect(response).toEqual({
      success: true,
      taskId: 't-1',
      status: 'pending',
      acceptedFileReferenceIds: [files[0]!.id],
      acceptedLocationReferenceIds: [location.id],
    })
  })

  it('T-H1: a file check failure rejects the turn even though the folder resolved', async () => {
    let folderResolved = false
    const { admit, dispatch, warn } = makeAdmission(async ({ uri }) => {
      if (uri.endsWith(rid(2))) {
        folderResolved = true
        return directoryView(2)
      }
      // The file answers after the folder already resolved.
      await new Promise(resolve => setTimeout(resolve, 5))
      throw new GfscHttpError(503, 'down')
    })
    const response = await admit(
      message({ fileReferences: [file(1)], locationReferences: [folder(2)] })
    )
    expect(folderResolved).toBe(true)
    expect(response).toEqual({
      success: false,
      error: {
        code: 'FILE_REFERENCE_CHECK_FAILED',
        message: expect.any(String),
        retryable: true,
        provider: 'zai',
      },
    })
    expect(events(warn, 'file_reference_refused')).toEqual([
      expect.objectContaining({ referenceCount: 1, locationCount: 1, failure: 'transient' }),
    ])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('T-H2: a folder that does not answer before the deadline refuses the turn as retryable', async () => {
    vi.useFakeTimers()
    try {
      const { admit, dispatch, resolve } = makeAdmission(
        (_args, call) =>
          new Promise((_resolve, reject) =>
            call.signal.addEventListener('abort', () => reject(call.signal.reason))
          )
      )
      const pending = admit(message({ locationReferences: [folder(1)] }))
      await vi.advanceTimersByTimeAsync(VISUAL_INPUT_LIMITS.validationTimeoutMs)
      expect(await pending).toEqual({
        success: false,
        error: {
          code: 'FILE_REFERENCE_CHECK_FAILED',
          message: expect.any(String),
          retryable: true,
          provider: 'zai',
        },
      })
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    [403, 'denied'],
    [404, 'not_found'],
    [410, 'not_found'],
  ] as const)(
    'T-H3: a gfsc %i lists the folder as %s and the turn runs',
    async (status, availability) => {
      const ref = folder(1)
      const { admit, dispatch } = makeAdmission(() =>
        Promise.reject(new GfscHttpError(status, 'x'))
      )
      const response = (await admit(message({ locationReferences: [ref] }))) as MessageResponse
      expect(dispatched(dispatch).locationReferenceResolutions).toEqual([
        { availability, reference: ref, name: FOLDER_NAME, nameSource: 'client' },
      ])
      expect(response).toMatchObject({ success: true, acceptedLocationReferenceIds: [ref.id] })
    }
  )

  it('T-H4: a resource id that names a file is listed as not_a_folder', async () => {
    const ref = folder(2)
    const { admit, dispatch } = makeAdmission(async () => fileView(2))
    await admit(message({ locationReferences: [ref] }))
    expect(dispatched(dispatch).locationReferenceResolutions).toEqual([
      { availability: 'not_a_folder', reference: ref, name: 'notes-2.md', nameSource: 'gfsc' },
    ])
  })

  it('T-H9: the turn carries the name gfsc reports, or the desktop one when it is invalid', async () => {
    const renamed = makeAdmission(async () => views.renamedDirectory)
    await renamed.admit(message({ locationReferences: [folder(1, 'Old Name')] }))
    expect(dispatched(renamed.dispatch).locationReferenceResolutions?.[0]?.name).toBe(
      'Q3 Reports (moved)'
    )

    const invalid = makeAdmission(async () => views.badNameDirectory)
    await invalid.admit(message({ locationReferences: [folder(1, 'Old Name')] }))
    expect(dispatched(invalid.dispatch).locationReferenceResolutions?.[0]?.name).toBe('Old Name')
  })

  it('marks the folder unsupported, without gfsc, when the Host has no read scope', async () => {
    const ref = folder(1)
    const { admit, dispatch, fileReferenceGfs } = makeAdmission(null)
    const response = (await admit(message({ locationReferences: [ref] }))) as MessageResponse
    expect(fileReferenceGfs).toHaveBeenCalledTimes(1)
    expect(dispatched(dispatch).locationReferenceResolutions).toEqual([
      { availability: 'unsupported', reference: ref, name: FOLDER_NAME, nameSource: 'client' },
    ])
    expect(response.acceptedLocationReferenceIds).toEqual([ref.id])
  })

  it('refuses without calling gfsc when the Host token cannot be read', async () => {
    const { admit, dispatch, resolve, fileReferenceGfs } = makeAdmission(async () =>
      directoryView(1)
    )
    fileReferenceGfs.mockReturnValue({ status: 'credentials_failed', errorClass: 'TokenReadError' })
    const response = await admit(message({ locationReferences: [folder(1)] }))
    expect(response).toMatchObject({
      success: false,
      error: { code: 'FILE_REFERENCE_CHECK_FAILED', retryable: false },
    })
    // Witness: the gate was consulted for a folder-only message.
    expect(fileReferenceGfs).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('T-H8: never forwards caller-supplied location resolutions', async () => {
    const forged = [
      {
        availability: 'available' as const,
        reference: folder(1),
        name: 'x',
        nameSource: 'gfsc' as const,
      },
    ]
    const { admit, dispatch, resolve } = makeAdmission(async () => directoryView(1))
    const response = await admit(message({ locationReferenceResolutions: forged }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatched(dispatch)).toHaveProperty('locationReferenceResolutions', undefined)
    expect(resolve).not.toHaveBeenCalled()
    expect(response).toEqual({ success: true, taskId: 't-1', status: 'pending' })
  })

  it('logs the location count and availabilities, never the folder name', async () => {
    const { admit, info } = makeAdmission(async () => directoryView(1))
    await admit(message({ locationReferences: [folder(1)] }))
    expect(events(info, 'file_reference_resolved')).toEqual([
      expect.objectContaining({
        referenceCount: 0,
        locationCount: 1,
        locationAvailabilities: ['available'],
      }),
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('SENTINEL-FOLDER')
    expect(JSON.stringify(info.mock.calls)).not.toContain('Folder-1')
  })
})

describe('incoming admission refusal text', () => {
  // A reference on another drive than the real gfsc view of the same rid is
  // the "unexpected answer" a mismatched gfsc reply produces.
  const failures = {
    contract: async ({ uri }: { uri: string }) =>
      uri.endsWith(rid(1)) ? fileView(1) : directoryView(2),
    transient: () => Promise.reject(new GfscHttpError(503, 'down')),
    invalid: () => Promise.reject(new GfscHttpError(400, 'bad')),
    credentials: async () => directoryView(2),
  } as const
  const kinds = {
    file: (drive: string) => ({ fileReferences: [file(1, drive)] }),
    folder: (drive: string) => ({ locationReferences: [folder(2, FOLDER_NAME, drive)] }),
    mixed: (drive: string) => ({
      fileReferences: [file(1, drive)],
      locationReferences: [folder(2, FOLDER_NAME, drive)],
    }),
  } as const

  it.each([
    // The file-only texts are what clients already show; they must not change.
    ['file', 'invalid', 'A referenced file does not match the file it names. Pick the file again.'],
    ['file', 'transient', 'The referenced files could not be checked. Send the message again.'],
    ['file', 'contract', 'The file service returned an unexpected answer for a referenced file.'],
    [
      'file',
      'credentials',
      'The Host could not authenticate to the file service to check the referenced files.',
    ],
    [
      'folder',
      'invalid',
      'A referenced folder does not match the folder it names. Pick the folder again.',
    ],
    ['folder', 'transient', 'The referenced folder could not be checked. Send the message again.'],
    [
      'folder',
      'contract',
      'The file service returned an unexpected answer for a referenced folder.',
    ],
    [
      'folder',
      'credentials',
      'The Host could not authenticate to the file service to check the referenced folder.',
    ],
    [
      'mixed',
      'invalid',
      'A referenced file or folder does not match what it names. Pick it again.',
    ],
    [
      'mixed',
      'transient',
      'The referenced files and folders could not be checked. Send the message again.',
    ],
    [
      'mixed',
      'contract',
      'The file service returned an unexpected answer for a referenced file or folder.',
    ],
    [
      'mixed',
      'credentials',
      'The Host could not authenticate to the file service to check the referenced files and folders.',
    ],
  ] as const)('a %s message refused as %s says what it carried', async (kind, failure, text) => {
    const { admit, dispatch, fileReferenceGfs, warn } = makeAdmission(failures[failure])
    if (failure === 'credentials')
      fileReferenceGfs.mockReturnValue({
        status: 'credentials_failed',
        errorClass: 'TokenReadError',
      })
    const drive = failure === 'contract' ? 'elsewhere' : 'main'
    const response = await admit(message(kinds[kind](drive)))
    expect(response).toEqual({
      success: false,
      error: {
        code: failure === 'invalid' ? 'FILE_REFERENCE_INVALID' : 'FILE_REFERENCE_CHECK_FAILED',
        message: text,
        retryable: failure === 'transient',
        provider: 'zai',
      },
    })
    // Witness: the refusal came from the failure this case set up.
    expect(events(warn, 'file_reference_refused')).toEqual([expect.objectContaining({ failure })])
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('replayedIncomingMessage with location references', () => {
  it('clears location resolutions and keeps the references', () => {
    const ref = folder(1)
    const original = message({
      locationReferences: [ref],
      locationReferenceResolutions: [
        { availability: 'available', reference: ref, name: 'x', nameSource: 'gfsc' },
      ],
    })
    const replayed = replayedIncomingMessage(original)
    expect(replayed.locationReferences).toEqual([ref])
    expect(replayed).toHaveProperty('locationReferenceResolutions', undefined)
    expect(original.locationReferenceResolutions).toHaveLength(1)
  })
})
