import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as markers from '../pendingExternalLogout.js'

let directory = ''
const envKey = 'env_a-000000000000'
const markerPath = () =>
  path.join(
    directory,
    `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
  )
const read = () => markers.readPendingExternalLogoutMarker(directory, envKey)!

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-marker-cas-'))
})

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = ''
})

// Existing CAS behavior is characterization; normalization tests cover the new repair API.
describe('pending logout revision ownership', () => {
  it.each(['retire', 'convert'] as const)(
    'does not %s a newer marker with the same logout intent',
    operation => {
      markers.recordPendingExternalLogout(directory, envKey)
      const observed = read()
      markers.recordPendingExternalLogout(directory, envKey)
      const newer = read()
      expect(newer.intent).toEqual(observed.intent)
      expect(newer.revision).not.toBe(observed.revision)

      const changed =
        operation === 'retire'
          ? markers.clearPendingExternalLogoutIfUnchanged(directory, envKey, observed)
          : markers.recordPendingKeytarCleanupIfUnchanged(
              directory,
              envKey,
              observed,
              'safe-storage'
            )

      expect(changed).toBe(false)
      expect(read()).toEqual(newer)
    }
  )

  it('does not retire malformed bytes after a newer logout replaces them', () => {
    fs.writeFileSync(markerPath(), '{not-json')
    const contentsRevision = markers.readPendingExternalLogoutContentsRevision(directory, envKey)!
    markers.recordPendingExternalLogout(directory, envKey)
    const newer = read()

    expect(
      markers.clearPendingExternalLogoutIfContentsUnchanged(directory, envKey, contentsRevision)
    ).toBe(false)
    expect(read()).toEqual(newer)
  })

  it('retires unchanged malformed bytes through their content revision', () => {
    fs.writeFileSync(markerPath(), '{not-json')
    const contentsRevision = markers.readPendingExternalLogoutContentsRevision(directory, envKey)!

    expect(
      markers.clearPendingExternalLogoutIfContentsUnchanged(directory, envKey, contentsRevision)
    ).toBe(true)
    expect(markers.readPendingExternalLogoutMarker(directory, envKey)).toBeNull()
  })

  it('normalizes unchanged malformed bytes into revisioned logout intent', () => {
    fs.writeFileSync(markerPath(), '{not-json')
    const contentsRevision = markers.readPendingExternalLogoutContentsRevision(directory, envKey)!

    expect(
      markers.recordPendingExternalLogoutIfContentsUnchanged(directory, envKey, contentsRevision)
    ).toBe(true)
    expect(read()).toEqual({ intent: { intent: 'logout-pending' }, revision: expect.any(String) })
    expect(read().revision).not.toBe('')
    expect(
      markers.recordPendingExternalLogoutIfContentsUnchanged(directory, envKey, contentsRevision)
    ).toBe(false)
  })

  it('does not normalize newer malformed bytes over an older content revision', () => {
    fs.writeFileSync(markerPath(), '{not-json')
    const contentsRevision = markers.readPendingExternalLogoutContentsRevision(directory, envKey)!
    fs.writeFileSync(markerPath(), '{newer-corrupt-bytes')
    const newerContentsRevision = markers.readPendingExternalLogoutContentsRevision(
      directory,
      envKey
    )

    expect(
      markers.recordPendingExternalLogoutIfContentsUnchanged(directory, envKey, contentsRevision)
    ).toBe(false)
    expect(fs.readFileSync(markerPath(), 'utf8')).toBe('{newer-corrupt-bytes')
    expect(markers.readPendingExternalLogoutContentsRevision(directory, envKey)).toBe(
      newerContentsRevision
    )
  })

  it.each(['logout-pending', 'active-keytar', 'safe-storage'] as const)(
    'never overwrites an existing %s marker when recreating missing cleanup',
    intent => {
      if (intent === 'logout-pending') markers.recordPendingExternalLogout(directory, envKey)
      else markers.recordPendingKeytarCleanup(directory, envKey, intent)
      const existing = read()

      expect(markers.recordPendingKeytarCleanupIfMissing(directory, envKey, 'safe-storage')).toBe(
        false
      )
      expect(read()).toEqual(existing)
    }
  )

  it('records the attempted cleanup revision and rolls back only that owned record', () => {
    markers.recordPendingExternalLogout(directory, envKey)
    const observed = read()
    const attemptedRevision = randomUUID()

    expect(
      markers.recordPendingKeytarCleanupIfUnchanged(
        directory,
        envKey,
        observed,
        'safe-storage',
        attemptedRevision
      )
    ).toBe(true)
    const attempted = read()
    expect(attempted).toEqual({
      intent: { intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' },
      revision: attemptedRevision,
    })
    expect(markers.recordPendingExternalLogoutIfUnchanged(directory, envKey, attempted)).toBe(true)
    expect(read().intent).toEqual({ intent: 'logout-pending' })
    expect(read().revision).not.toBe(attemptedRevision)
    expect(markers.recordPendingExternalLogoutIfUnchanged(directory, envKey, attempted)).toBe(false)
  })

  it.each(['logout-pending', 'keytar-cleanup-pending'] as const)(
    'does not roll back a newer %s marker from an older cleanup snapshot',
    newerIntent => {
      markers.recordPendingKeytarCleanup(directory, envKey, 'safe-storage')
      const observed = read()
      if (newerIntent === 'logout-pending') {
        markers.recordPendingExternalLogout(directory, envKey)
      } else {
        markers.recordPendingKeytarCleanupIfUnchanged(directory, envKey, observed, 'safe-storage')
      }
      const newer = read()
      expect(newer.revision).not.toBe(observed.revision)

      expect(markers.recordPendingExternalLogoutIfUnchanged(directory, envKey, observed)).toBe(
        false
      )
      expect(read()).toEqual(newer)
    }
  )

  it('rejects an empty attempted cleanup revision without changing logout intent', () => {
    markers.recordPendingExternalLogout(directory, envKey)
    const observed = read()

    expect(() =>
      markers.recordPendingKeytarCleanupIfUnchanged(directory, envKey, observed, 'safe-storage', '')
    ).toThrow('Pending logout marker requires a nonempty revision')
    expect(read()).toEqual(observed)
  })

  it.each(['logout-pending', 'active-keytar', 'safe-storage'] as const)(
    'reads and conditionally retires a revisionless legacy %s marker',
    intent => {
      // Produce the actual wire format, then remove only the version-new revision field.
      if (intent === 'logout-pending') markers.recordPendingExternalLogout(directory, envKey)
      else markers.recordPendingKeytarCleanup(directory, envKey, intent)
      const legacy = JSON.parse(fs.readFileSync(markerPath(), 'utf8'))
      delete legacy.revision
      fs.writeFileSync(markerPath(), JSON.stringify(legacy))
      const observed = read()

      expect(observed.revision).toBeNull()
      expect(markers.clearPendingExternalLogoutIfUnchanged(directory, envKey, observed)).toBe(true)
      expect(markers.readPendingExternalLogoutMarker(directory, envKey)).toBeNull()
    }
  )

  it.each(['', null, 42, false, {}, []].map(revision => ({ revision })))(
    'rejects invalid revision $revision',
    ({ revision }) => {
      markers.recordPendingExternalLogout(directory, envKey)
      const invalid = JSON.parse(fs.readFileSync(markerPath(), 'utf8'))
      invalid.revision = revision
      fs.writeFileSync(markerPath(), JSON.stringify(invalid))

      expect(() => read()).toThrow('Pending logout marker has an invalid revision')
    }
  )

  it('preserves the newest logout across arbitrary stale producer decisions', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom('retire', 'active-keytar', 'safe-storage', 'normalize', 'rollback'),
          {
            minLength: 1,
            maxLength: 12,
          }
        ),
        decisions => {
          markers.recordPendingExternalLogout(directory, envKey)
          const stale = read()
          const staleContentsRevision = markers.readPendingExternalLogoutContentsRevision(
            directory,
            envKey
          )!
          markers.recordPendingExternalLogout(directory, envKey)
          const newest = read()
          for (const decision of decisions) {
            const changed =
              decision === 'retire'
                ? markers.clearPendingExternalLogoutIfUnchanged(directory, envKey, stale)
                : decision === 'rollback'
                  ? markers.recordPendingExternalLogoutIfUnchanged(directory, envKey, stale)
                  : decision === 'normalize'
                    ? markers.recordPendingExternalLogoutIfContentsUnchanged(
                        directory,
                        envKey,
                        staleContentsRevision
                      )
                    : markers.recordPendingKeytarCleanupIfUnchanged(
                        directory,
                        envKey,
                        stale,
                        decision
                      )
            expect(changed).toBe(false)
            expect(read()).toEqual(newest)
          }
          expect(markers.clearPendingExternalLogoutIfUnchanged(directory, envKey, newest)).toBe(
            true
          )
          expect(markers.clearPendingExternalLogoutIfUnchanged(directory, envKey, newest)).toBe(
            false
          )
        }
      ),
      { seed: 977, numRuns: 200 }
    )
  })
})
