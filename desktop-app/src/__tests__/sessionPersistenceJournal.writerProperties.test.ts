import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PendingExternalLogoutMarker } from '../pendingExternalLogout.js'
import {
  SessionPersistenceProducer,
  isSessionPersistenceCandidateDenied,
  readSessionPersistenceJournal,
  sessionPersistenceMarkerHash,
} from '../sessionPersistenceJournal.js'

const envKey = 'fixture-0123456789ab'
let directory: string
const journalPath = () =>
  path.join(
    directory,
    `session-persistence-journal-${createHash('sha256').update(envKey).digest('hex')}`
  )

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-journal-writer-property-'))
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('writer-derived journal state properties', () => {
  it('preserves multi-producer denials through generated prepare and acceptance schedules', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            markerRevision: fc.uuid(),
            prepareRank: fc.integer({ min: 0, max: 100 }),
            acceptRank: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 2, maxLength: 5 }
        ),
        generated => {
          fs.rmSync(journalPath(), { force: true })
          const entries = generated.map((value, index) => {
            const acceptedToken = `writer-derived-accepted-${index}-${value.id}`
            const pendingToken = `writer-derived-pending-${index}-${value.id}`
            const marker: PendingExternalLogoutMarker = {
              revision: value.markerRevision,
              intent: { intent: 'logout-pending' },
            }
            return {
              ...value,
              acceptedToken,
              pendingToken,
              marker,
              producer: new SessionPersistenceProducer(
                directory,
                envKey,
                null,
                () => {},
                () => {}
              ),
            }
          })

          for (const entry of [...entries].sort(
            (left, right) => left.prepareRank - right.prepareRank
          )) {
            for (const token of [entry.acceptedToken, entry.pendingToken]) {
              entry.producer.prepare('keytar', token)
              entry.producer.prepare('safe-storage', token)
              entry.producer.prepare('keytar', token)
            }
            entry.producer.declareMarker(entry.marker)
          }

          const hash = (token: string) => createHash('sha256').update(token).digest('hex')
          const outstanding = new Map(
            entries.flatMap(entry =>
              [entry.acceptedToken, entry.pendingToken].map(token => [
                `${entry.producer.producer}:${hash(token)}`,
                { token, producer: entry.producer.producer, marker: entry.marker },
              ])
            )
          )
          const initiallyWritten = readSessionPersistenceJournal(directory, envKey)
          expect(initiallyWritten?.pending).toHaveLength(entries.length * 2)

          for (const entry of entries) {
            for (const token of [entry.acceptedToken, entry.pendingToken]) {
              const denial = initiallyWritten?.pending.find(
                value =>
                  value.producer === entry.producer.producer && value.candidateHash === hash(token)
              )
              expect(denial).toMatchObject({
                sources: ['keytar', 'safe-storage'],
                plannedMarkerHashes: [sessionPersistenceMarkerHash(entry.marker)],
              })
              expect(isSessionPersistenceCandidateDenied(initiallyWritten, token)).toBe(true)
              expect(
                isSessionPersistenceCandidateDenied(
                  initiallyWritten,
                  token,
                  entry.producer.producer
                )
              ).toBe(false)
              expect(isSessionPersistenceCandidateDenied(initiallyWritten, `${token}-other`)).toBe(
                false
              )
            }
          }

          const acceptanceOrder = [...entries].sort(
            (left, right) => left.acceptRank - right.acceptRank
          )
          for (const entry of acceptanceOrder) {
            entry.producer.assertMayAuthenticate(entry.acceptedToken)
            expect(entry.producer.accept(entry.acceptedToken)).toBe(true)
            outstanding.delete(`${entry.producer.producer}:${hash(entry.acceptedToken)}`)
            const current = readSessionPersistenceJournal(directory, envKey)
            const actual = (current?.pending ?? [])
              .map(value => `${value.producer}:${value.candidateHash}`)
              .sort()
            expect(actual).toEqual([...outstanding.keys()].sort())
            for (const retainedExpected of outstanding.values()) {
              expect(isSessionPersistenceCandidateDenied(current, retainedExpected.token)).toBe(
                true
              )
              expect(
                isSessionPersistenceCandidateDenied(
                  current,
                  retainedExpected.token,
                  retainedExpected.producer
                )
              ).toBe(false)
              const retained = current?.pending.find(
                value =>
                  value.producer === retainedExpected.producer &&
                  value.candidateHash === hash(retainedExpected.token)
              )
              expect(retained).toMatchObject({
                sources: ['keytar', 'safe-storage'],
                plannedMarkerHashes: [sessionPersistenceMarkerHash(retainedExpected.marker)],
              })
            }
          }

          expect(readSessionPersistenceJournal(directory, envKey)?.pending).toHaveLength(
            entries.length
          )
        }
      ),
      { numRuns: 50 }
    )
  })
})
