import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionPersistenceJournalAdmissionError,
  SessionPersistenceProducer,
  isSessionPersistenceCandidateDenied,
  readSessionPersistenceJournal,
  sessionPersistenceCandidateHash,
} from '../sessionPersistenceJournal.js'

const envKey = 'fixture-0123456789ab'
const home = 'fixture-previously-accepted-home'
const rejected = 'fixture-rejected-candidate'
let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-prior-repair-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

function owner() {
  let markerReadable = true
  let runtimeOwned = true
  const requireSource = () => {
    if (!markerReadable)
      throw Object.assign(new Error('fixture-marker-uncertainty'), { code: 'EMFILE' })
  }
  const requireRuntime = () => {
    if (!runtimeOwned) throw new Error('fixture-runtime-superseded')
  }
  const producer = new SessionPersistenceProducer(
    directory,
    envKey,
    null,
    requireSource,
    () => {},
    true,
    home,
    requireRuntime
  )
  return {
    producer,
    loseMarkerInspection: () => {
      markerReadable = false
    },
    loseRuntime: () => {
      runtimeOwned = false
    },
  }
}

const independent = () =>
  new SessionPersistenceProducer(
    directory,
    envKey,
    null,
    () => {},
    () => {}
  )
const journal = () => readSessionPersistenceJournal(directory, envKey)!

describe('journal prior-authority repair capability', () => {
  it('prepares only the captured prior hash during source uncertainty and retains candidate denial', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    transaction.loseMarkerInspection()
    transaction.producer.preparePriorRepair('keytar', rejected, home)
    transaction.producer.preparePriorRepair('safe-storage', rejected, home)
    const current = journal()
    expect(current.pending).toHaveLength(2)
    expect(isSessionPersistenceCandidateDenied(current, rejected)).toBe(true)
    expect(isSessionPersistenceCandidateDenied(current, home)).toBe(true)
    expect(
      current.pending.find(entry => entry.candidateHash === sessionPersistenceCandidateHash(home))
        ?.sources
    ).toEqual(['keytar', 'safe-storage'])
    const bytes = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]!), 'utf8')
    expect(bytes).not.toContain(home)
    expect(bytes).not.toContain(rejected)
    expect(transaction.producer.isAccepted).toBe(false)
  })

  it('rejects a wrong prior authority without changing the real pending journal', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    const before = journal()
    expect(() =>
      transaction.producer.preparePriorRepair('keytar', rejected, 'fixture-not-prior')
    ).toThrow(SessionPersistenceJournalAdmissionError)
    expect(journal()).toEqual(before)
  })

  it('requires its exact original rejected entry, not a remaining own prior-repair entry', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    transaction.producer.preparePriorRepair('keytar', rejected, home)
    const acceptedNewer = independent()
    acceptedNewer.prepare('safe-storage', rejected)
    acceptedNewer.assertMayAuthenticate(rejected)
    expect(acceptedNewer.accept(rejected)).toBe(true)
    const before = journal()
    expect(before.pending.map(entry => entry.candidateHash)).toEqual([
      sessionPersistenceCandidateHash(home),
    ])
    expect(() => transaction.producer.preparePriorRepair('safe-storage', rejected, home)).toThrow(
      'Session persistence journal admission failed'
    )
    expect(journal()).toEqual(before)
  })

  it('preserves an independent pending producer of the same rejected value', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    independent().prepare('safe-storage', rejected)
    const before = journal()
    expect(() => transaction.producer.preparePriorRepair('keytar', rejected, home)).toThrow(
      SessionPersistenceJournalAdmissionError
    )
    expect(journal()).toEqual(before)
    expect(isSessionPersistenceCandidateDenied(journal(), home)).toBe(false)
  })

  it('does not create a prior-repair entry after runtime ownership is lost', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    const before = journal()
    transaction.loseRuntime()
    expect(() => transaction.producer.preparePriorRepair('keytar', rejected, home)).toThrow(
      'fixture-runtime-superseded'
    )
    expect(journal()).toEqual(before)
  })

  it('rejects post-acceptance repair and generic retirement of another unaccepted attempt', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    transaction.producer.prepare('safe-storage', 'fixture-independent-unaccepted-attempt')
    transaction.producer.assertMayAuthenticate(rejected)
    expect(transaction.producer.accept(rejected)).toBe(true)
    const before = journal()
    expect(() => transaction.producer.preparePriorRepair('keytar', rejected, home)).toThrow(
      SessionPersistenceJournalAdmissionError
    )
    expect(() => transaction.producer.repaired()).toThrow('cannot roll back another candidate')
    expect(journal()).toEqual(before)
    expect(
      isSessionPersistenceCandidateDenied(before, 'fixture-independent-unaccepted-attempt')
    ).toBe(true)
  })

  it('retains visible candidate and prior denial when prior preparation rename lands but sync fails', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    const sync = fs.fsyncSync.bind(fs)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory())
        throw Object.assign(new Error('fixture-prior-directory-sync'), { code: 'EIO' })
      return sync(fd)
    })
    expect(() => transaction.producer.preparePriorRepair('safe-storage', rejected, home)).toThrow(
      SessionPersistenceJournalAdmissionError
    )
    expect(isSessionPersistenceCandidateDenied(journal(), rejected)).toBe(true)
    expect(isSessionPersistenceCandidateDenied(journal(), home)).toBe(true)
    expect(transaction.producer.isAccepted).toBe(false)
  })

  it('retires only its own verified repair entries and preserves an independent candidate', () => {
    const transaction = owner()
    transaction.producer.prepare('keytar', rejected)
    transaction.producer.preparePriorRepair('keytar', rejected, home)
    const newer = independent()
    newer.prepare('safe-storage', 'fixture-newer-pending-candidate')
    expect(transaction.producer.repaired()).toBe(true)
    const current = journal()
    expect(current.pending.map(entry => entry.producer)).toEqual([newer.producer])
    expect(isSessionPersistenceCandidateDenied(current, rejected)).toBe(false)
    expect(isSessionPersistenceCandidateDenied(current, home)).toBe(false)
    expect(isSessionPersistenceCandidateDenied(current, 'fixture-newer-pending-candidate')).toBe(
      true
    )
  })
})
