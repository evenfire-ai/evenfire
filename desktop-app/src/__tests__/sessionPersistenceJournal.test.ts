import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionPersistenceCandidateDeniedError,
  type SessionPersistenceJournal,
  SessionPersistenceJournalAdmissionError,
  SessionPersistenceProducer,
  isSessionPersistenceCandidateDenied,
  isSessionPersistenceJournalReadFailure,
  readSessionPersistenceJournal,
  sessionPersistenceCandidateHash,
  sessionPersistenceMarkerHash,
} from '../sessionPersistenceJournal.js'

const envKey = 'fixture-0123456789ab'
let directory: string
const journalPath = () =>
  path.join(
    directory,
    `session-persistence-journal-${createHash('sha256').update(envKey).digest('hex')}`
  )
const producer = (fresh = true, report = vi.fn()) =>
  new SessionPersistenceProducer(directory, envKey, null, () => {}, report, fresh)

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-journal-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('write-ahead denial journal', () => {
  it('stores only denial metadata and unions native/encrypted attempts idempotently', () => {
    const owner = producer()
    const secret = 'fixture-private-candidate-not-persisted'
    owner.prepare('keytar', secret)
    owner.prepare('safe-storage', secret)
    owner.prepare('keytar', secret)
    const journal = readSessionPersistenceJournal(directory, envKey)!
    expect(journal.pending).toHaveLength(1)
    expect(journal.pending[0].sources).toEqual(['keytar', 'safe-storage'])
    expect(fs.readFileSync(journalPath(), 'utf8')).not.toContain(secret)
    if (process.platform !== 'win32') expect(fs.statSync(journalPath()).mode & 0o077).toBe(0)
    expect(isSessionPersistenceCandidateDenied(journal, secret)).toBe(true)
  })

  it('preserves a newer independent candidate while the accepted older owner retires', () => {
    const older = producer()
    const newer = producer()
    older.prepare('keytar', 'fixture-old')
    newer.prepare('safe-storage', 'fixture-new')
    older.assertMayAuthenticate('fixture-old')
    expect(older.accept('fixture-old')).toBe(true)
    const journal = readSessionPersistenceJournal(directory, envKey)!
    expect(journal.pending.map(entry => entry.producer)).toEqual([newer.producer])
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-new')).toBe(true)
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-old')).toBe(false)
  })

  it('requires fresh authentication before retiring an older matching candidate', () => {
    producer().prepare('keytar', 'fixture-unaccepted')
    const restore = producer(false)
    expect(() => restore.prepare('safe-storage', 'fixture-unaccepted')).toThrow(
      SessionPersistenceCandidateDeniedError
    )
    const fresh = producer()
    fresh.prepare('safe-storage', 'fixture-unaccepted')
    fresh.assertMayAuthenticate('fixture-unaccepted')
    expect(fresh.accept('fixture-unaccepted')).toBe(true)
    expect(readSessionPersistenceJournal(directory, envKey)).toBeNull()
  })

  it('exempts only its own new automatic migration entry while validating authentication', () => {
    const restore = producer(false)
    restore.prepare('keytar', 'fixture-migrated')
    restore.assertMayAuthenticate('fixture-migrated')
    expect(
      isSessionPersistenceCandidateDenied(
        readSessionPersistenceJournal(directory, envKey),
        'fixture-migrated'
      )
    ).toBe(true)
    expect(restore.accept('fixture-migrated')).toBe(true)
  })

  it('predeclares marker conversion and absence without granting candidate authority', () => {
    const owner = producer()
    owner.prepare('keytar', 'fixture-candidate')
    const marker = {
      revision: randomUUID(),
      intent: {
        intent: 'keytar-cleanup-pending' as const,
        credentialSource: 'safe-storage' as const,
      },
    }
    owner.declareMarker(marker)
    owner.declareMarker(null)
    const journal = readSessionPersistenceJournal(directory, envKey)!
    expect(journal.pending[0].plannedMarkerHashes).toEqual([
      sessionPersistenceMarkerHash(marker),
      sessionPersistenceMarkerHash(null),
    ])
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-candidate')).toBe(true)
  })

  it('retains visible denial after prepare rename lands but directory sync rejects', () => {
    const sync = fs.fsyncSync.bind(fs)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory())
        throw Object.assign(new Error('fixture-sync'), { code: 'EIO' })
      return sync(fd)
    })
    const owner = producer()
    expect(() => owner.prepare('keytar', 'fixture-unpublished')).toThrow(
      SessionPersistenceJournalAdmissionError
    )
    expect(
      isSessionPersistenceCandidateDenied(
        readSessionPersistenceJournal(directory, envKey),
        'fixture-unpublished'
      )
    ).toBe(true)
    expect(owner.isAccepted).toBe(false)
  })

  it('does not reject accepted authentication if retirement sync or its reporter fails', () => {
    const owner = producer(
      true,
      vi.fn(() => {
        throw new Error('fixture-report')
      })
    )
    owner.prepare('keytar', 'fixture-accepted')
    owner.assertMayAuthenticate('fixture-accepted')
    const sync = fs.fsyncSync.bind(fs)
    let failed = false
    const probe = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (!failed && fs.fstatSync(fd).isDirectory()) {
        failed = true
        throw Object.assign(new Error('fixture-retirement-sync'), { code: 'EIO' })
      }
      return sync(fd)
    })
    expect(owner.accept('fixture-accepted')).toBe(false)
    expect(owner.isAccepted).toBe(true)
    expect(readSessionPersistenceJournal(directory, envKey)).toBeNull()
    probe.mockClear()
    expect(owner.accept('fixture-accepted')).toBe(true)
    expect(probe).toHaveBeenCalled()
    expect(() => owner.prepare('keytar', 'fixture-late-write')).toThrow(
      SessionPersistenceJournalAdmissionError
    )
  })

  it.each(['revision', 'producer', 'candidateHash', 'observedMarkerHash'] as const)(
    'rejects non-string %s instead of coercing malformed denial metadata',
    field => {
      const owner = producer()
      owner.prepare('keytar', 'fixture-denied')
      const data = JSON.parse(fs.readFileSync(journalPath(), 'utf8'))
      if (field === 'revision') data.revision = [data.revision]
      else data.pending[0][field] = [data.pending[0][field]]
      fs.writeFileSync(journalPath(), JSON.stringify(data), { mode: 0o600 })
      expect(() => readSessionPersistenceJournal(directory, envKey)).toThrow(
        'invalid bounded schema'
      )
    }
  )

  it('rejects symlink and nonregular journal paths', () => {
    const target = path.join(directory, 'target')
    fs.writeFileSync(target, '{}', { mode: 0o600 })
    fs.symlinkSync(target, journalPath())
    expect(() => readSessionPersistenceJournal(directory, envKey)).toThrow()
    fs.unlinkSync(journalPath())
    fs.mkdirSync(journalPath())
    expect(() => readSessionPersistenceJournal(directory, envKey)).toThrow('regular file')
  })

  it('refuses quota exhaustion without removing older unresolved denials', () => {
    for (let index = 0; index < 128; index++) producer().prepare('keytar', `fixture-${index}`)
    const before = fs.readFileSync(journalPath(), 'utf8')
    expect(() => producer().prepare('keytar', 'fixture-overflow')).toThrow(
      SessionPersistenceJournalAdmissionError
    )
    expect(fs.readFileSync(journalPath(), 'utf8')).toBe(before)
  })

  it('bounds self-planned marker revisions before writing an invalid journal', () => {
    const owner = producer()
    owner.prepare('keytar', 'fixture-candidate')
    for (let index = 0; index < 64; index++)
      owner.declareMarker({ revision: randomUUID(), intent: { intent: 'logout-pending' } })
    const before = fs.readFileSync(journalPath(), 'utf8')
    expect(() =>
      owner.declareMarker({ revision: randomUUID(), intent: { intent: 'logout-pending' } })
    ).toThrow(SessionPersistenceJournalAdmissionError)
    expect(fs.readFileSync(journalPath(), 'utf8')).toBe(before)
  })

  it('classifies a genuine journal descriptor close failure as read-origin uncertainty', () => {
    producer().prepare('keytar', 'fixture-unaccepted')
    const close = fs.closeSync.bind(fs)
    const failure = Object.assign(new Error('fixture-close-uncertainty'), { code: 'EINTR' })
    let injected = false
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      close(fd)
      if (!injected) {
        injected = true
        throw failure
      }
    })
    let observed: unknown
    try {
      readSessionPersistenceJournal(directory, envKey)
    } catch (error) {
      observed = error
    }
    expect(observed).toBe(failure)
    expect(isSessionPersistenceJournalReadFailure(observed)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'preserves confirmed invalid-file evidence when descriptor close also fails transiently',
    () => {
      producer().prepare('keytar', 'fixture-unaccepted')
      fs.chmodSync(journalPath(), 0o644)
      const close = fs.closeSync.bind(fs)
      vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
        close(fd)
        throw Object.assign(new Error('fixture-secondary-close'), { code: 'EINTR' })
      })
      let observed: unknown
      try {
        readSessionPersistenceJournal(directory, envKey)
      } catch (error) {
        observed = error
      }
      expect(observed).toBeInstanceOf(Error)
      expect((observed as Error).message).toContain('not a private bounded regular file')
      expect(isSessionPersistenceJournalReadFailure(observed)).toBe(true)
    }
  )

  it('keeps candidate denial independent of source and marker revisions', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.string(),
        fc.string(),
        (older, current, candidate, different) => {
          fc.pre(older !== current && candidate !== different)
          const journal: SessionPersistenceJournal = {
            version: 1,
            revision: randomUUID(),
            pending: [
              {
                producer: older,
                candidateHash: sessionPersistenceCandidateHash(candidate),
                sources: ['keytar', 'safe-storage'],
                observedMarkerHash: sessionPersistenceMarkerHash(null),
                plannedMarkerHashes: [sessionPersistenceCandidateHash(current)],
              },
            ],
          }
          expect(isSessionPersistenceCandidateDenied(journal, candidate, current)).toBe(true)
          expect(isSessionPersistenceCandidateDenied(journal, different, current)).toBe(false)
          expect(isSessionPersistenceCandidateDenied(journal, candidate, older)).toBe(false)
        }
      ),
      { numRuns: 10_000 }
    )
  })
})
