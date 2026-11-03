import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type PendingExternalLogoutMarker,
  type PendingExternalLogoutRawObservation,
  pendingExternalLogoutOwnership,
} from '../pendingExternalLogout.js'
import {
  type SessionAuthorityCandidate,
  type SessionAuthorityRecord,
  canAcceptSessionAuthorityCandidate,
  digestSessionAuthoritySource,
} from '../sessionAuthorityRecord.js'
import { observeSessionPersistenceLegacySnapshot } from '../sessionPersistenceJournal.js'

const envKey = 'fixture-0123456789ab'
let fixtureDirectory: string

beforeEach(() => {
  fixtureDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-r23-m7-')))
})

afterEach(() => {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function alternateRevision(revision: string): string {
  return revision.endsWith('0') ? `${revision.slice(0, -1)}1` : `${revision.slice(0, -1)}0`
}

function matchesCapturedMarker(
  candidate: SessionAuthorityCandidate,
  observation: PendingExternalLogoutRawObservation
): boolean {
  return (
    candidate.observedExternalMarker.kind === observation.kind &&
    candidate.observedExternalMarker.revision === (observation.marker?.revision ?? null) &&
    candidate.observedExternalMarker.digest === observation.rawDigest
  )
}

describe('composed logout-fence acceptance policy properties', () => {
  it('requires each external marker and authority acceptance gate to match', () => {
    const journalObservation = observeSessionPersistenceLegacySnapshot(fixtureDirectory, envKey)
    if (journalObservation.status !== 'observed')
      throw new Error('Expected an absent synthetic legacy journal')
    const legacyJournalReceipt = journalObservation.receipt
    expect(legacyJournalReceipt).toMatchObject({
      schemaVersion: 0,
      byteLength: 0,
      denials: [],
    })

    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        (markerRevision, transactionId, sourceRef, sourceRevision) => {
          const token = `composed-policy-candidate-${transactionId}`
          const externalMarker: PendingExternalLogoutMarker = {
            revision: markerRevision,
            intent: { intent: 'logout-pending' },
          }
          const rawMarkerContents = JSON.stringify({
            version: 1,
            revision: markerRevision,
            intent: 'logout-pending',
          })
          const rawMarkerObservation: PendingExternalLogoutRawObservation = {
            rawContents: rawMarkerContents,
            rawDigest: sha256(rawMarkerContents),
            kind: 'revisioned',
            marker: externalMarker,
          }
          const publishedSource = {
            kind: 'keytar' as const,
            format: 'v1' as const,
            transactionId,
            envKey,
            accountId: 'composed-policy-fixture',
            sourceRef,
            sourceRevision,
            storedValueDigest: digestSessionAuthoritySource(
              {
                sourceKind: 'keytar',
                sourceRef,
                envKey,
                accountId: 'composed-policy-fixture',
              },
              token
            ),
          }
          const candidate: SessionAuthorityCandidate = {
            transactionId,
            candidateHash: sha256(token),
            accountId: 'composed-policy-fixture',
            sourceKind: 'keytar',
            sourceRef,
            sourceRevision,
            observedFrameRevision: markerRevision,
            observedMarkerRevision: markerRevision,
            observedExternalMarker: {
              kind: rawMarkerObservation.kind,
              revision: rawMarkerObservation.marker?.revision ?? null,
              digest: rawMarkerObservation.rawDigest,
            },
            observedLegacyJournal: {
              schemaVersion: legacyJournalReceipt.schemaVersion,
              revision: legacyJournalReceipt.revision,
              byteLength: legacyJournalReceipt.byteLength,
              digest: legacyJournalReceipt.digest,
            },
            priorSource: null,
            phase: 'verified',
            publishedSource,
            volatileSessionId: null,
          }
          const record: SessionAuthorityRecord = {
            version: 2,
            envKey,
            revision: randomUUID(),
            marker: { intent: 'logout-pending', revision: markerRevision },
            latestCandidateTransactionId: transactionId,
            frame: {
              revision: markerRevision,
              envKey,
              mode: 'logged-out',
              transactionId: null,
              source: null,
              volatileSessionId: null,
              denyUnframedSources: true,
              recoveryId: null,
            },
            candidates: [candidate],
            cleanupDebts: [],
            quarantines: [],
            legacyJournalReceipt,
            projectionIntent: null,
            projectionReceipt: null,
            logoutReceipt: null,
          }
          const observed = { status: 'observed' as const, marker: externalMarker }
          const markerOwner = pendingExternalLogoutOwnership(observed, [externalMarker], true)
          const authorityAllows = canAcceptSessionAuthorityCandidate(record, transactionId, true)
          const capturedMarkerMatches = matchesCapturedMarker(candidate, rawMarkerObservation)

          expect(markerOwner.status).toBe('owned')
          expect(authorityAllows).toBe(true)
          expect(capturedMarkerMatches).toBe(true)
          expect(markerOwner.status === 'owned' && capturedMarkerMatches && authorityAllows).toBe(
            true
          )

          const supersededExternalMarker = {
            status: 'observed' as const,
            marker: { ...externalMarker, revision: alternateRevision(markerRevision) },
          }
          const supersededOwner = pendingExternalLogoutOwnership(
            supersededExternalMarker,
            [externalMarker],
            true
          )
          expect(supersededOwner).toEqual({ status: 'superseded' })
          expect(
            supersededOwner.status === 'owned' && capturedMarkerMatches && authorityAllows
          ).toBe(false)
          expect(pendingExternalLogoutOwnership(observed, [externalMarker], false).status).toBe(
            'superseded'
          )

          const differentIntentMarker: PendingExternalLogoutMarker = {
            revision: markerRevision,
            intent: { intent: 'keytar-cleanup-pending', credentialSource: 'active-keytar' },
          }
          const differentIntentObservation = {
            status: 'observed' as const,
            marker: differentIntentMarker,
          }
          const differentIntentRawContents = JSON.stringify({
            version: 1,
            revision: markerRevision,
            intent: 'keytar-cleanup-pending',
            credentialSource: 'active-keytar',
          })
          const differentIntentRawObservation: PendingExternalLogoutRawObservation = {
            rawContents: differentIntentRawContents,
            rawDigest: sha256(differentIntentRawContents),
            kind: 'revisioned',
            marker: differentIntentMarker,
          }
          const differentIntentOwner = pendingExternalLogoutOwnership(
            differentIntentObservation,
            [externalMarker],
            true
          )
          expect(differentIntentOwner).toEqual({ status: 'superseded' })
          expect(matchesCapturedMarker(candidate, differentIntentRawObservation)).toBe(false)
          expect(
            differentIntentOwner.status === 'owned' &&
              matchesCapturedMarker(candidate, differentIntentRawObservation) &&
              authorityAllows
          ).toBe(false)

          const wrongCandidateDigest = {
            ...candidate,
            observedExternalMarker: {
              ...candidate.observedExternalMarker,
              digest: sha256(`${rawMarkerContents}:altered`),
            },
          }
          expect(matchesCapturedMarker(wrongCandidateDigest, rawMarkerObservation)).toBe(false)
          const wrongCandidateKind = {
            ...candidate,
            observedExternalMarker: {
              ...candidate.observedExternalMarker,
              kind: 'absent' as const,
              revision: null,
            },
          }
          expect(matchesCapturedMarker(wrongCandidateKind, rawMarkerObservation)).toBe(false)

          const nextRevision = alternateRevision(markerRevision)
          const movedAuthority: SessionAuthorityRecord = {
            ...record,
            marker: { intent: 'logout-pending', revision: nextRevision },
            frame: { ...record.frame, revision: nextRevision },
            candidates: [{ ...candidate, observedFrameRevision: nextRevision }],
          }
          expect(canAcceptSessionAuthorityCandidate(movedAuthority, transactionId, true)).toBe(
            false
          )
          expect(
            canAcceptSessionAuthorityCandidate(
              {
                ...record,
                candidates: [
                  { ...candidate, observedFrameRevision: alternateRevision(markerRevision) },
                ],
              },
              transactionId,
              true
            )
          ).toBe(false)
          expect(canAcceptSessionAuthorityCandidate(record, transactionId, false)).toBe(false)
        }
      ),
      { numRuns: 1000 }
    )
  })
})
