import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import {
  DRIVE_NAME_RE,
  type GfsKey,
  MAX_DRIVES_PER_SET,
  MAX_KEYS_PER_SET,
  NO_PARENT,
  type Rid32,
  bit01,
  byKey,
  decodeKeys,
  drivesOf,
  encodeKeys,
  groupBy,
  keyDrive,
  keyKind,
  kindOf,
  natural,
  normUid,
  parentOf,
  parseKey,
  parseKeys,
  positiveGeneration,
  principalOf,
  rid,
  rids,
  toRid32,
  uuidOf,
} from '../src/services/gfsWatch/keys.js'
import {
  GFS_RESOURCE_CHANGED_CHANNEL,
  REVOCATION_CHANNELS,
  WATCH_CMD_PAYLOAD_LIMIT_BYTES,
  type WatchCmd,
  isRevocationChannel,
  parsePing,
  parseResourceChanged,
  parseWatchCmd,
  serializeWatchCmd,
} from '../src/services/gfsWatch/notifySchemas.js'

const HEX = '0123456789abcdef'
const hexString = (length: number, alphabet = HEX) =>
  fc
    .array(fc.constantFrom(...alphabet.split('')), { minLength: length, maxLength: length })
    .map(chars => chars.join(''))

const rid32Arb = hexString(32) as fc.Arbitrary<Rid32>
const mixedCaseHex = (length: number) => hexString(length, '0123456789abcdefABCDEF')
const driveArb = fc.oneof(
  fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
      minLength: 1,
      maxLength: 63,
    })
    .map(chars => chars.join('')),
  // Drive names that are Object.prototype members and pass the drive rule.
  fc.constantFrom('constructor', 'hasownproperty', 'valueof', 'tostring', 'isprototypeof')
)
// gfsc keeps its GFS_DRIVE_NAME rule private and the packages share no module,
// so the rule is read from gfsc's source.
function gfscDrivePattern(): RegExp {
  const path = fileURLToPath(new URL('../../gfs-controller/src/config.ts', import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'DRIVE_NAME_PATTERN') continue
      const init = decl.initializer
      if (!init || init.kind !== ts.SyntaxKind.RegularExpressionLiteral) {
        throw new Error(`${path}: DRIVE_NAME_PATTERN is no longer a regex literal`)
      }
      const text = init.getText(source)
      const end = text.lastIndexOf('/')
      return new RegExp(text.slice(1, end), text.slice(end + 1))
    }
  }
  throw new Error(`${path}: top-level const DRIVE_NAME_PATTERN not found`)
}

const keyArb = (drive: fc.Arbitrary<string>) =>
  fc
    .tuple(fc.constantFrom('file', 'dir'), drive, rid32Arb)
    .map(([kind, d, r]) => `${kind}:gfs://${d}/${r}` as GfsKey)

/** 1–64 canonical keys over at most two drives: every set `parseKeys` accepts. */
const keySetArb = fc
  .tuple(driveArb, driveArb)
  .chain(([d1, d2]) =>
    fc.uniqueArray(keyArb(fc.constantFrom(d1, d2)), { minLength: 1, maxLength: MAX_KEYS_PER_SET })
  )

const uuidFromHex = (h: string) =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`

describe('toRid32 / uuidOf / normUid', () => {
  it('maps every uuid form, in any case, to lowercase rid32 and back', () => {
    fc.assert(
      fc.property(mixedCaseHex(32), fc.boolean(), (hex, hyphenated) => {
        const input = hyphenated ? uuidFromHex(hex) : hex
        const r32 = toRid32(input)
        expect(r32).toBe(hex.toLowerCase())
        expect(r32).toMatch(/^[0-9a-f]{32}$/)
        expect(uuidOf(r32!)).toBe(uuidFromHex(hex).toLowerCase())
        expect(normUid(input)).toBe(uuidFromHex(hex).toLowerCase())
      }),
      { numRuns: 2000 }
    )
  })

  it('removes every hyphen of a uuid, not only the first', () => {
    expect(toRid32('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe('aaaaaaaabbbbccccddddeeeeeeeeeeee')
  })

  it('returns null, never throws, for anything that is not a uuid', () => {
    fc.assert(
      fc.property(fc.anything(), value => {
        const isUuid =
          typeof value === 'string' &&
          (/^[0-9a-fA-F]{32}$/.test(value) ||
            /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
              value
            ))
        expect(toRid32(value) === null).toBe(!isUuid)
        expect(normUid(value) === null).toBe(!isUuid)
      }),
      { numRuns: 5000 }
    )
    for (const bad of [
      '',
      ' '.repeat(32),
      `${'a'.repeat(31)}g`,
      `{${uuidFromHex('a'.repeat(32))}}`,
      `${uuidFromHex('a'.repeat(32))}\n`,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaaa',
      'aaaaaaaaa-aaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]) {
      expect(toRid32(bad)).toBeNull()
    }
  })

  it('rids maps rid32 to the uuid form Postgres binds', () => {
    fc.assert(
      fc.property(fc.uniqueArray(rid32Arb, { maxLength: 64 }), set => {
        expect(rids(new Set(set))).toEqual(set.map(r => uuidFromHex(r)))
      })
    )
  })
})

describe('scalar normalizers', () => {
  it('positiveGeneration accepts BIGINT text and safe positive numbers only', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), n => {
        expect(positiveGeneration(n)).toBe(n)
        expect(positiveGeneration(String(n))).toBe(n)
      }),
      { numRuns: 2000 }
    )
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '0',
      '-1',
      '+1',
      '01',
      ' 1',
      '1 ',
      '1.0',
      '1e3',
      '9007199254740993',
      '9223372036854775807',
      '',
      null,
      undefined,
      1n,
      {},
    ]) {
      expect(positiveGeneration(bad), String(bad)).toBeNull()
    }
  })

  it('natural accepts canonical non-negative decimal text only', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), n => {
        expect(natural(String(n))).toBe(n)
      })
    )
    for (const bad of ['', '-0', '00', '01', '1.0', ' 1', '9007199254740993', 0, null]) {
      expect(natural(bad), String(bad)).toBeNull()
    }
  })

  it('bit01, parentOf, kindOf and principalOf normalize exactly their domain', () => {
    expect([bit01('0'), bit01('1'), bit01('2'), bit01(1), bit01('')]).toEqual([
      0,
      1,
      null,
      null,
      null,
    ])
    expect(parentOf('')).toBe(NO_PARENT)
    expect(parentOf(uuidFromHex('A'.repeat(32)))).toBe('a'.repeat(32))
    expect(parentOf(null)).toBeNull()
    expect(parentOf('nope')).toBeNull()
    expect([kindOf('directory'), kindOf('file'), kindOf('dir'), kindOf(undefined)]).toEqual([
      'dir',
      'file',
      null,
      null,
    ])
    expect(principalOf({ kind: 'linked-admin' })).toBe('linked_operator')
    expect(principalOf({ kind: 'user-session' })).toBe('user')
    expect(principalOf(null)).toBeNull()
    expect(principalOf(undefined)).toBeNull()
  })
})

describe('canonical keys', () => {
  it('uses the same drive rule as gfsc', () => {
    const gfsc = gfscDrivePattern()
    expect({ source: DRIVE_NAME_RE.source, flags: DRIVE_NAME_RE.flags }).toEqual({
      source: gfsc.source,
      flags: gfsc.flags,
    })
  })

  it('accepts a drive in a key exactly when gfsc accepts it as GFS_DRIVE_NAME', () => {
    const gfsc = gfscDrivePattern()
    const nearDrive = fc
      .array(fc.constantFrom(...'az09-_A/.'.split('')), { minLength: 0, maxLength: 66 })
      .map(chars => chars.join(''))
    fc.assert(
      fc.property(
        fc.oneof(
          driveArb,
          nearDrive,
          fc.constantFrom('', 'a'.repeat(62), 'a'.repeat(63), 'a'.repeat(64))
        ),
        rid32Arb,
        (drive, rid) => {
          expect(parseKey(`file:gfs://${drive}/${rid}`) !== null, drive).toBe(gfsc.test(drive))
        }
      ),
      { numRuns: 2_000 }
    )
  })

  it('decomposes every canonical key and keyKind/keyDrive/rid agree with it', () => {
    fc.assert(
      fc.property(keyArb(driveArb), k => {
        const parsed = parseKey(k)
        expect(parsed).not.toBeNull()
        expect(keyKind(k)).toBe(parsed!.kind)
        expect(keyDrive(k)).toBe(parsed!.drive)
        expect(rid(k)).toBe(parsed!.rid32)
        expect(`${parsed!.kind}:gfs://${parsed!.drive}/${parsed!.rid32}`).toBe(k)
      }),
      { numRuns: 2000 }
    )
  })

  it('keyKind distinguishes dir from file so a view kind can be compared through kindOf', () => {
    const r32 = 'a'.repeat(32)
    const dirKey = `dir:gfs://main/${r32}` as GfsKey
    const fileKey = `file:gfs://main/${r32}` as GfsKey
    expect(kindOf('directory')).toBe(keyKind(dirKey))
    expect(kindOf('directory')).not.toBe(keyKind(fileKey))
    expect(kindOf('file')).toBe(keyKind(fileKey))
  })

  it('rejects every non-canonical form', () => {
    const r32 = 'a'.repeat(32)
    for (const bad of [
      `file:gfs://main/${r32.toUpperCase()}`,
      `file:gfs://main/${uuidFromHex(r32)}`,
      `file:gfs://main/report-${r32}`,
      `file:gfs://main/docs/${r32}`,
      `file:gfs://Main/${r32}`,
      `file:gfs://${'m'.repeat(64)}/${r32}`,
      `file:gfs:///${r32}`,
      `file:gfs://__proto__/${r32}`,
      `file:gfs://toString/${r32}`,
      `directory:gfs://main/${r32}`,
      `gfs://main/${r32}`,
      ` file:gfs://main/${r32}`,
      `file:gfs://main/${r32}\n`,
      `file:gfs://main/${r32}/`,
    ]) {
      expect(parseKey(bad), bad).toBeNull()
      expect(parseKeys(bad), bad).toBeNull()
    }
    fc.assert(
      fc.property(fc.string(), x => {
        const canonical = /^(file|dir):gfs:\/\/[a-z0-9-]{1,63}\/[0-9a-f]{32}$/.test(x)
        expect(parseKey(x) === null).toBe(!canonical)
      }),
      { numRuns: 5000 }
    )
  })

  it('parseKeys accepts the qs shapes, dedupes exactly and enforces the ceilings', () => {
    const r = (n: number) => n.toString(16).padStart(32, '0')
    const k = (n: number, drive = 'main') => `file:gfs://${drive}/${r(n)}`
    expect(parseKeys(undefined)).toEqual(new Set())
    expect(parseKeys(k(1))).toEqual(new Set([k(1)]))
    expect(parseKeys([k(1), k(1), k(2)])).toEqual(new Set([k(1), k(2)]))
    expect(parseKeys([k(1), 7])).toBeNull()
    expect(parseKeys({ 0: k(1) })).toBeNull()

    const sixtyFour = Array.from({ length: MAX_KEYS_PER_SET }, (_, i) => k(i))
    expect(parseKeys(sixtyFour)?.size).toBe(64)
    expect(parseKeys([...sixtyFour, ...sixtyFour])?.size).toBe(64)
    expect(parseKeys([...sixtyFour, k(64)])).toBeNull()

    expect(parseKeys([k(1, 'a'), k(2, 'b')])?.size).toBe(MAX_DRIVES_PER_SET)
    expect(parseKeys([k(1, 'a'), k(2, 'b'), k(3, 'c')])).toBeNull()
  })

  it('round-trips every accepted set through the JSON of the command', () => {
    fc.assert(
      fc.property(keySetArb, keys => {
        const set = parseKeys(keys)
        expect(set).not.toBeNull()
        expect(drivesOf(set!).size).toBeLessThanOrEqual(MAX_DRIVES_PER_SET)
        const decoded = decodeKeys(JSON.parse(JSON.stringify(encodeKeys(set!))))
        expect(decoded).toEqual(set)
      }),
      { numRuns: 2000 }
    )
  })

  it('encodes prototype-named drives into fresh arrays', () => {
    const r32 = 'b'.repeat(32)
    for (const drive of ['constructor', 'hasownproperty', 'valueof', 'tostring']) {
      const set = parseKeys([`file:gfs://${drive}/${r32}`, `dir:gfs://${drive}/${'c'.repeat(32)}`])!
      const encoded = encodeKeys(set)
      expect(Object.getPrototypeOf(encoded)).toBeNull()
      expect(encoded[drive]).toEqual([`f${r32}`, `d${'c'.repeat(32)}`])
      expect(decodeKeys(JSON.parse(JSON.stringify(encoded)))).toEqual(set)
    }
  })

  it('decodeKeys rejects any shape encodeKeys cannot produce, including __proto__', () => {
    const r32 = 'a'.repeat(32)
    for (const bad of [
      null,
      [],
      'main',
      { main: `f${r32}` },
      { main: [`x${r32}`] },
      { main: [`f${r32.toUpperCase()}`] },
      { main: [`f${r32}0`] },
      { Main: [`f${r32}`] },
      { main: [7] },
      JSON.parse(`{"__proto__": ["f${r32}"]}`),
    ]) {
      expect(decodeKeys(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('gfs_watch_cmd schema', () => {
  const cmdArb: fc.Arbitrary<WatchCmd> = fc.record({
    c: hexString(32),
    s: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    u: hexString(32).map(h => uuidOf(h as Rid32)),
    g: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    r: hexString(32).map(h => uuidOf(h as Rid32)),
    keys: keySetArb.map(keys => parseKeys(keys)!),
  })

  it('parses back exactly what its producer serialized', () => {
    fc.assert(
      fc.property(cmdArb, cmd => {
        expect(parseWatchCmd(serializeWatchCmd(cmd))).toEqual(cmd)
      }),
      { numRuns: 1000 }
    )
  })

  it('stays under the NOTIFY limit with 64 keys on two drives of the longest name', () => {
    const drives = ['a'.repeat(63), 'b'.repeat(63)]
    const keys = new Set(
      Array.from(
        { length: MAX_KEYS_PER_SET },
        (_, i) => `file:gfs://${drives[i % 2]}/${i.toString(16).padStart(32, 'f')}` as GfsKey
      )
    )
    const payload = serializeWatchCmd({
      c: 'f'.repeat(32),
      s: Number.MAX_SAFE_INTEGER,
      u: uuidFromHex('a'.repeat(32)) as WatchCmd['u'],
      g: Number.MAX_SAFE_INTEGER,
      r: uuidFromHex('b'.repeat(32)) as WatchCmd['r'],
      keys,
    })
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(WATCH_CMD_PAYLOAD_LIMIT_BYTES)
    expect(parseWatchCmd(payload)?.keys).toEqual(keys)
  })

  it('normalizes the user, the request id and a BIGINT-text generation', () => {
    const base = JSON.parse(
      serializeWatchCmd({
        c: 'a'.repeat(32),
        s: 1,
        u: uuidFromHex('a'.repeat(32)) as WatchCmd['u'],
        g: 5,
        r: uuidFromHex('b'.repeat(32)) as WatchCmd['r'],
        keys: new Set(),
      })
    )
    const parsed = parseWatchCmd(
      JSON.stringify({ ...base, u: 'A'.repeat(32), r: 'B'.repeat(32), g: '5', t: 'legacy-team' })
    )
    expect(parsed).toEqual({
      c: 'a'.repeat(32),
      s: 1,
      u: uuidFromHex('a'.repeat(32)),
      g: 5,
      r: uuidFromHex('b'.repeat(32)),
      keys: new Set(),
    })
    expect(parsed).not.toHaveProperty('t')
  })

  it('rejects every malformed field and never throws', () => {
    const valid = JSON.parse(
      serializeWatchCmd({
        c: 'a'.repeat(32),
        s: 3,
        u: uuidFromHex('a'.repeat(32)) as WatchCmd['u'],
        g: 2,
        r: uuidFromHex('b'.repeat(32)) as WatchCmd['r'],
        keys: parseKeys(`file:gfs://main/${'c'.repeat(32)}`)!,
      })
    )
    const r32 = 'd'.repeat(32)
    const tooMany = {
      main: Array.from({ length: 65 }, (_, i) => `f${i.toString(16).padStart(32, '0')}`),
    }
    for (const patch of [
      { c: 'A'.repeat(32) },
      { c: uuidFromHex('a'.repeat(32)) },
      { s: 0 },
      { s: 1.5 },
      { s: '3' },
      { s: Number.MAX_SAFE_INTEGER + 1 },
      { u: 'not-a-uuid' },
      { g: 0 },
      { g: '01' },
      { r: undefined },
      { k: tooMany },
      { k: { a: [`f${r32}`], b: [`f${r32}`], c: [`f${r32}`] } },
      { k: [] },
    ]) {
      expect(
        parseWatchCmd(JSON.stringify({ ...valid, ...patch })),
        JSON.stringify(patch)
      ).toBeNull()
    }
    fc.assert(
      fc.property(fc.anything(), value => {
        const asJson = (() => {
          try {
            return JSON.stringify(value)
          } catch {
            return undefined
          }
        })()
        expect(() => parseWatchCmd(value)).not.toThrow()
        expect(() => parseWatchCmd(asJson)).not.toThrow()
      })
    )
    expect(parseWatchCmd('{')).toBeNull()
    expect(parseWatchCmd('null')).toBeNull()
  })
})

describe('gfs_watch_ping and gfs_resource_changed schemas', () => {
  it('parsePing accepts the 32-hex instance id form only', () => {
    fc.assert(
      fc.property(
        hexString(32),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (instanceId, epoch, n) => {
          expect(parsePing(`${instanceId}:${epoch}:${n}`)).toEqual({ instanceId, epoch, n })
        }
      )
    )
    const id = 'a'.repeat(32)
    for (const bad of [
      `${uuidFromHex(id)}:1:0`,
      `${id.toUpperCase()}:1:0`,
      `${id}:0:0`,
      `${id}:1:-1`,
      `${id}:1`,
      `${id}:1:0:0`,
      null,
    ]) {
      expect(parsePing(bad), String(bad)).toBeNull()
    }
  })

  it('parseResourceChanged is total and rejects any field outside the trigger domain', () => {
    const uuid = uuidFromHex('a'.repeat(32))
    for (const bad of [
      `${uuid},,,1,0,i,extra`,
      `${uuid},,,1,0`,
      `${uuid},,,true,0,i`,
      `${uuid},,,1,2,i`,
      `${uuid},,,1,0,x`,
      `,,,1,0,i`,
      `${uuid},null,,1,0,u`,
      null,
    ]) {
      expect(parseResourceChanged(bad), String(bad)).toBeNull()
    }
    fc.assert(
      fc.property(fc.anything(), value => {
        expect(() => parseResourceChanged(value)).not.toThrow()
      })
    )
  })

  it('lists exactly the channels that carry revocations', () => {
    expect([...REVOCATION_CHANNELS].sort()).toEqual([
      'gfs_authz_changed',
      GFS_RESOURCE_CHANGED_CHANNEL,
      'gfs_watch_session',
    ])
    for (const channel of REVOCATION_CHANNELS) expect(isRevocationChannel(channel)).toBe(true)
    for (const channel of ['gfs_watch_ping', 'gfs_watch_cmd', 'entity_change_outbox', '']) {
      expect(isRevocationChannel(channel), channel).toBe(false)
    }
    expect(Object.isFrozen(REVOCATION_CHANNELS)).toBe(true)
    expect(() => (REVOCATION_CHANNELS as unknown as string[]).push('gfs_watch_ping')).toThrow()
    expect(isRevocationChannel('gfs_watch_ping')).toBe(false)
  })
})

describe('projection helpers', () => {
  it('groupBy keeps row order per key and drops rows whose key or value is null', () => {
    const rows = [
      { requested: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', ancestor: uuidFromHex('b'.repeat(32)) },
      { requested: 'a'.repeat(32), ancestor: uuidFromHex('c'.repeat(32)) },
      { requested: 'bad', ancestor: uuidFromHex('d'.repeat(32)) },
      { requested: 'a'.repeat(32), ancestor: 'bad' },
    ]
    const grouped = groupBy(
      rows,
      row => toRid32(row.requested),
      row => toRid32(row.ancestor)
    )
    expect([...grouped]).toEqual([['a'.repeat(32), ['b'.repeat(32), 'c'.repeat(32)]]])
    expect(grouped.get('a'.repeat(32) as Rid32)).toBeDefined()
  })

  it('byKey keeps the first row per normalized key and drops null keys', () => {
    const rows = [
      { id: 'A'.repeat(32), n: 1 },
      { id: uuidFromHex('a'.repeat(32)), n: 2 },
      { id: 'bad', n: 3 },
    ]
    const indexed = byKey(rows, row => normUid(row.id))
    expect([...indexed]).toEqual([[uuidFromHex('a'.repeat(32)), rows[0]]])
  })
})
