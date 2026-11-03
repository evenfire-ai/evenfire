import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type PendingExternalLogoutIntent,
  applyPendingExternalLogoutCas,
  isPendingExternalLogoutWriteFailure,
  isTransientPendingLogoutReadError,
  observePendingExternalLogoutRaw,
  pendingExternalLogoutMarkersMatch,
} from '../pendingExternalLogout.js'

const transientCodes = ['EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR']

describe('marker inspection error policy', () => {
  it.each(transientCodes)('does not classify an unproven %s as a read failure', code => {
    expect(isTransientPendingLogoutReadError(Object.assign(new Error('fixture'), { code }))).toBe(
      false
    )
  })

  it('never turns unknown, permanent, absent, or malformed errors into temporary I/O', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        expect(isTransientPendingLogoutReadError(value)).toBe(false)
      }),
      { numRuns: 20000 }
    )
    for (const code of ['ENOENT', 'EACCES', 'ELOOP', 'EINVAL', 'ENOTDIR']) {
      expect(isTransientPendingLogoutReadError({ code })).toBe(false)
    }
  })

  it('classifies an actual marker observation EIO as transient', () => {
    const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'evenfire-marker-read-eio-'))
    const envKey = 'prod-012345abcdef'
    const filePath = path.join(
      directory,
      `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
    )
    const readFailure = Object.assign(new Error('fixture marker read failure'), { code: 'EIO' })
    const originalOpen = fsSync.openSync.bind(fsSync)
    const open = vi.spyOn(fsSync, 'openSync').mockImplementation((...args) => {
      if (String(args[0]) === filePath) throw readFailure
      return Reflect.apply(originalOpen, undefined, args) as ReturnType<typeof fsSync.openSync>
    })
    try {
      expect(() => observePendingExternalLogoutRaw(directory, envKey)).toThrow(readFailure)
      expect(isTransientPendingLogoutReadError(readFailure)).toBe(true)
    } finally {
      open.mockRestore()
      fsSync.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps a pre-publication marker reread EIO transient and leaves marker bytes unchanged', () => {
    const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'evenfire-marker-reread-eio-'))
    const envKey = 'prod-012345abcdef'
    const filePath = path.join(
      directory,
      `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
    )
    const readFailure = Object.assign(new Error('fixture marker reread failure'), { code: 'EIO' })
    const originalOpen = fsSync.openSync.bind(fsSync)
    let markerReads = 0
    const open = vi.spyOn(fsSync, 'openSync').mockImplementation((...args) => {
      if (String(args[0]) === filePath && ++markerReads === 3) throw readFailure
      return Reflect.apply(originalOpen, undefined, args) as ReturnType<typeof fsSync.openSync>
    })
    try {
      expect(() =>
        applyPendingExternalLogoutCas(directory, envKey, {
          expected: null,
          next: {
            intent: { intent: 'logout-pending' },
            revision: '123e4567-e89b-42d3-a456-426614174000',
          },
        })
      ).toThrow(readFailure)

      expect(markerReads).toBe(3)
      expect(isTransientPendingLogoutReadError(readFailure)).toBe(true)
      expect(isPendingExternalLogoutWriteFailure(readFailure)).toBe(false)
      expect(observePendingExternalLogoutRaw(directory, envKey).rawContents).toBeNull()
      expect(fsSync.readdirSync(directory)).toEqual([])
    } finally {
      open.mockRestore()
      fsSync.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('treats EIO after marker rename as an uncertain mutation, not a transient read', () => {
    const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'evenfire-marker-write-eio-'))
    const envKey = 'prod-012345abcdef'
    const writeFailure = Object.assign(new Error('fixture directory sync failure'), { code: 'EIO' })
    const originalSync = fsSync.fsyncSync.bind(fsSync)
    const sync = vi.spyOn(fsSync, 'fsyncSync').mockImplementation(descriptor => {
      if (fsSync.fstatSync(descriptor).isDirectory()) throw writeFailure
      return originalSync(descriptor)
    })
    try {
      let failure: unknown
      try {
        applyPendingExternalLogoutCas(directory, envKey, {
          expected: null,
          next: {
            intent: { intent: 'logout-pending' },
            revision: '123e4567-e89b-42d3-a456-426614174000',
          },
        })
      } catch (error) {
        failure = error
      }

      expect(failure).toBe(writeFailure)
      expect(isPendingExternalLogoutWriteFailure(writeFailure)).toBe(true)
      expect(isTransientPendingLogoutReadError(writeFailure)).toBe(false)
      expect(observePendingExternalLogoutRaw(directory, envKey).marker?.intent.intent).toBe(
        'logout-pending'
      )
    } finally {
      sync.mockRestore()
      fsSync.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('shared exact marker ownership', () => {
  const intent = fc.constantFrom<PendingExternalLogoutIntent>(
    { intent: 'logout-pending' },
    { intent: 'keytar-cleanup-pending', credentialSource: 'active-keytar' },
    { intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' }
  )
  const marker = fc.record({ intent, revision: fc.option(fc.uuid(), { nil: null }) })

  it('is reflexive and symmetric without treating revisionless records as wildcards', () => {
    fc.assert(
      fc.property(marker, marker, (left, right) => {
        expect(pendingExternalLogoutMarkersMatch(left, left)).toBe(true)
        expect(pendingExternalLogoutMarkersMatch(left, right)).toBe(
          pendingExternalLogoutMarkersMatch(right, left)
        )
        const sameSource =
          left.intent.intent === 'logout-pending'
            ? right.intent.intent === 'logout-pending'
            : right.intent.intent === 'keytar-cleanup-pending' &&
              left.intent.credentialSource === right.intent.credentialSource
        expect(pendingExternalLogoutMarkersMatch(left, right)).toBe(
          sameSource && left.revision === right.revision
        )
        expect(pendingExternalLogoutMarkersMatch(null, left)).toBe(false)
        expect(
          pendingExternalLogoutMarkersMatch({ ...left, revision: `new-${left.revision}` }, left)
        ).toBe(false)
      }),
      { numRuns: 20000 }
    )
  })
})
