import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionPersistenceProducer,
  isSessionPersistenceCandidateDenied,
  readSessionPersistenceJournal,
  sessionPersistenceCandidateHash,
} from '../sessionPersistenceJournal.js'

const envKey = 'fixture-0123456789ab'
let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-journal-accepted-hash-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

const producer = () =>
  new SessionPersistenceProducer(
    directory,
    envKey,
    null,
    () => {},
    () => {}
  )

describe('R21-M10 exact accepted candidate retirement', () => {
  it('preserves an independent unaccepted hash attempted before the accepted candidate', () => {
    const pending = producer()
    pending.prepare('keytar', 'fixture-not-accepted-A')
    const fresh = producer()
    fresh.prepare('keytar', 'fixture-not-accepted-A')
    fresh.prepare('safe-storage', 'fixture-accepted-B')
    fresh.assertMayAuthenticate('fixture-accepted-B')

    expect(fresh.accept('fixture-accepted-B')).toBe(true)

    const journal = readSessionPersistenceJournal(directory, envKey)
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-not-accepted-A')).toBe(true)
    expect(journal?.pending.some(entry => entry.producer === pending.producer)).toBe(true)
    expect(journal?.pending.map(entry => entry.candidateHash)).toEqual([
      sessionPersistenceCandidateHash('fixture-not-accepted-A'),
      sessionPersistenceCandidateHash('fixture-not-accepted-A'),
    ])
    expect(journal?.pending.map(entry => entry.producer)).toEqual([
      pending.producer,
      fresh.producer,
    ])
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-accepted-B')).toBe(false)
  })

  it('preserves its own unaccepted attempt while retiring only its accepted hash', () => {
    const fresh = producer()
    fresh.prepare('keytar', 'fixture-not-accepted-A')
    fresh.prepare('safe-storage', 'fixture-accepted-B')
    fresh.assertMayAuthenticate('fixture-accepted-B')

    expect(fresh.accept('fixture-accepted-B')).toBe(true)

    const journal = readSessionPersistenceJournal(directory, envKey)
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-not-accepted-A')).toBe(true)
    expect(journal?.pending).toHaveLength(1)
    expect(journal?.pending[0]?.producer).toBe(fresh.producer)
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-accepted-B')).toBe(false)
  })

  it('cannot name an unvalidated attempted hash as the accepted identity', () => {
    const fresh = producer()
    fresh.prepare('keytar', 'fixture-not-accepted-A')
    fresh.prepare('safe-storage', 'fixture-accepted-B')
    fresh.assertMayAuthenticate('fixture-accepted-B')

    expect(() => fresh.accept('fixture-not-accepted-A')).toThrow('exact validated candidate')
    expect(fresh.isAccepted).toBe(false)
    expect(
      isSessionPersistenceCandidateDenied(
        readSessionPersistenceJournal(directory, envKey),
        'fixture-not-accepted-A'
      )
    ).toBe(true)
  })

  it('keeps a later independent same-hash denial when accepted cleanup is retried', () => {
    const accepted = producer()
    accepted.prepare('keytar', 'fixture-not-accepted-A')
    accepted.prepare('safe-storage', 'fixture-accepted-B')
    accepted.assertMayAuthenticate('fixture-accepted-B')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('fixture-first accepted journal retirement failed')
    })
    expect(accepted.accept('fixture-accepted-B')).toBe(false)
    expect(accepted.isAccepted).toBe(true)
    const later = producer()
    later.prepare('keytar', 'fixture-accepted-B')
    expect(readSessionPersistenceJournal(directory, envKey)?.pending).toHaveLength(3)

    expect(accepted.accept('fixture-accepted-B')).toBe(true)

    const journal = readSessionPersistenceJournal(directory, envKey)
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-accepted-B')).toBe(true)
    expect(isSessionPersistenceCandidateDenied(journal, 'fixture-not-accepted-A')).toBe(true)
    expect(journal?.pending.map(entry => entry.producer)).toEqual([
      accepted.producer,
      later.producer,
    ])
    expect(journal?.pending.map(entry => entry.candidateHash)).toEqual([
      sessionPersistenceCandidateHash('fixture-not-accepted-A'),
      sessionPersistenceCandidateHash('fixture-accepted-B'),
    ])
  })
})
