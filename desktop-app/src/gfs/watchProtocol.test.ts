import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import * as server from '../../../control-api/src/services/gfsWatch/keys.js'
import { USER_A, signV1SessionToken } from '../../testSupport/gfsWatch/sessionTokens.js'
import {
  MAX_DRIVES,
  MAX_FRAME_CHARS,
  MAX_KEYS,
  bindingChanged,
  bindingOf,
  canonList,
  canonicalKey,
  decodeJwtPayload,
  errorCodeOf,
  fuse,
  normUid,
  parseFrameLine,
  parseRetryAfterMs,
  positiveGeneration,
  withinSetCeilings,
} from './watchProtocol.js'

// control-api's keys.ts is the producer of every key and binding the watch
// compares: its only import is a type, so it loads without that package's
// dependencies, and the main-side helpers are checked against it directly.

const hex = (n: number) => fc.stringMatching(new RegExp(`^[0-9a-fA-F]{${n}}$`))
const keyLike = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('file', 'dir', 'File', 'folder'),
      fc.stringMatching(/^[a-zA-Z0-9-]{0,64}$/),
      hex(32)
    )
    .map(([k, d, r]) => `${k}:gfs://${d}/${r}`),
  fc.string(),
  fc.constant(`file:gfs://d1/${'a'.repeat(32)}`)
)
const uidLike = fc.oneof(
  fc.uuid(),
  fc.uuid().map(u => u.toUpperCase()),
  fc.uuid().map(u => u.replace(/-/g, '')),
  fc.string(),
  fc.integer()
)
const generationLike = fc.oneof(
  fc.integer({ min: -3, max: 2 ** 53 + 2 }),
  fc.integer({ min: 0, max: 99999 }).map(String),
  fc.constantFrom('01', ' 1', '1.0', '+1', '1e3', '9007199254740993'),
  fc.double(),
  fc.constant(null)
)

describe('watch protocol helpers', () => {
  it('canonicalKey accepts exactly the keys control-api parses', () => {
    fc.assert(
      fc.property(keyLike, x => {
        expect(canonicalKey(x) !== null).toBe(server.parseKey(x) !== null)
      }),
      { numRuns: 5000 }
    )
  })

  it('normUid and positiveGeneration agree with control-api', () => {
    fc.assert(
      fc.property(uidLike, generationLike, (u, g) => {
        expect(normUid(u)).toBe(server.normUid(u))
        expect(positiveGeneration(g)).toBe(server.positiveGeneration(g))
      }),
      { numRuns: 5000 }
    )
  })

  it('canonList keeps the first occurrence, its order, and drops everything else', () => {
    const a = `file:gfs://d1/${'a'.repeat(32)}`
    const b = `dir:gfs://d1/${'b'.repeat(32)}`
    expect(canonList([b, 'nope', a, b, 7, `FILE:gfs://d1/${'c'.repeat(32)}`])).toEqual([b, a])
    expect(canonList('not an array')).toEqual([])
    expect(withinSetCeilings(Array.from({ length: 80 }, (_, i) => String(i)))).toHaveLength(64)
  })

  it('withinSetCeilings sends a set control-api accepts, the rank-order prefix of the first two drives', () => {
    expect(MAX_KEYS).toBe(server.MAX_KEYS_PER_SET)
    expect(MAX_DRIVES).toBe(server.MAX_DRIVES_PER_SET)
    const canonical = fc
      .tuple(fc.constantFrom('file', 'dir'), fc.constantFrom('d1', 'd2', 'd3', 'main'), hex(32))
      .map(([k, d, r]) => `${k}:gfs://${d}/${r.toLowerCase()}`)
    fc.assert(
      fc.property(fc.uniqueArray(canonical, { maxLength: 90 }), list => {
        const out = withinSetCeilings(list)
        expect(server.parseKeys(out)).not.toBeNull()
        const drive = (k: string) => k.split('/')[2]!
        const kept = [...new Set(list.map(drive))].slice(0, MAX_DRIVES)
        expect(out).toEqual(list.filter(k => kept.includes(drive(k))).slice(0, MAX_KEYS))
      }),
      { numRuns: 5000 }
    )
  })

  it('fuse merges by rank, breaks ties by registration order and never repeats a key', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.constantFrom<string>('a', 'b', 'c', 'd', 'e', 'f'), { maxLength: 6 }),
          { maxLength: 4 }
        ),
        lists => {
          const owners = lists.map((keys, i) => ({ regOrder: lists.length - i, keys }))
          const out = fuse(owners)
          expect(new Set(out).size).toBe(out.length)
          expect(new Set(out)).toEqual(new Set(lists.flat()))
          // rank of each key = its best position over every owner, ties by regOrder
          const rank = (k: string) =>
            Math.min(
              ...owners.flatMap(o => {
                const i = o.keys.indexOf(k)
                return i === -1 ? [] : [i * 100 + o.regOrder]
              })
            )
          for (let i = 1; i < out.length; i++) expect(rank(out[i - 1]!)).toBeLessThan(rank(out[i]!))
        }
      )
    )
  })

  it('bindingOf reads the V1 claims the session producer signs, and nothing else', () => {
    const token = signV1SessionToken({
      userId: USER_A.toUpperCase(),
      authGeneration: 3,
      teamId: null,
    })
    expect(bindingOf(token)).toEqual({ userId: USER_A, authGeneration: 3 })
    expect(bindingOf('opaque-session-token')).toBeNull()
    expect(bindingOf(null)).toBeNull()
    expect(bindingOf('a.%%%.c')).toBeNull()
    expect(decodeJwtPayload(`x.${Buffer.from('[1]').toString('base64url')}.y`)).toBeNull()
    fc.assert(fc.property(fc.string(), s => void bindingOf(s)))
  })

  it('bindingChanged compares fields, and null differs from everything', () => {
    expect(
      bindingChanged({ userId: 'u', authGeneration: 1 }, { userId: 'u', authGeneration: 1 })
    ).toBe(false)
    expect(
      bindingChanged({ userId: 'u', authGeneration: 1 }, { userId: 'u', authGeneration: 2 })
    ).toBe(true)
    expect(bindingChanged(null, null)).toBe(true)
  })

  it('parseRetryAfterMs reads seconds or an HTTP-date, capped at 5 minutes', () => {
    const now = Date.UTC(2026, 0, 1)
    expect(parseRetryAfterMs('7', now)).toBe(7000)
    expect(parseRetryAfterMs(new Date(now + 7000).toUTCString(), now)).toBe(7000)
    expect(parseRetryAfterMs('3600', now)).toBe(300_000)
    expect(parseRetryAfterMs('soon', now)).toBeUndefined()
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined()
    expect(parseRetryAfterMs(new Date(now - 5000).toUTCString(), now)).toBe(0)
  })

  it('errorCodeOf prefers the header, falls back to the body, and refuses foreign codes', () => {
    expect(errorCodeOf({ header: 'desktop_user_retired', bodyText: '{"error":"x"}' })).toBe(
      'desktop_user_retired'
    )
    expect(errorCodeOf({ bodyText: '{"error":"upgrade_required"}' })).toBe('upgrade_required')
    expect(errorCodeOf({ bodyText: '{"error":{"code":"x"}}' })).toBeNull()
    expect(errorCodeOf({ header: 'Bad Code' })).toBeNull()
    expect(errorCodeOf({ bodyText: 'not json' })).toBeNull()
  })

  it('parseFrameLine separates invalid known frames from unknown ones', () => {
    const line = (o: object) => JSON.stringify({ schemaVersion: 1, ...o })
    expect(
      parseFrameLine(line({ type: 'subscriptions', accepted: [], rejected: [], deferred: [] })).kind
    ).toBe('invalid')
    expect(
      parseFrameLine(
        line({ type: 'subscriptions', seq: 1, accepted: [], rejected: [], deferred: [] })
      ).kind
    ).toBe('frame')
    expect(
      parseFrameLine(line({ type: 'stream.closing', reason: 'x', retryAfterMs: 300_001 })).kind
    ).toBe('invalid')
    expect(
      parseFrameLine(line({ type: 'stream.closing', reason: 'x', retryAfterMs: 1.5 })).kind
    ).toBe('invalid')
    expect(parseFrameLine(JSON.stringify({ schemaVersion: 2, type: 'ready' })).kind).toBe('unknown')
    expect(parseFrameLine(line({ type: 'future' })).kind).toBe('unknown')
    expect(parseFrameLine('{broken').kind).toBe('invalid')
    expect(
      parseFrameLine(line({ type: 'changed', keys: ['x'.repeat(MAX_FRAME_CHARS)] })).kind
    ).toBe('invalid')
  })
})
