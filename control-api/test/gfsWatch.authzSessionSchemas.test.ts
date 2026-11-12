import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { parseAuthzKey, parseSessionHint } from '../src/services/gfsWatch/notifySchemas.js'

// Accepted payloads are pinned against the real triggers in
// gfsWatch.authzSessionTriggers.realPostgres.integration.test.ts. This file
// holds what no trigger emits: forged or malformed payloads, which must parse
// to null, and the forms the schema tolerates beyond its producer.

const UID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('parseAuthzKey', () => {
  it('rejects forged and malformed keys', () => {
    for (const bad of [
      undefined,
      null,
      42,
      { kind: 'u' },
      '',
      'u:',
      'a:',
      'u:not-a-uuid',
      `x:${UID}`,
      `U:${UID}`,
      `u:${UID} `,
      `u:${UID},u:${UID}`,
      's:',
      's:user',
      's::',
      `s:${UID}`,
      `s:admin:${UID}`,
      `s:User:${UID}`,
      's:operators:',
      // A type glued to its id with no separator must not read as that type.
      's:hostX',
      's:contextX',
      's:operatorX',
      `s:user${UID}`,
    ]) {
      expect(parseAuthzKey(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('normalizes ids and keeps everything after the type as the subject id', () => {
    expect(parseAuthzKey(`u:${UID.toUpperCase()}`)).toEqual({ kind: 'u', id: UID })
    expect(parseAuthzKey(`a:${UID.replace(/-/g, '')}`)).toEqual({ kind: 'a', id: UID })
    expect(parseAuthzKey(`s:team:${UID.toUpperCase()}`)).toEqual({ kind: 's', t: 'team', id: UID })
    // A subject id containing ':' is not a uuid: valid, names nobody.
    expect(parseAuthzKey(`s:user:${UID}:x`)).toEqual({ kind: 's', t: 'user', id: null })
    expect(parseAuthzKey('s:user:')).toEqual({ kind: 's', t: 'user', id: null })
    // Types the watch does not act on by id ignore whatever id arrives.
    expect(parseAuthzKey('s:host:h:1')).toEqual({ kind: 's', t: 'host' })
    expect(parseAuthzKey('s:operator:')).toEqual({ kind: 's', t: 'operator' })
  })

  it('is total: never throws, and anything non-null starts with its kind', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string().map(s => `s:${s}`),
          fc.anything()
        ),
        p => {
          const parsed = parseAuthzKey(p)
          if (parsed !== null) expect(String(p).startsWith(`${parsed.kind}:`)).toBe(true)
        }
      ),
      { numRuns: 5_000 }
    )
  })
})

describe('parseSessionHint', () => {
  it('rejects forged and malformed hints', () => {
    for (const bad of [
      undefined,
      null,
      7,
      '',
      UID,
      `${UID}:active`,
      `${UID}:active:1:extra`,
      `${UID}:disabled:1`,
      `${UID}:Active:1`,
      `${UID}:active:0`,
      `${UID}:active:-1`,
      `${UID}:active:01`,
      `${UID}:active:1.5`,
      `${UID}:active: 1`,
      `${UID}:active:9007199254740993`,
      'not-a-uuid:active:1',
      `:retired:1`,
    ]) {
      expect(parseSessionHint(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('accepts every state the triggers emit, with a normalized id', () => {
    for (const state of ['active', 'retired', 'deleted'] as const) {
      expect(parseSessionHint(`${UID.toUpperCase()}:${state}:12`)).toEqual({
        uid: UID,
        state,
        version: 12,
      })
    }
  })

  it('is total', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.anything()), p => {
        parseSessionHint(p)
      }),
      { numRuns: 5_000 }
    )
  })
})
