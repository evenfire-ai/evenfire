import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { ChatMessage, FinishReason, ToolCompletionResponse, ToolDefinition } from '../../core/types'
import * as wireNames from '../toolWireNames'
import {
  TOOL_NAME_ENVELOPES,
  ToolNameEnvelopeKey,
  ToolWireNameMap,
  fromWireResponse,
  toWireRequest,
  wireToolAlias,
} from '../toolWireNames'
import { ATLASSIAN_TOOLS, NOTION_TOOLS } from './fixtures/remoteMcpToolLists'
import serverNames from './fixtures/serverNames.json'

// Real slot names, as control-api's registry producer derives them (golden).
const registrySlot = (entryName: string): string => {
  const entry = serverNames.registry.find(e => e.entryName === entryName)
  if (!entry) throw new Error(`no registry slot for ${entryName} in serverNames.json`)
  return entry.name
}
const REMOTE_SERVER_NAMES = {
  notion: registrySlot('@evenfire/notion-remote'),
  atlassian: registrySlot('@evenfire/atlassian-remote'),
} as const

// ─── Independent oracle ─────────────────────────────────────────────────────
// The envelopes and the alias rule are written out here, not read from the
// module, so a drift in the module turns these tests red.

const LITERAL_ENVELOPES: Record<ToolNameEnvelopeKey, RegExp> = {
  W: /^[A-Za-z0-9_-]{1,64}$/,
  W_c: /^[A-Za-z0-9_-]{1,128}$/,
  W_v: /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/,
  W_g: /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
}
const ENVELOPE_KEYS: ToolNameEnvelopeKey[] = ['W', 'W_c', 'W_v', 'W_g']
const W_G = LITERAL_ENVELOPES.W_g
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

type Hash = (c: string) => string

function oracleHash(c: string): string {
  return createHash('sha256').update(Buffer.from(c, 'utf16le')).digest('hex').slice(0, 12)
}

function oracleServer(c: string): string | null {
  const i = c.indexOf('__')
  return i > 0 ? c.slice(0, i) : null
}

function oracleHead(c: string): { head: string; withPrefix: boolean } {
  const i = c.indexOf('__')
  const S = i > 0 ? c.slice(0, i) : null
  const T = i > 0 ? c.slice(i + 2) : c
  const sanitize = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, '_')
  const collapse = (x: string) => x.replace(/_{2,}/g, '_')
  if (S !== null && /^[a-z][a-z0-9-]*$/.test(S) && S.length <= 50) {
    return { head: S + '__' + sanitize(T), withPrefix: true }
  }
  const x = collapse(sanitize(c))
  return { head: /^[A-Za-z_]/.test(x) ? x : '_' + x, withPrefix: false }
}

/** cand_j(c); `j === null` is cand_⊥. */
function oracleCand(c: string, j: number | null, hash: Hash = oracleHash): string {
  const { head, withPrefix } = oracleHead(c)
  const s = j === null ? '' : '_' + j.toString(36)
  const raw = head.slice(0, 51 - s.length) + '_' + hash(c) + s
  return withPrefix ? raw : raw.replace(/_{2,}/g, '_')
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** P8 guard: the base alias of `c` is not taken by a reserved name or an earlier aliased name. */
function baseIsFree(c: string, set: string[], E: RegExp, hash: Hash = oracleHash): boolean {
  const base = oracleCand(c, null, hash)
  const unique = [...new Set(set)].sort(cmp)
  if (unique.some(x => E.test(x) && x === base)) return false
  return !unique.some(x => x < c && !E.test(x) && oracleCand(x, null, hash) === base)
}

// ─── Generators ─────────────────────────────────────────────────────────────

const CAPTURED_TOOL_NAMES = [...NOTION_TOOLS, ...ATLASSIAN_TOOLS].map(t => t.name)
const GOLDEN_CANONICALS = [
  ...NOTION_TOOLS.map(t => `${REMOTE_SERVER_NAMES.notion}__${t.name}`),
  ...ATLASSIAN_TOOLS.map(t => `${REMOTE_SERVER_NAMES.atlassian}__${t.name}`),
]
const NON_DNS_SERVERS = [
  'notion.v2',
  'my_srv',
  'srv___x',
  '1keychain',
  'a'.repeat(50) + '.' + 'b'.repeat(7),
]
// Same code-unit length, same sanitized head, equal under localeCompare.
const LOCALE_EQUAL_PAIRS: [string, string][] = [
  ['srv__' + 'a'.repeat(70) + '\u200Bb', 'srv__' + 'a'.repeat(70) + '\u200Cb'],
  ['my_srv__x\u200By', 'my_srv__x\u200Cy'],
]

const unitArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('a', 'Z', '0', '9', '_', '-', '.', ':', ' ') },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 0xffff }).map(n => String.fromCharCode(n)) },
  { weight: 1, arbitrary: fc.constantFrom('__', '\uD800', '\uDC00', '😀', '\u200B') }
)
const arbitraryName = fc.string({ unit: unitArb, minLength: 0, maxLength: 300 })
const goldenName = fc.constantFrom(...GOLDEN_CANONICALS)
const nonDnsName = fc
  .tuple(fc.constantFrom(...NON_DNS_SERVERS), fc.constantFrom(...CAPTURED_TOOL_NAMES, 'item_get'))
  .map(([s, t]) => `${s}__${t}`)
const hex12 = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'),
  minLength: 12,
  maxLength: 12,
})
const aliasShapedName = fc
  .tuple(fc.constantFrom('srv__get', 'mcp-a__b', 'x'), hex12)
  .map(([p, h]) => `${p}_${h}`)
const nameArb = fc.oneof(
  arbitraryName,
  goldenName,
  nonDnsName,
  aliasShapedName,
  fc.constantFrom(...LOCALE_EQUAL_PAIRS.flat(), '1keychain__item_get', 'file_read', '')
)

/**
 * Adds, for some names that are aliased under `E`, valid names equal to their
 * base alias and to the first collision suffixes — the set that would exhaust a
 * walk bounded by the aliased count, or shadow a canonical name if valid names
 * were not all reserved.
 */
function adversarialSet(E: RegExp, hash: Hash): fc.Arbitrary<string[]> {
  return fc
    .tuple(
      fc.array(nameArb, { maxLength: 20 }),
      fc.array(fc.nat({ max: 3 }), { maxLength: 4 }),
      fc.boolean()
    )
    .map(([names, depths, withPairs]) => {
      const out = [...names]
      if (withPairs) out.push(...LOCALE_EQUAL_PAIRS.flat())
      const aliased = out.filter(c => !E.test(c))
      depths.forEach((depth, i) => {
        if (aliased.length === 0) return
        const c = aliased[i % aliased.length]
        out.push(oracleCand(c, null, hash))
        for (let k = 0; k < depth; k++) out.push(oracleCand(c, k, hash))
      })
      return out
    })
}

// 16 distinct hashes only, so same-head names collide often.
const coarseHash: Hash = c => oracleHash(c)[0].repeat(12)
const HASHES: [string, Hash | undefined][] = [
  ['sha256', undefined],
  ['coarse', coarseHash],
]

function mapOf(set: string[], key: ToolNameEnvelopeKey, hash?: Hash): ToolWireNameMap {
  return new ToolWireNameMap(set, key, hash ? { hash } : undefined)
}

const RUNS = { numRuns: 200 }

// ─── T-W1 ───────────────────────────────────────────────────────────────────

describe('T-W1 · envelopes', () => {
  it('exports exactly the four literal envelopes, without flags', () => {
    expect(Object.keys(TOOL_NAME_ENVELOPES).sort()).toEqual([...ENVELOPE_KEYS].sort())
    for (const key of ENVELOPE_KEYS) {
      expect(TOOL_NAME_ENVELOPES[key].source).toBe(LITERAL_ENVELOPES[key].source)
      expect(TOOL_NAME_ENVELOPES[key].flags).toBe('')
    }
  })

  it('exports no other RegExp', () => {
    const exportedRegexps = Object.entries(wireNames).filter(([, v]) => v instanceof RegExp)
    expect(exportedRegexps).toEqual([])
  })
})

describe('T-W1 · control aliases', () => {
  it('reproduces the two control aliases literally', () => {
    expect(
      wireToolAlias('mcp-evenfire-atlassian-remote-u-338995f5__getJiraIssueRemoteIssueLinks', 'W_g')
    ).toBe('mcp-evenfire-atlassian-remote-u-338995f5__getJiraIs_e8dea3b5f0f1')
    expect(wireToolAlias('1keychain-connect-vault-integration-engineering__item_get', 'W_g')).toBe(
      '_1keychain-connect-vault-integration-engineering_it_10b118fcacd7'
    )
  })
})

describe.each(HASHES)('T-W1 · map properties (%s hash)', (_label, hash) => {
  for (const key of ENVELOPE_KEYS) {
    const E = LITERAL_ENVELOPES[key]
    const h = hash ?? oracleHash

    it(`P1/P2/P3/P3b/P5 under ${key}`, () => {
      fc.assert(
        fc.property(adversarialSet(E, h), set => {
          const map = mapOf(set, key, hash) // P3b: never throws
          const unique = [...new Set(set)]
          const wires = new Map<string, string>()
          for (const c of unique) {
            const w = map.toWire(c)
            if (E.test(c))
              expect(w).toBe(c) // P1
            else expect(W_G.test(w)).toBe(true) // P2
            expect(E.test(w)).toBe(true) // P2
            const prev = wires.get(w)
            expect(prev === undefined || prev === c).toBe(true) // P3
            wires.set(w, c)
            expect(map.fromWire(w)).toBe(c) // P5
            expect(map.fromWire(c)).toBe(c) // P5
          }
        }),
        RUNS
      )
    })

    it(`P3c: input order never changes the result under ${key}`, () => {
      fc.assert(
        fc.property(
          adversarialSet(E, h).chain(set =>
            fc.tuple(fc.constant(set), fc.shuffledSubarray(set, { minLength: set.length }))
          ),
          ([set, shuffled]) => {
            const a = mapOf(set, key, hash)
            const b = mapOf([...shuffled].reverse(), key, hash)
            for (const c of set) expect(b.toWire(c)).toBe(a.toWire(c))
          }
        ),
        RUNS
      )
    })

    it(`P3c: localeCompare-equal pairs resolve by code unit under ${key}`, () => {
      // A fixed hash makes each pair share its base, so only the order decides who gets it.
      const fixed: Hash = () => 'bbbbbbbbbbbb'
      for (const [x, y] of LOCALE_EQUAL_PAIRS) {
        expect(x.localeCompare(y)).toBe(0)
        expect(x < y).toBe(true)
        for (const pairHash of [hash, fixed]) {
          const a = mapOf([x, y], key, pairHash)
          const b = mapOf([y, x], key, pairHash)
          expect(b.toWire(x)).toBe(a.toWire(x))
          expect(b.toWire(y)).toBe(a.toWire(y))
          expect(a.toWire(x)).not.toBe(a.toWire(y))
        }
        const forced = mapOf([y, x], key, fixed)
        expect(forced.toWire(x)).toBe(oracleCand(x, null, fixed))
        expect(forced.toWire(y)).toBe(oracleCand(y, 0, fixed))
      }
    })

    it(`P8: the map sends wireToolAlias whenever the base is free under ${key}`, () => {
      fc.assert(
        fc.property(adversarialSet(E, h), set => {
          const map = mapOf(set, key, hash)
          for (const c of new Set(set)) {
            if (E.test(c)) {
              expect(map.toWire(c)).toBe(c)
            } else if (baseIsFree(c, set, E, h)) {
              const expected = hash ? oracleCand(c, null, h) : wireToolAlias(c, key)
              expect(map.toWire(c)).toBe(expected)
            }
          }
        }),
        RUNS
      )
    })
  }
})

describe('T-W1 · alias function properties', () => {
  for (const key of ENVELOPE_KEYS) {
    const E = LITERAL_ENVELOPES[key]

    it(`P4: idempotent, and a map of aliases is the identity, under ${key}`, () => {
      fc.assert(
        fc.property(fc.array(nameArb, { maxLength: 20 }), set => {
          for (const c of set) {
            const once = wireToolAlias(c, key)
            expect(wireToolAlias(once, key)).toBe(once)
          }
          const map = new ToolWireNameMap(set, key)
          const wires = [...new Set(set)].map(c => map.toWire(c))
          const again = new ToolWireNameMap(wires, key)
          for (const w of wires) expect(again.toWire(w)).toBe(w)
        }),
        RUNS
      )
    })

    it(`P6: a non-colliding name gets the same wire name in any request under ${key}`, () => {
      fc.assert(
        fc.property(
          nameArb,
          adversarialSet(E, oracleHash),
          adversarialSet(E, oracleHash),
          (c, a, b) => {
            const setA = [...a, c]
            const setB = [...b, c]
            fc.pre(baseIsFree(c, setA, E) && baseIsFree(c, setB, E))
            expect(new ToolWireNameMap(setA, key).toWire(c)).toBe(
              new ToolWireNameMap(setB, key).toWire(c)
            )
          }
        ),
        RUNS
      )
    })

    it(`P7: an alias only claims the callTool server segment under ${key}`, () => {
      fc.assert(
        fc.property(fc.array(nameArb, { maxLength: 20 }), set => {
          const map = new ToolWireNameMap(set, key)
          for (const c of new Set(set)) {
            const w = map.toWire(c)
            if (w === c) continue
            const i = w.indexOf('__')
            if (i < 0) continue
            const S = oracleServer(c)
            expect(w.slice(0, i)).toBe(S)
            expect(S !== null && /^[a-z][a-z0-9-]*$/.test(S) && S.length <= 50).toBe(true)
          }
        }),
        RUNS
      )
    })
  }

  it('P7: servers outside the prefix shape never produce `__`', () => {
    for (const s of NON_DNS_SERVERS.filter(x => x !== 'srv___x')) {
      const w = wireToolAlias(`${s}__${'t'.repeat(80)}`, 'W')
      expect(w.includes('__')).toBe(false)
    }
    // `srv___x` splits like callTool does: server `srv`, tool `_x…`.
    const w = wireToolAlias(`srv___x__${'t'.repeat(80)}`, 'W')
    expect(w.slice(0, w.indexOf('__'))).toBe('srv')
  })

  it('P6b: distinct lone surrogates give distinct base aliases', () => {
    const surrogate = fc.integer({ min: 0xd800, max: 0xdfff })
    fc.assert(
      fc.property(
        fc.string({ unit: unitArb, maxLength: 40 }),
        surrogate,
        surrogate,
        (prefix, a, b) => {
          fc.pre(a !== b)
          const x = `srv__${prefix}${String.fromCharCode(a)}`
          const y = `srv__${prefix}${String.fromCharCode(b)}`
          for (const key of ENVELOPE_KEYS) {
            expect(wireToolAlias(x, key)).not.toBe(wireToolAlias(y, key))
          }
        }
      ),
      RUNS
    )
  })
})

// ─── T-W1b · forced collisions ──────────────────────────────────────────────

describe('T-W1b · forced collisions with an injected hash', () => {
  const fixed: Hash = () => 'aaaaaaaaaaaa'
  const U = '1keychain-connect-vault-integration-engineering__item_get'

  it('the in-test cand_j oracle matches the fixed strings', () => {
    expect(oracleCand(U, null, fixed)).toBe(
      '_1keychain-connect-vault-integration-engineering_it_aaaaaaaaaaaa'
    )
    expect(oracleCand(U, 0, fixed)).toBe(
      '_1keychain-connect-vault-integration-engineering_aaaaaaaaaaaa_0'
    )
    expect(oracleCand(U, 36, fixed)).toBe(
      '_1keychain-connect-vault-integration-engineering_aaaaaaaaaaaa_10'
    )
  })

  it('(i) two names with the same base get the base and `_0`, in code-unit order', () => {
    const first = 'srv__' + 'a'.repeat(60) + '.b'
    const second = 'srv__' + 'a'.repeat(60) + ':b'
    expect(first < second).toBe(true)
    for (const names of [
      [first, second],
      [second, first],
    ]) {
      const map = new ToolWireNameMap(names, 'W', { hash: fixed })
      expect(map.toWire(first)).toBe(oracleCand(first, null, fixed))
      expect(map.toWire(second)).toBe(oracleCand(second, 0, fixed))
      expect(map.fromWire(map.toWire(first))).toBe(first)
      expect(map.fromWire(map.toWire(second))).toBe(second)
    }
  })

  it.each([3, 38])('(ii) N=%i with cand_⊥…cand_{N−3} reserved assigns cand_{N−2}', n => {
    const reserved = [oracleCand(U, null, fixed)]
    for (let k = 0; k <= n - 3; k++) reserved.push(oracleCand(U, k, fixed))
    const names = [U, ...reserved]
    expect(new Set(names).size).toBe(n)
    const map = new ToolWireNameMap(names, 'W_g', { hash: fixed })
    const expected = oracleCand(U, n - 2, fixed)
    if (n === 38) {
      expect(expected).toBe('_1keychain-connect-vault-integration-engineering_aaaaaaaaaaaa_10')
    }
    expect(map.toWire(U)).toBe(expected)
    expect(map.fromWire(expected)).toBe(U)
    for (const r of reserved) expect(map.toWire(r)).toBe(r)
  })

  it('rejects a hash outside 12 lowercase hex digits', () => {
    expect(() => new ToolWireNameMap([U], 'W_g', { hash: () => 'xyz' })).toThrow(TypeError)
  })
})

// ─── T-W7 · annotation ──────────────────────────────────────────────────────

function wireTool(name: string, description = 'D'): ToolDefinition {
  const tool: ToolDefinition = { name, description, parameters: {} }
  return toWireRequest([], [tool], 'W').tools[0]
}

function annotationOf(name: string): string {
  const desc = wireTool(name, '').description
  expect(desc.endsWith(') ')).toBe(true)
  return desc.slice(0, -1)
}

describe('T-W7 · description annotation', () => {
  it('(a) cuts T to 200 code points before escaping `"` and `\\`', () => {
    const T = 'q"w\\e'.repeat(200)
    const out = wireTool(`srv__${T}`)
    expect(out.description).toBe(`(MCP server: "srv"; tool: ${JSON.stringify(T.slice(0, 200))}) D`)
  })

  it('(b) keeps an emoji at the boundary whole', () => {
    const ann = annotationOf(`srv__${'a'.repeat(199)}😀b`)
    expect(ann).toBe(`(MCP server: "srv"; tool: "${'a'.repeat(199)}😀")`)
    expect(LONE_SURROGATE.test(ann)).toBe(false)
  })

  it('(c) replaces lone surrogates, in the middle and at the boundary, with U+FFFD', () => {
    const T = 'a'.repeat(10) + '\uD800' + 'a'.repeat(188) + '\uDC00' + 'zzz'
    const ann = annotationOf(`srv__${T}`)
    expect(ann).toBe(`(MCP server: "srv"; tool: "${'a'.repeat(10)}\uFFFD${'a'.repeat(188)}\uFFFD")`)
    expect(LONE_SURROGATE.test(ann)).toBe(false)
  })

  it('(d) turns controls into spaces, never `\\uXXXX`', () => {
    const ann = annotationOf(`srv__a\nb\u0000c\u2028d${'x'.repeat(70)}`)
    expect(ann).toContain(`"a b c d${'x'.repeat(70)}"`)
    expect(ann).not.toMatch(/\\u|\n/)
  })

  it('(e) cuts a 253-character server to 200 code points', () => {
    const S = ('a'.repeat(63) + '.').repeat(4).slice(0, 253)
    expect(S.length).toBe(253)
    const ann = annotationOf(`${S}__tool`)
    expect(ann).toBe(`(MCP server: ${JSON.stringify(S.slice(0, 200))}; tool: "tool")`)
  })

  it('(f) without `__` annotates the whole name', () => {
    const c = 'x'.repeat(70)
    expect(annotationOf(c)).toBe(`(tool: "${c}")`)
  })

  it('(g) captured tools that share a visible head carry distinct, complete T', () => {
    const tools = [
      ...NOTION_TOOLS.map(t => ({ server: REMOTE_SERVER_NAMES.notion, tool: t.name })),
      ...ATLASSIAN_TOOLS.map(t => ({ server: REMOTE_SERVER_NAMES.atlassian, tool: t.name })),
    ].map(({ server, tool }) => ({
      name: `${server}__${tool}`,
      description: 'D',
      parameters: {},
      server,
      tool,
    }))
    const { tools: wire } = toWireRequest([], tools, 'W')
    const byHead = new Map<string, { server: string; tool: string; description: string }[]>()
    wire.forEach((w, i) => {
      if (w.name === tools[i].name) return
      const head = w.name.replace(/_[0-9a-f]{12}$/, '')
      const group = byHead.get(head) ?? []
      group.push({ server: tools[i].server, tool: tools[i].tool, description: w.description })
      byHead.set(head, group)
    })
    const shared = [...byHead.values()].filter(g => g.length > 1)
    expect(shared.length).toBeGreaterThan(0)
    for (const group of shared) {
      const ts = new Set<string>()
      for (const { server, tool, description } of group) {
        expect(tool.length).toBeLessThanOrEqual(200)
        expect(description).toBe(
          `(MCP server: ${JSON.stringify(server)}; tool: ${JSON.stringify(tool)}) D`
        )
        ts.add(tool)
      }
      expect(ts.size).toBe(group.length)
    }
  })

  it('leaves a tool that fits the envelope untouched (same object)', () => {
    const tool: ToolDefinition = { name: 'srv__ok', description: 'D', parameters: {} }
    expect(toWireRequest([], [tool], 'W').tools[0]).toBe(tool)
  })

  it('bounds the annotation to 827 code units and 1627 UTF-8 bytes', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: unitArb, maxLength: 600 }),
        fc.string({ unit: unitArb, maxLength: 600 }),
        (S, T) => {
          const name = `${S}__${T}`
          fc.pre(!LITERAL_ENVELOPES.W.test(name))
          const ann = annotationOf(name)
          expect(ann.length).toBeLessThanOrEqual(827)
          expect(Buffer.byteLength(ann, 'utf8')).toBeLessThanOrEqual(1627)
          expect(LONE_SURROGATE.test(ann)).toBe(false)
        }
      ),
      { numRuns: 500 }
    )
  })
})

// ─── Request / response projection ──────────────────────────────────────────

describe('toWireRequest / fromWireResponse', () => {
  const long = `${REMOTE_SERVER_NAMES.notion}__notion-query-multiple-data-sources`
  const historyOnly = `${REMOTE_SERVER_NAMES.notion}__notion-link-meeting-note-to-calendar-event`

  it('aliases tools, assistant tool_calls and tool-message names, and resolves back', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: historyOnly, arguments: {} }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 't1', name: historyOnly },
      { role: 'tool', content: 'ok', tool_call_id: 't2' },
    ]
    const tools: ToolDefinition[] = [{ name: long, description: 'D', parameters: {} }]
    const req = toWireRequest(messages, tools, 'W')
    const wireHistory = req.messages[1].tool_calls?.[0].name as string
    expect(wireHistory).toBe(wireToolAlias(historyOnly, 'W'))
    expect(req.messages[2].name).toBe(wireHistory)
    expect(req.messages[3]).toBe(messages[3])
    expect(req.names.fromWire(wireHistory)).toBe(historyOnly)
    expect(messages[1].tool_calls?.[0].name).toBe(historyOnly)

    const resp: ToolCompletionResponse = {
      content: null,
      tool_calls: [
        { id: 'a', name: req.tools[0].name, arguments: {} },
        { id: 'b', name: long, arguments: {} },
        { id: 'c', name: 'inventado_xyz', arguments: {} },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      finish_reason: FinishReason.ToolUse,
    }
    const back = fromWireResponse(resp, req.names)
    expect(back.tool_calls?.map(tc => tc.name)).toEqual([long, long, 'inventado_xyz'])
  })

  // Each history source alone must enter the set. The tool sent is a real name
  // equal to the base alias of the history name: if that history name were left
  // out, it would be sent under the tool's own name.
  describe('each history source alone enters the name set', () => {
    const shadow = wireToolAlias(historyOnly, 'W')
    const tools: ToolDefinition[] = [{ name: shadow, description: 'D', parameters: {} }]

    function expectDistinctAndResolved(req: ReturnType<typeof toWireRequest>, wire: string) {
      expect(req.tools[0].name).toBe(shadow)
      expect(wire).not.toBe(shadow)
      expect(wire).toMatch(LITERAL_ENVELOPES.W)
      expect(req.names.fromWire(wire)).toBe(historyOnly)
      expect(req.names.fromWire(shadow)).toBe(shadow)
    }

    it('an assistant tool_call whose tool message carries no name', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't1', name: historyOnly, arguments: {} }],
        },
        { role: 'tool', content: 'ok', tool_call_id: 't1' },
      ]
      const req = toWireRequest(messages, tools, 'W')
      expectDistinctAndResolved(req, req.messages[1].tool_calls?.[0].name as string)
    })

    it('an orphan tool message with a long name, outside tool_calls and tools[]', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'ok', tool_call_id: 'gone', name: historyOnly },
      ]
      const req = toWireRequest(messages, tools, 'W')
      expectDistinctAndResolved(req, req.messages[1].name as string)
    })
  })
})
