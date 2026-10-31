/**
 * The auto-enable inputs `mapCatalogToProviders` derives from a catalog entry
 * (`text_output`, `tool_call`, `catalog_status`, `cost`, `release_date`, the
 * control-char guard on `display_name`) and the eligibility predicate over them.
 *
 * T1: entries come from the captured live catalog (the vendored snapshot does
 * not carry these fields) and are chosen with predicates, never by naming ids.
 * Sanitization cases alter ONLY the field under test on a real entry.
 * T4: assertions are on the DiscoveredModel the mapper produces.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../src/data/modelsDevSnapshot.js'
import {
  type DiscoveredModel,
  PROVIDER_KEY_MAP,
  type RawModelsDevModel,
  autoEnableRejection,
  isAutoEnableEligible,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { referenceAutoEnableRules } from './helpers/autoEnableReference.js'
import {
  LIVE_MODELS_DEV_CATALOG,
  type LiveCatalogEntry,
  catalogSize,
  liveCatalogEntries,
  pickLiveModels,
  singleModelCatalog,
} from './helpers/modelsDevFixtures.js'

/** Map one entry through the real mapper; `undefined` if the mapper skips it. */
function mapOne(entry: LiveCatalogEntry, raw: RawModelsDevModel): DiscoveredModel | undefined {
  return mapCatalogToProviders(singleModelCatalog(entry.key, entry.rawId, raw))[entry.providerId][0]
}

/** Map `entry` with only `field` replaced (or removed, for `undefined`). */
function mapWith<K extends keyof RawModelsDevModel>(
  entry: LiveCatalogEntry,
  field: K,
  value: RawModelsDevModel[K] | undefined
): DiscoveredModel {
  const raw: RawModelsDevModel = { ...entry.raw }
  if (value === undefined) delete raw[field]
  else raw[field] = value
  const mapped = mapOne(entry, raw)
  if (!mapped) throw new Error(`mapper skipped ${entry.key}/${entry.rawId}`)
  return mapped
}

function rawCost(entry: LiveCatalogEntry): Record<string, unknown> {
  return entry.raw.cost as Record<string, unknown>
}

function hasCostKeys(entry: LiveCatalogEntry, keys: string[]): boolean {
  const cost = entry.raw.cost
  if (!cost || typeof cost !== 'object') return false
  return keys.every(k => typeof (cost as Record<string, unknown>)[k] === 'number')
}

/** A live entry the predicate fully accepts — the baseline every negative case alters. */
const [ELIGIBLE] = pickLiveModels(e => isAutoEnableEligible(e.discovered))
/** A priced entry carrying all four flat components. */
const [FULLY_PRICED] = pickLiveModels(e =>
  hasCostKeys(e, ['input', 'output', 'cache_read', 'cache_write'])
)

describe('live fixture', () => {
  it('covers every mapped provider and the mapper keeps every entry', () => {
    expect(Object.keys(LIVE_MODELS_DEV_CATALOG)).toHaveLength(
      new Set(Object.values(PROVIDER_KEY_MAP)).size
    )
    expect(liveCatalogEntries()).toHaveLength(catalogSize(LIVE_MODELS_DEV_CATALOG))
  })
})

describe('mapCatalogToProviders — auto-enable fields from the live catalog', () => {
  it('reads cost components verbatim when all four are present', () => {
    const cost = rawCost(FULLY_PRICED)
    expect(FULLY_PRICED.discovered.cost).toEqual({
      input: cost.input,
      output: cost.output,
      cache_read: cost.cache_read,
      cache_write: cost.cache_write,
    })
  })

  it('defaults missing cache components to 0, never voiding the price', () => {
    const [entry] = pickLiveModels(
      e => hasCostKeys(e, ['input', 'output']) && !hasCostKeys(e, ['cache_read'])
    )
    const cost = rawCost(entry)
    expect(entry.discovered.cost).toEqual({
      input: cost.input,
      output: cost.output,
      cache_read: 0,
      cache_write: 0,
    })
  })

  it('ignores tiered pricing next to the flat components', () => {
    // The live fixture is trimmed to the four flat keys, so a tier is put back
    // the way api.json carries it.
    const tiered = { ...rawCost(FULLY_PRICED), context_over_200k: { input: 6, output: 22.5 } }
    expect(mapWith(FULLY_PRICED, 'cost', tiered).cost).toEqual(FULLY_PRICED.discovered.cost)
  })

  it('leaves an entry without cost unpriced', () => {
    const [entry] = pickLiveModels(e => e.raw.cost === undefined)
    expect(entry.discovered.cost).toBeNull()
  })

  it('keeps a legitimate zero price as 0', () => {
    const [entry] = pickLiveModels(
      e => hasCostKeys(e, ['input', 'output']) && rawCost(e).input === 0 && rawCost(e).output === 0
    )
    expect(entry.discovered.cost).toMatchObject({ input: 0, output: 0 })
  })

  it.each(['deprecated', 'alpha', 'beta'] as const)('carries status %s', status => {
    const [entry] = pickLiveModels(e => e.raw.status === status)
    expect(entry.discovered.catalog_status).toBe(status)
    expect(isAutoEnableEligible(entry.discovered)).toBe(false)
  })

  it('maps an absent status to null', () => {
    const [entry] = pickLiveModels(e => e.raw.status === undefined)
    expect(entry.discovered.catalog_status).toBeNull()
  })

  it('reads tool_call true and false', () => {
    const [yes] = pickLiveModels(e => e.raw.tool_call === true)
    const [no] = pickLiveModels(e => e.raw.tool_call === false)
    expect(yes.discovered.tool_call).toBe(true)
    expect(no.discovered.tool_call).toBe(false)
  })

  it('reads text output only when the output modalities include text', () => {
    const [textAndMore] = pickLiveModels(e => {
      const out = e.raw.modalities?.output
      return Array.isArray(out) && out.includes('text') && out.length > 1
    })
    const [noText] = pickLiveModels(e => {
      const out = e.raw.modalities?.output
      return Array.isArray(out) && !out.includes('text')
    })
    expect(textAndMore.discovered.text_output).toBe(true)
    expect(noText.discovered.text_output).toBe(false)
    expect(autoEnableRejection(noText.discovered)).toBe('no_text_output')
  })

  it('keeps both release_date shapes the catalog emits', () => {
    const [day] = pickLiveModels(
      e => typeof e.raw.release_date === 'string' && e.raw.release_date.length === 10
    )
    const [month] = pickLiveModels(
      e => typeof e.raw.release_date === 'string' && e.raw.release_date.length === 7
    )
    expect(day.discovered.release_date).toBe(day.raw.release_date)
    expect(month.discovered.release_date).toBe(month.raw.release_date)
  })
})

describe('mapCatalogToProviders — out-of-domain catalog values', () => {
  const costWith = (patch: Record<string, unknown>) => ({ ...rawCost(FULLY_PRICED), ...patch })
  const costWithout = (key: string) => {
    const cost = { ...rawCost(FULLY_PRICED) }
    delete cost[key]
    return cost
  }

  it.each([
    ['a negative component', costWith({ input: -0.5 })],
    ['a tiny negative component that rounds to -0', costWith({ input: -1e-10 })],
    ['NaN', costWith({ output: Number.NaN })],
    ['Infinity', costWith({ cache_read: Number.POSITIVE_INFINITY })],
    ['a value at the NUMERIC(20,8) bound', costWith({ input: 1e12 })],
    ['a non-numeric cache component', costWith({ cache_write: '1.25' })],
    ['a null cache component', costWith({ cache_read: null })],
    ['a missing input', costWithout('input')],
    ['a missing output', costWithout('output')],
    ['a cost that is not an object', 'free'],
    ['a cost that is an array', [1, 2]],
  ])('leaves the model unpriced for %s', (_label, cost) => {
    const mapped = mapWith(FULLY_PRICED, 'cost', cost)
    expect(mapped.model_id).toBe(FULLY_PRICED.discovered.model_id)
    expect(mapped.cost).toBeNull()
  })

  it.each(['cache_read', 'cache_write'])('defaults a missing %s to 0', key => {
    const mapped = mapWith(FULLY_PRICED, 'cost', costWithout(key))
    expect(mapped.cost).toEqual({ ...FULLY_PRICED.discovered.cost, [key]: 0 })
  })

  it('rounds components to 8 decimals and keeps values just under the bound', () => {
    const mapped = mapWith(
      FULLY_PRICED,
      'cost',
      costWith({ input: 0.123456789, output: 999_999_999_999.5 })
    )
    expect(mapped.cost).toMatchObject({ input: 0.12345679, output: 999_999_999_999.5 })
  })

  it.each([['retired'], ['Deprecated'], [42], [null], [['deprecated']]])(
    'stores an unknown status %j as null, and the entry is no longer eligible',
    status => {
      const mapped = mapWith(ELIGIBLE, 'status', status)
      expect(mapped.catalog_status).toBeNull()
      expect(mapped.status_present).toBe(true)
      expect(autoEnableRejection(mapped)).toBe('status')
    }
  )

  it('keeps an entry without status eligible', () => {
    const mapped = mapWith(ELIGIBLE, 'status', undefined)
    expect(mapped.status_present).toBe(false)
    expect(isAutoEnableEligible(mapped)).toBe(true)
  })

  it.each([['\u0000'], ['\u0007'], ['\u007f'], ['\n']])(
    'drops a display_name containing control char %j but keeps the model',
    ch => {
      const mapped = mapWith(ELIGIBLE, 'name', `Model${ch}Name`)
      expect(mapped.model_id).toBe(ELIGIBLE.discovered.model_id)
      expect(mapped).not.toHaveProperty('display_name')
    }
  )

  it.each([['2025/01/01'], ['2025-1-1'], ['yesterday'], [20250101], [null]])(
    'omits a release_date shaped %j',
    value => {
      expect(mapWith(ELIGIBLE, 'release_date', value)).not.toHaveProperty('release_date')
    }
  )

  it.each([['true'], [1], [null]])('reads tool_call %j as false', value => {
    const mapped = mapWith(ELIGIBLE, 'tool_call', value)
    expect(mapped.tool_call).toBe(false)
    expect(autoEnableRejection(mapped)).toBe('no_tool_call')
  })

  it.each([[['Text']], [['text', 1]], ['text'], [[]], [null]])(
    'reads output modalities %j as no text output',
    output => {
      const mapped = mapWith(ELIGIBLE, 'modalities', { ...ELIGIBLE.raw.modalities, output })
      expect(mapped.text_output).toBe(false)
      expect(autoEnableRejection(mapped)).toBe('no_text_output')
    }
  )
})

describe('isAutoEnableEligible / autoEnableRejection', () => {
  const STATUSES = new Set(['deprecated', 'alpha', 'beta'])

  const referenceRules = referenceAutoEnableRules

  const liveIds = liveCatalogEntries().map(e => e.rawId)
  const anyJson = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string()
  )
  const rawEntry = fc.record(
    {
      id: fc.oneof(fc.constantFrom(...liveIds), fc.string({ minLength: 1, maxLength: 40 })),
      tool_call: fc.oneof(fc.constant(true), fc.constant(false), anyJson),
      status: fc.oneof(
        fc.constantFrom('deprecated', 'alpha', 'beta', 'retired', 'Deprecated'),
        anyJson
      ),
      modalities: fc.record(
        {
          output: fc.oneof(
            fc.array(fc.constantFrom('text', 'image', 'audio', 'video', 'Text')),
            fc.array(anyJson, { maxLength: 3 }),
            anyJson
          ),
        },
        { requiredKeys: [] }
      ),
    },
    { requiredKeys: ['id'] }
  )

  it('eligible ⇔ E1 ∧ E2 ∧ E3 ∧ E4, and the rejection names the first failing rule', () => {
    fc.assert(
      fc.property(rawEntry, raw => {
        const [entry] = liveCatalogEntries()
        const mapped = mapOne(entry, raw as RawModelsDevModel)
        fc.pre(mapped !== undefined)
        const rules = referenceRules(raw as RawModelsDevModel, mapped!.model_id)
        const eligible = rules.textOutput && rules.toolCall && rules.statusOk && rules.runnable
        expect(isAutoEnableEligible(mapped!)).toBe(eligible)
        const expectedRejection = !rules.textOutput
          ? 'no_text_output'
          : !rules.toolCall
            ? 'no_tool_call'
            : !rules.statusOk
              ? 'status'
              : !rules.runnable
                ? 'not_runnable'
                : null
        expect(autoEnableRejection(mapped!)).toBe(expectedRejection)
      }),
      { numRuns: 5000 }
    )
  })

  it('over the live catalog: every rule rejects something and only clean entries pass', () => {
    const counts = new Map<string, number>()
    for (const { raw, discovered } of liveCatalogEntries()) {
      const rejection = autoEnableRejection(discovered)
      counts.set(String(rejection), (counts.get(String(rejection)) ?? 0) + 1)
      const rules = referenceRules(raw, discovered.model_id)
      expect(rejection === null).toBe(
        rules.textOutput && rules.toolCall && rules.statusOk && rules.runnable
      )
      if (typeof raw.status === 'string' && STATUSES.has(raw.status)) {
        expect(isAutoEnableEligible(discovered)).toBe(false)
      }
    }
    for (const reason of ['null', 'no_text_output', 'no_tool_call', 'status', 'not_runnable']) {
      expect(counts.get(reason) ?? 0).toBeGreaterThan(0)
    }
  })

  it('never makes a vendored snapshot model eligible (the snapshot carries none of the inputs)', () => {
    const all = Object.values(mapCatalogToProviders(VENDORED_MODELS_DEV_SNAPSHOT)).flat()
    expect(all.length).toBeGreaterThan(0)
    for (const m of all) {
      expect(m).toMatchObject({
        text_output: false,
        tool_call: false,
        catalog_status: null,
        cost: null,
      })
      expect(isAutoEnableEligible(m)).toBe(false)
    }
  })
})
