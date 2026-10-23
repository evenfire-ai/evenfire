import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type TeamGfsStreamHead,
  type TeamGfsStreamRequest,
  collectTeamGfsTopK,
} from '../src/services/access/teamGfsTopK.js'

function logicalId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

describe('team GFS top-k properties', () => {
  it('matches the exact union across arbitrary stream order and duplicate distributions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uniqueArray(fc.integer({ min: 1, max: 80 }), { maxLength: 30 }), {
          minLength: 1,
          maxLength: 16,
        }),
        fc.integer({ min: 0, max: 40 }),
        fc.oneof(fc.constant(1), fc.constant(2), fc.integer({ min: 3, max: 20 })),
        fc.boolean(),
        async (generated, afterValue, take, reverseResults) => {
          const valuesBySubject = new Map(
            generated.map((values, index) => [
              `team-${index}`,
              [...values].sort((left, right) => left - right).map(logicalId),
            ])
          )
          const streams = [...valuesBySubject.keys()].map(subjectId => ({
            kind: 'grant' as const,
            subjectId,
            afterId: logicalId(afterValue),
          }))
          const read = async (
            requests: readonly TeamGfsStreamRequest[]
          ): Promise<readonly TeamGfsStreamHead[]> => {
            const heads = requests.flatMap(request => {
              const selected = (valuesBySubject.get(request.subjectId) ?? [])
                .filter(value => value > request.afterId)
                .slice(0, request.take)
              return selected.map((value, index) => ({
                kind: request.kind,
                subjectId: request.subjectId,
                logicalId: value,
                batchLast: index === selected.length - 1,
              }))
            })
            return reverseResults ? heads.reverse() : heads
          }
          const expected = [...new Set(generated.flat())]
            .filter(value => value > afterValue)
            .sort((left, right) => left - right)
            .map(logicalId)
          const result = await collectTeamGfsTopK({ streams, take, read })
          const repeated = await collectTeamGfsTopK({
            streams: [...streams].reverse(),
            take,
            read,
          })

          expect(result.logicalIds).toEqual(expected.slice(0, take + 1))
          expect(new Set(result.logicalIds).size).toBe(result.logicalIds.length)
          expect(repeated.logicalIds).toEqual(result.logicalIds)
          expect(result.hasMore || result.logicalIds.length > take).toBe(expected.length > take)
        }
      ),
      { numRuns: 250 }
    )
  })
})
