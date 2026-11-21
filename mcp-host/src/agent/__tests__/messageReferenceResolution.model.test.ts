/**
 * Model-based oracle for the joint resolution of file and location
 * references. fast-check picks each reference's gfsc outcome and the order in
 * which the answers arrive; the real `resolveMessageReferences` runs against a
 * fake client, and the result is compared with a trivial reference model:
 * any failure to check refuses the message, otherwise there is exactly one
 * resolution per reference, in order, with the availability of the outcome.
 * A Host without a gfsc client marks every reference unsupported and calls
 * nothing.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type FileReferenceV1,
  type LocationReferenceV1,
  buildGfsFileReference,
  buildGfsLocationReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { GfscHttpError } from '../../internalTools/gfsClient'
import {
  type FileReferenceCheckFailure,
  type FileReferenceGfscClient,
  resolveMessageReferences,
} from '../fileReferenceResolver'
import views from './fixtures/gfsc-resolve-views.json'

type ViewIndex = keyof typeof views.directory

const OUTCOMES = [
  'dir',
  'file',
  // A well-formed body that describes another resource.
  'mismatch',
  '403',
  '404',
  '410',
  '400',
  '401',
  '5xx',
  'network',
  'hang',
] as const
type Outcome = (typeof OUTCOMES)[number]

const DEADLINE_MS = 10
const rid = (n: number) => n.toString(16).padStart(32, '0')

function folder(n: number): LocationReferenceV1 {
  const built = buildGfsLocationReference({
    drive: 'main',
    resourceId: rid(n),
    gfsUri: `gfs://main/${rid(n)}`,
    name: `Desktop-${n}`,
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

/** The reference model: what the outcome means, independent of the resolver. */
function modelFailure(outcome: Outcome): FileReferenceCheckFailure | null {
  if (outcome === '400') return 'invalid'
  if (outcome === '401') return 'credentials'
  if (outcome === 'mismatch') return 'contract'
  if (outcome === '5xx' || outcome === 'network' || outcome === 'hang') return 'transient'
  return null
}

function modelFileAvailability(outcome: Outcome): string {
  return {
    dir: 'not_a_file',
    file: 'available',
    403: 'denied',
    404: 'not_found',
    410: 'not_found',
  }[outcome as 'dir']
}

function modelLocationAvailability(outcome: Outcome): string {
  return {
    dir: 'available',
    file: 'not_a_folder',
    403: 'denied',
    404: 'not_found',
    410: 'not_found',
  }[outcome as 'dir']
}

describe('resolveMessageReferences — model', () => {
  it('matches the reference model for every outcome mix and answer order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...OUTCOMES), { maxLength: 3 }),
        fc.option(fc.constantFrom(...OUTCOMES), { nil: undefined }),
        fc.boolean(),
        fc.scheduler(),
        async (fileOutcomes, locationOutcome, hasClient, s) => {
          const files = fileOutcomes.map((_, i) => file(i + 1))
          const locations = locationOutcome === undefined ? [] : [folder(4)]
          const outcomeByUri = new Map<string, { outcome: Outcome; n: number }>()
          fileOutcomes.forEach((outcome, i) =>
            outcomeByUri.set(`gfs://main/${rid(i + 1)}`, { outcome, n: i + 1 })
          )
          if (locationOutcome !== undefined)
            outcomeByUri.set(`gfs://main/${rid(4)}`, { outcome: locationOutcome, n: 4 })

          const calls: string[] = []
          const gfsc: FileReferenceGfscClient = {
            resolve: ({ uri }, call) => {
              calls.push(uri)
              const { outcome, n } = outcomeByUri.get(uri)!
              if (outcome === 'hang')
                return new Promise((_resolve, reject) =>
                  call.signal.addEventListener('abort', () => reject(call.signal.reason))
                )
              return s.schedule(Promise.resolve(), uri).then(() => {
                const key = String(n) as ViewIndex
                switch (outcome) {
                  case 'dir':
                    return views.directory[key]
                  case 'file':
                    return views.file[key]
                  case 'mismatch':
                    return views.directory[String(n === 1 ? 2 : 1) as ViewIndex]
                  case 'network':
                    throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') })
                  case '5xx':
                    throw new GfscHttpError(503, 'not_mounted')
                  default:
                    throw new GfscHttpError(Number(outcome), 'x')
                }
              })
            },
          }

          const pending = resolveMessageReferences(
            files,
            locations,
            hasClient ? gfsc : null,
            DEADLINE_MS
          )
          await s.waitAll()
          const result = await pending

          if (!hasClient) {
            expect(calls).toEqual([])
            expect(result).toEqual({
              ok: true,
              resolutions: files.map(reference => ({ availability: 'unsupported', reference })),
              locationResolutions: locations.map(reference => ({
                availability: 'unsupported',
                reference,
                name: reference.name,
                nameSource: 'client',
              })),
            })
            return
          }

          const allOutcomes = [...fileOutcomes, ...(locationOutcome ? [locationOutcome] : [])]
          const failures = allOutcomes.map(modelFailure).filter(f => f !== null)

          // HK1: one gfsc call per reference, whatever happens.
          expect([...calls].sort()).toEqual([...outcomeByUri.keys()].sort())

          if (failures.length) {
            // HS6: a reference that could not be checked refuses the message.
            expect(result.ok).toBe(false)
            if (!result.ok) expect(failures).toContain(result.failure)
            return
          }
          expect(result.ok).toBe(true)
          if (!result.ok) return
          // HS2: every valid location has its resolution.
          expect(result.resolutions.map(r => [r.reference.id, r.availability])).toEqual(
            fileOutcomes.map((o, i) => [files[i]!.id, modelFileAvailability(o)])
          )
          expect(result.locationResolutions.map(r => [r.reference.id, r.availability])).toEqual(
            locationOutcome === undefined
              ? []
              : [[locations[0]!.id, modelLocationAvailability(locationOutcome)]]
          )
          // HS1: available only for a directory whose identity matched.
          for (const r of result.locationResolutions) {
            if (r.availability === 'available') expect(locationOutcome).toBe('dir')
          }
        }
      ),
      { numRuns: 300 }
    )
  })
})
