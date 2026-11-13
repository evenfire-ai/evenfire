import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { GFS_WATCH_MAX_KEYS } from '@constants/gfsWatch'
import { parseGfsUri } from '../../../../src/gfs/uriHandler'
import { canonList, canonicalKey, trunc64 } from '../../../../src/gfs/watchProtocol'
import {
  buildGfsWatchKeys,
  gfsRidOfResourceId,
  gfsWatchKey,
  parseGfsWatchKey,
} from '../gfsWatchKeys'

const hex = fc.constantFrom(...'0123456789abcdef'.split(''))
const rid = fc.string({ unit: hex, minLength: 32, maxLength: 32 })
const drive = fc.oneof(
  fc.constantFrom('main', 'd1', 'drive-2'),
  fc.string({ unit: fc.constantFrom('a', 'Z', '-', '_', '9', '.'), minLength: 0, maxLength: 70 })
)
const segment = fc.oneof(
  rid,
  rid.map(r => `report-${r}`),
  rid.map(r => `Report-${r.toUpperCase()}`),
  fc.string({ unit: fc.constantFrom('a', 'b', '-', '1', 'F', ' '), minLength: 0, maxLength: 40 })
)
const gfsUri = fc
  .tuple(
    fc.constantFrom('gfs://', 'gfs:///', 'http://', ''),
    drive,
    fc.array(segment, { minLength: 0, maxLength: 4 }),
    fc.boolean()
  )
  .map(
    ([scheme, d, path, trailingSlash]) =>
      `${scheme}${[d, ...path].join('/')}${trailingSlash ? '/' : ''}`
  )
const kind = fc.constantFrom('file' as const, 'dir' as const)

/** What the watch keys a URI under, from the resolver grammar and main's key check. */
function expectedKey(k: 'file' | 'dir', uri: string): string | null {
  let parsed
  try {
    parsed = parseGfsUri(uri)
  } catch {
    return null
  }
  if (!parsed.rid) return null
  return canonicalKey(`${k}:gfs://${parsed.drive}/${parsed.rid}`)
}

describe('gfsWatchKey', () => {
  it('keys a URI exactly as the resolver grammar identifies it and main accepts it', () => {
    fc.assert(
      fc.property(kind, gfsUri, (k, uri) => {
        const key = gfsWatchKey(k, uri)
        expect(key).toBe(expectedKey(k, uri))
        if (key !== null) expect(canonicalKey(key)).toBe(key)
      }),
      { numRuns: 20_000 }
    )
  })

  it('keys the identity and the human form of one resource alike, and skips a by-path URI', () => {
    const r = 'c'.repeat(32)
    expect(gfsWatchKey('file', `gfs://main/${r}`)).toBe(`file:gfs://main/${r}`)
    expect(gfsWatchKey('file', `gfs://main/docs/plan-${r}`)).toBe(`file:gfs://main/${r}`)
    expect(gfsWatchKey('dir', 'gfs://main/docs/plan')).toBeNull()
    expect(gfsWatchKey('dir', null)).toBeNull()
  })

  it('parses back what it builds', () => {
    fc.assert(
      fc.property(kind, gfsUri, (k, uri) => {
        const key = gfsWatchKey(k, uri)
        if (key === null) return
        const parts = parseGfsWatchKey(key)
        expect(parts && `${parts.kind}:gfs://${parts.drive}/${parts.rid}`).toBe(key)
      })
    )
  })

  it('maps a resource id to the rid its URI carries', () => {
    expect(gfsRidOfResourceId('6F1C2A3B-4D5E-4F60-8A7B-1C2D3E4F5A6B')).toBe(
      '6f1c2a3b4d5e4f608a7b1c2d3e4f5a6b'
    )
  })
})

describe('buildGfsWatchKeys', () => {
  it('equals what main keeps of the same prioritized list', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(kind, gfsUri), { maxLength: 90 }), entries => {
        const sources = entries.map(([k, uri]) => ({ kind: k, uri }))
        const keys = buildGfsWatchKeys(sources)
        const mainView = trunc64(canonList(sources.map(s => gfsWatchKey(s.kind, s.uri))))
        expect(keys).toEqual(mainView)
        expect(keys.length).toBeLessThanOrEqual(GFS_WATCH_MAX_KEYS)
      }),
      { numRuns: 5_000 }
    )
  })

  it('keeps the active preview and the current folder when the sidebar overflows the cap', () => {
    const r = (n: number) => n.toString(16).padStart(32, '0')
    const keys = buildGfsWatchKeys([
      { kind: 'file', uri: `gfs://main/${r(1)}` },
      { kind: 'file', uri: `gfs://main/${r(2)}` },
      { kind: 'dir', uri: `gfs://main/${r(3)}` },
      ...Array.from({ length: 100 }, (_, i) => ({
        kind: 'dir' as const,
        uri: `gfs://main/${r(100 + i)}`,
      })),
    ])
    expect(keys).toHaveLength(64)
    expect(keys.slice(0, 4)).toEqual([
      `file:gfs://main/${r(1)}`,
      `file:gfs://main/${r(2)}`,
      `dir:gfs://main/${r(3)}`,
      `dir:gfs://main/${r(100)}`,
    ])
    expect(keys.at(-1)).toBe(`dir:gfs://main/${r(160)}`)
  })
})
