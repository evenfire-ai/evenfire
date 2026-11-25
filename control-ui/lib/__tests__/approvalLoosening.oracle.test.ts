/**
 * Oracle for the loosening function (spec §6.6, §7 A6 "Loosening oracle").
 *
 * The oracle is mcp-host's recorded behaviour,
 * mcp-host/test/fixtures/wire/mcp-host-approval-asks.json. mcp-host's producer
 * test (mcp-host/src/core/approval/__tests__/approvalProducerFixtures.test.ts)
 * computes it with the real gate controller, `decideApproval` and
 * `effectiveApprovalMode`. Per tool and context, it says whether every call of
 * the tool shows a card. This test reads it with node:fs, because control-ui
 * never imports mcp-host code that pulls npm packages.
 *
 * How the table is read:
 * - Key fields are in `keys` order, and "*" matches every value of its field.
 *   Each tool's entries answer every full context exactly once (checked below).
 * - Host facts are held fixed (Ruling 32(b)):
 *   - the ceiling, which the function receives;
 *   - `stateless` and `allowStatelessCron`, which it does not.
 * - A context counts under a ceiling only if its effectiveMode can occur under
 *   that ceiling (the ceiling filter, a controller dispatch note):
 *   - manual allows manual;
 *   - auto allows manual and auto;
 *   - allow_all allows all three.
 *   A key whose effectiveMode is "*" (cron_manage) applies under each ceiling.
 * - Per-call fields are unioned: effectiveMode (within the ceiling),
 *   channelType, cronFired and judge.
 * - A change of tools.<name> loosens for a Host when some counted context asks
 *   before the change and not after it.
 * - cron_manage is recorded as "every action asks". Ruling 19's producer test
 *   pins that every per-action loosening is also a recorded loosening, so the
 *   collapse loses none for an override change.
 *
 * Left out: clerum__tool_call, the only tool on TOOL_PARITY_EXCLUSIONS. Its
 * rows are the gate's answer for the bridge name, which production never
 * consults: mcp-host rewrites a bridge call to its target before the gate
 * (resolveBridgeCall in mcp-host/src/core/orchestration/toolUseLoopToolBatch.ts).
 * The rows therefore describe a card production never shows.
 *
 * Paths are independent. The asks key has no field for another tool's
 * override, so a tool's answer never depends on one, and the items of a
 * multi-path save are the union of its single-path items (spec A6).
 *
 * One cross-tool effect is registration, not asking (Ruling 21):
 * - On a Host with a GFS download store, tools.shell_exec: false unregisters
 *   clerum__gfs_download. That tightens: a call that cannot happen neither
 *   asks nor runs.
 * - The reverse, shell_exec Skip → Default, registers the never-asking
 *   download tool again. Loosening is defined over calls that can happen both
 *   before and after a change, so this is a known effect outside it.
 * Neither is an item.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  NATIVE_TOOLS,
  TOOL_PARITY_EXCLUSIONS,
} from '../../components/HostApprovalSection/constants'
import {
  LOOSENING_RULES,
  type LooseningItem,
  TOOL_LOOSENING_EXCEPTIONS,
  looseningItems,
  looseningItemsConfirmed,
  sameLooseningItems,
} from '../approvalLoosening'

type Ceiling = 'manual' | 'auto' | 'allow_all'
type Override = 'true' | 'false' | 'absent'
type Flag = 'false' | 'true'
type HostFacts = { ceiling: Ceiling; stateless: Flag; allowStatelessCron: Flag }
type Case = { tool: string; from: Override; to: Override; host: HostFacts }
type Outcome = Case & { items: LooseningItem[]; witness: string | null }

const ASKS_FILE = resolve(
  __dirname,
  '../../../mcp-host/test/fixtures/wire/mcp-host-approval-asks.json'
)
const TABLE = JSON.parse(readFileSync(ASKS_FILE, 'utf8')) as {
  keys: string[]
  asks: Record<string, Record<string, boolean>>
}

/** Every value each key field takes, in key order, as the producer test records them. */
const FIELD_VALUES: Record<string, readonly string[]> = {
  effectiveMode: ['manual', 'auto', 'allow_all'],
  override: ['true', 'false', 'absent'],
  channelType: ['rpc', 'telegram', 'slack', 'teams', 'email'],
  cronFired: ['false', 'true'],
  stateless: ['false', 'true'],
  allowStatelessCron: ['false', 'true'],
  judge: ['false', 'true'],
}
const KEY_FIELDS = Object.keys(FIELD_VALUES)
const FULL_CONTEXTS = KEY_FIELDS.reduce((count, field) => count * FIELD_VALUES[field].length, 1)

const CEILINGS: readonly Ceiling[] = ['manual', 'auto', 'allow_all']
const MODES_UNDER: Record<Ceiling, readonly string[]> = {
  manual: ['manual'],
  auto: ['manual', 'auto'],
  allow_all: ['manual', 'auto', 'allow_all'],
}
const OVERRIDES: readonly Override[] = ['true', 'false', 'absent']
const FLAGS: readonly Flag[] = ['false', 'true']
const HOSTS: readonly HostFacts[] = CEILINGS.flatMap(ceiling =>
  FLAGS.flatMap(stateless =>
    FLAGS.map(allowStatelessCron => ({ ceiling, stateless, allowStatelessCron }))
  )
)

/** The table's stand-ins for a custom row and for an MCP tool name (its `_source.notes`). */
const CUSTOM_PROBE = 'custom_tool'
const MCP_PROBE = 'server__tool'
const ORACLE_EXCLUDED = new Set(TOOL_PARITY_EXCLUSIONS.map(entry => entry.name))
const ORACLE_TOOLS = Object.keys(TABLE.asks)
  .filter(name => !ORACLE_EXCLUDED.has(name))
  .sort()

/** Each tool's answer per full context key, and every way the table fails to be a cover. */
function expandTable(): { answers: Map<string, Map<string, boolean>>; problems: string[] } {
  const answers = new Map<string, Map<string, boolean>>()
  const problems: string[] = []
  for (const [tool, entries] of Object.entries(TABLE.asks)) {
    const full = new Map<string, boolean>()
    for (const [key, asks] of Object.entries(entries)) {
      const parts = key.split('|')
      if (parts.length !== KEY_FIELDS.length) {
        problems.push(`${tool}: ${key} has ${parts.length} fields`)
        continue
      }
      let combos: string[][] = [[]]
      parts.forEach((part, index) => {
        const domain = FIELD_VALUES[KEY_FIELDS[index]]
        if (part !== '*' && !domain.includes(part)) {
          problems.push(`${tool}: ${key} has ${KEY_FIELDS[index]}=${part}, not one of ${domain}`)
        }
        const values = part === '*' ? domain : [part]
        combos = combos.flatMap(combo => values.map(value => [...combo, value]))
      })
      for (const combo of combos) {
        const fullKey = combo.join('|')
        if (full.has(fullKey)) problems.push(`${tool}: ${fullKey} matches two entries`)
        full.set(fullKey, asks)
      }
    }
    if (full.size !== FULL_CONTEXTS) {
      problems.push(`${tool}: ${full.size} of ${FULL_CONTEXTS} contexts answered`)
    }
    answers.set(tool, full)
  }
  return { answers, problems }
}

const { answers: ANSWERS, problems: TABLE_PROBLEMS } = expandTable()

function contextKey(context: Record<string, string>): string {
  return KEY_FIELDS.map(field => context[field]).join('|')
}

function asks(tool: string, context: Record<string, string>): boolean {
  const key = contextKey(context)
  const answer = ANSWERS.get(tool)?.get(key)
  if (answer === undefined) throw new Error(`the asks table has no answer for ${tool} at ${key}`)
  return answer
}

/**
 * A context key where `tool` asks with override `from` and not with `to`, on a
 * Host with these facts; null when the change loosens nothing there.
 */
function oracleWitness(tool: string, from: Override, to: Override, host: HostFacts): string | null {
  for (const effectiveMode of MODES_UNDER[host.ceiling]) {
    for (const channelType of FIELD_VALUES.channelType) {
      for (const cronFired of FIELD_VALUES.cronFired) {
        for (const judge of FIELD_VALUES.judge) {
          const context = {
            effectiveMode,
            channelType,
            cronFired,
            stateless: host.stateless,
            allowStatelessCron: host.allowStatelessCron,
            judge,
          }
          const before = { ...context, override: from }
          if (asks(tool, before) && !asks(tool, { ...context, override: to })) {
            return contextKey(before)
          }
        }
      }
    }
  }
  return null
}

/** A block whose only override is `tool` at `value`. */
function block(tool: string, value: Override): Record<string, unknown> {
  return value === 'absent' ? { tools: {} } : { tools: { [tool]: value === 'true' } }
}

const singlePathMemo = new Map<string, LooseningItem[]>()

function singlePathItems(
  tool: string,
  from: Override,
  to: Override,
  ceiling: Ceiling
): LooseningItem[] {
  const key = [tool, from, to, ceiling].join('|')
  let items = singlePathMemo.get(key)
  if (items === undefined) {
    items = looseningItems({
      before: block(tool, from),
      after: block(tool, to),
      ceiling,
      firstSave: false,
    })
    singlePathMemo.set(key, items)
  }
  return items
}

let sweepMemo: Outcome[] | undefined

/** Every single-path change of every oracle tool, on every Host. */
function sweep(): Outcome[] {
  if (sweepMemo) return sweepMemo
  const outcomes: Outcome[] = []
  for (const tool of ORACLE_TOOLS) {
    for (const from of OVERRIDES) {
      for (const to of OVERRIDES) {
        if (from === to) continue
        for (const host of HOSTS) {
          outcomes.push({
            tool,
            from,
            to,
            host,
            items: singlePathItems(tool, from, to, host.ceiling),
            witness: oracleWitness(tool, from, to, host),
          })
        }
      }
    }
  }
  sweepMemo = outcomes
  return outcomes
}

/**
 * The function does not see `stateless` or `allowStatelessCron`, so it lists a
 * change wherever some Host with the same ceiling loosens.
 */
function someHostWithTheCeilingLoosens(c: Case): boolean {
  return HOSTS.some(
    other => other.ceiling === c.host.ceiling && oracleWitness(c.tool, c.from, c.to, other) !== null
  )
}

/**
 * The cases each named exception excuses, clause by clause: an item where the
 * oracle shows no loosening for that Host. A test below fails when the
 * exceptions named here differ from the exported ones, or when a clause
 * excuses no case.
 */
const EXCEPTION_CLAUSES: ReadonlyArray<{
  exception: string
  clause: string
  inScope: (c: Case) => boolean
}> = [
  {
    // custom_tool stands for a custom row with a plain name (spec §6.6).
    exception: 'custom_row_unknown_default',
    clause: 'a plain custom name: removing a Required row, or setting the row to Skip',
    inScope: c => c.tool === CUSTOM_PROBE && (c.from === 'true' || c.to === 'false'),
  },
  {
    // server__tool stands for a `__` name that does not resolve to a native tool.
    exception: 'custom_row_unknown_default',
    clause: 'Ruling 32(c): removing a Required `__` row that does not resolve',
    inScope: c => c.tool === MCP_PROBE && c.from === 'true' && c.to === 'absent',
  },
  {
    exception: 'cron_manage_conditional_default',
    clause: 'cron_manage Required → Default, listed where its default asks',
    inScope: c =>
      c.tool === 'cron_manage' &&
      c.from === 'true' &&
      c.to === 'absent' &&
      someHostWithTheCeilingLoosens(c),
  },
  {
    exception: 'cron_manage_conditional_default',
    clause: 'cron_manage Default → Skip, listed where its default never asks',
    inScope: c =>
      c.tool === 'cron_manage' &&
      c.from === 'absent' &&
      c.to === 'false' &&
      someHostWithTheCeilingLoosens(c),
  },
  {
    // The override of a `__` name that does not resolve never takes effect.
    exception: 'unresolved_mcp_skip_row',
    clause: 'a `__` row that does not resolve, set to Skip from Default',
    inScope: c => c.tool === MCP_PROBE && c.from === 'absent' && c.to === 'false',
  },
  {
    exception: 'unresolved_mcp_skip_row',
    clause: 'a `__` row that does not resolve, set to Skip from Required',
    inScope: c => c.tool === MCP_PROBE && c.from === 'true' && c.to === 'false',
  },
]

/** The clauses that excuse this case. */
function excusedBy(c: Case): string[] {
  return EXCEPTION_CLAUSES.filter(entry => entry.inScope(c)).map(entry => entry.clause)
}

function describeCase(c: Case): string {
  const { ceiling, stateless, allowStatelessCron } = c.host
  return `tools.${c.tool} ${c.from} → ${c.to} (ceiling ${ceiling}, stateless ${stateless}, allowStatelessCron ${allowStatelessCron})`
}

function byPath(items: LooseningItem[]): LooseningItem[] {
  return [...items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

describe('the asks table this oracle reads', () => {
  it('answers every context exactly once, in the key order this test reads', () => {
    expect(TABLE.keys).toEqual(KEY_FIELDS)
    expect(FULL_CONTEXTS).toBe(720)
    expect(TABLE_PROBLEMS).toEqual([])
  })

  it('covers every native row, one custom name and one server__tool name, leaving out only clerum__tool_call', () => {
    expect([...ORACLE_EXCLUDED]).toEqual(['clerum__tool_call'])
    // The exclusion removes a real entry of the table.
    expect(Object.keys(TABLE.asks)).toContain('clerum__tool_call')
    expect(ORACLE_TOOLS).toEqual(
      [...NATIVE_TOOLS.map(tool => tool.name), CUSTOM_PROBE, MCP_PROBE].sort()
    )
  })
})

describe('looseningItems against the oracle, single path', () => {
  it('no missed loosening: when a context asks before the change and not after, the path has an item', () => {
    const outcomes = sweep()
    const positives = outcomes.filter(outcome => outcome.witness !== null)
    const missed = positives
      .filter(outcome => !outcome.items.some(item => item.path === `tools.${outcome.tool}`))
      .map(outcome => `${describeCase(outcome)} asks at ${outcome.witness}`)
    expect(missed).toEqual([])
    // Partner: the oracle does find loosening in these cases, so the check cannot pass vacuously.
    expect(positives.length).toBeGreaterThan(0)
    expect(
      positives.some(o => o.tool === 'shell_exec' && o.from === 'absent' && o.to === 'false')
    ).toBe(true)
  })

  it('item level: the items equal the oracle per Host facts, except for the named exceptions', () => {
    const outcomes = sweep()
    const missing: string[] = []
    const unexplained: string[] = []
    const malformed: string[] = []
    let agreed = 0
    let excused = 0
    for (const outcome of outcomes) {
      const path = `tools.${outcome.tool}`
      if (outcome.items.length > 1 || outcome.items.some(item => item.path !== path)) {
        malformed.push(`${describeCase(outcome)}: ${JSON.stringify(outcome.items)}`)
      }
      const listed = outcome.items.length > 0
      if (outcome.witness !== null && listed) agreed += 1
      if (outcome.witness !== null && !listed) missing.push(describeCase(outcome))
      if (outcome.witness === null && listed) {
        if (excusedBy(outcome).length > 0) excused += 1
        else unexplained.push(`${describeCase(outcome)}: ${outcome.items[0].rule}`)
      }
    }
    expect(malformed).toEqual([])
    expect(missing).toEqual([])
    expect(unexplained).toEqual([])
    // Partners: 58 tools × 6 changes × 12 Hosts were compared; the function and
    // the oracle agree on 1,396 loosening cases, and 60 items are excused.
    expect(outcomes).toHaveLength(4176)
    expect(agreed).toBe(1396)
    expect(excused).toBe(60)
  })

  it('each clause of each named exception excuses at least one case, and each exception has a reason', () => {
    expect([...new Set(EXCEPTION_CLAUSES.map(entry => entry.exception))].sort()).toEqual(
      TOOL_LOOSENING_EXCEPTIONS.map(exception => exception.id).sort()
    )
    for (const exception of TOOL_LOOSENING_EXCEPTIONS) {
      expect(exception.reason.trim().length, exception.id).toBeGreaterThan(0)
    }
    const used = new Map<string, number>()
    for (const outcome of sweep()) {
      if (outcome.witness !== null || outcome.items.length === 0) continue
      for (const clause of excusedBy(outcome)) used.set(clause, (used.get(clause) ?? 0) + 1)
    }
    for (const entry of EXCEPTION_CLAUSES) {
      expect(used.get(entry.clause) ?? 0, entry.clause).toBeGreaterThan(0)
    }
  })

  it('coverage partner: every rule appears at least once in the cases', () => {
    const seen = new Set<string>(sweep().flatMap(outcome => outcome.items.map(item => item.rule)))
    const firstSave = looseningItems({
      before: undefined,
      after: { defaultPolicy: 'channel_users', tools: {} },
      ceiling: 'manual',
      firstSave: true,
    })
    for (const item of firstSave) seen.add(item.rule)
    expect([...seen].sort()).toEqual([...LOOSENING_RULES].sort())
  })

  it('a change that changes nothing has no item', () => {
    for (const tool of ORACLE_TOOLS) {
      for (const value of OVERRIDES) {
        for (const ceiling of CEILINGS) {
          const items = looseningItems({
            before: block(tool, value),
            after: block(tool, value),
            ceiling,
            firstSave: false,
          })
          expect(items, `${tool} ${value} ${ceiling}`).toEqual([])
        }
      }
    }
    // Partner: the same tools do list items when their value changes.
    expect(singlePathItems('shell_exec', 'absent', 'false', 'manual')).toHaveLength(1)
  })
})

describe('looseningItems, rule by rule', () => {
  it('explicit Required → Default on shell_exec or http_request is an item only above Manual', () => {
    for (const tool of ['shell_exec', 'http_request']) {
      expect(singlePathItems(tool, 'true', 'absent', 'manual'), tool).toEqual([])
      for (const ceiling of ['auto', 'allow_all'] as const) {
        expect(singlePathItems(tool, 'true', 'absent', ceiling), `${tool} ${ceiling}`).toEqual([
          { path: `tools.${tool}`, rule: 'explicit_required_to_default_above_manual' },
        ])
      }
    }
    // Another tool that is Required by default asks the same either way, as the table shows.
    for (const host of HOSTS) {
      expect(oracleWitness('browser_open', 'true', 'absent', host)).toBeNull()
      expect(singlePathItems('browser_open', 'true', 'absent', host.ceiling)).toEqual([])
    }
  })

  it('Default → Skip on a tool that never asks is not an item (Ruling 32(a))', () => {
    for (const host of HOSTS) {
      expect(oracleWitness('file_write', 'absent', 'false', host)).toBeNull()
      expect(singlePathItems('file_write', 'absent', 'false', host.ceiling)).toEqual([])
    }
    // Partners: Required → Skip on that tool, and Default → Skip on a tool that asks, are items.
    expect(singlePathItems('file_write', 'true', 'false', 'manual')).toEqual([
      { path: 'tools.file_write', rule: 'tool_to_skip' },
    ])
    expect(singlePathItems('shell_exec', 'absent', 'false', 'manual')).toEqual([
      { path: 'tools.shell_exec', rule: 'tool_to_skip' },
    ])
  })

  it('a shell_exec change lists shell_exec and never clerum__gfs_download (Ruling 21)', () => {
    expect(
      looseningItems({
        before: { tools: {} },
        after: { tools: { shell_exec: false } },
        ceiling: 'auto',
        firstSave: false,
      })
    ).toEqual([{ path: 'tools.shell_exec', rule: 'tool_to_skip' }])
    // Skip → Default registers the download tool again: outside loosening, no item.
    expect(
      looseningItems({
        before: { tools: { shell_exec: false } },
        after: { tools: {} },
        ceiling: 'auto',
        firstSave: false,
      })
    ).toEqual([])
  })

  it('treats tools.clerum__tool_call as a custom row, never laxer', () => {
    const items = (from: Override, to: Override) =>
      singlePathItems('clerum__tool_call', from, to, 'manual')
    const custom = [{ path: 'tools.clerum__tool_call', rule: 'custom_row_unknown_default' }]
    expect(items('absent', 'false')).toEqual(custom)
    expect(items('true', 'absent')).toEqual(custom)
    expect(items('false', 'absent')).toEqual([])
  })

  it('pins all six changes of a plain custom name and of a `__` name that does not resolve', () => {
    // Spec §6.6: adding a Skip custom row and removing a Required one both loosen.
    const changes: ReadonlyArray<[Override, Override, boolean]> = [
      ['absent', 'false', true], // adding a Skip row
      ['true', 'absent', true], // removing a Required row
      ['true', 'false', true], // Required → Skip
      ['false', 'absent', false], // removing a Skip row
      ['absent', 'true', false], // adding a Required row
      ['false', 'true', false], // Skip → Required
    ]
    for (const name of ['my_tool', 'my_server__my_tool']) {
      expect(
        NATIVE_TOOLS.some(tool => tool.name === name),
        name
      ).toBe(false)
      for (const [from, to, listed] of changes) {
        for (const ceiling of CEILINGS) {
          expect(
            looseningItems({
              before: block(name, from),
              after: block(name, to),
              ceiling,
              firstSave: false,
            }),
            `${name} ${from} → ${to} (ceiling ${ceiling})`
          ).toEqual(listed ? [{ path: `tools.${name}`, rule: 'custom_row_unknown_default' }] : [])
        }
      }
    }
  })

  it('a value outside the schema counts as asking before the change and as not asking after it', () => {
    // The CRD types tools values as boolean; the gate reads a truthy value as asking.
    expect(
      looseningItems({
        before: { tools: { file_write: 'yes' } },
        after: { tools: {} },
        ceiling: 'manual',
        firstSave: false,
      })
    ).toEqual([{ path: 'tools.file_write', rule: 'required_to_default' }])
    expect(
      looseningItems({
        before: { tools: {} },
        after: { tools: { shell_exec: 0 } },
        ceiling: 'manual',
        firstSave: false,
      })
    ).toEqual([{ path: 'tools.shell_exec', rule: 'tool_to_skip' }])
    // Unchanged, it is not read at all.
    expect(
      looseningItems({
        before: { tools: { file_write: 'yes' } },
        after: { tools: { file_write: 'yes' } },
        ceiling: 'manual',
        firstSave: false,
      })
    ).toEqual([])
  })

  it('reads null as absent, as the gate does', () => {
    expect(
      looseningItems({
        before: { tools: { shell_exec: null } },
        after: { tools: {} },
        ceiling: 'auto',
        firstSave: false,
      })
    ).toEqual([])
    expect(
      looseningItems({
        before: { tools: { shell_exec: true } },
        after: { tools: { shell_exec: null } },
        ceiling: 'auto',
        firstSave: false,
      })
    ).toEqual([{ path: 'tools.shell_exec', rule: 'explicit_required_to_default_above_manual' }])
  })

  it('PR A scope: reads tools, and defaultPolicy only on a first save', () => {
    expect(
      looseningItems({
        before: { modeCeiling: 'manual', tools: { shell_exec: true } },
        after: {
          modeCeiling: 'allow_all',
          defaultPolicy: 'channel_users',
          channels: { telegram: { allowModeChange: true } },
          tools: { shell_exec: true, http_request: false },
        },
        ceiling: 'auto',
        firstSave: false,
      })
    ).toEqual([{ path: 'tools.http_request', rule: 'tool_to_skip' }])
  })
})

describe('looseningItems, multi-path (union of single-path items, spec A6)', () => {
  const before = {
    tools: {
      shell_exec: true,
      file_write: true,
      my_tool: true,
      cron_manage: true,
      http_request: false,
    },
  }
  const after = {
    tools: {
      file_write: false,
      memory_write: false,
      cron_manage: true,
      workflow_trigger: false,
      http_request: true,
    },
  }

  it('lists each loosening path once, in path order', () => {
    expect(looseningItems({ before, after, ceiling: 'auto', firstSave: false })).toEqual([
      { path: 'tools.file_write', rule: 'tool_to_skip' },
      { path: 'tools.my_tool', rule: 'custom_row_unknown_default' },
      { path: 'tools.shell_exec', rule: 'explicit_required_to_default_above_manual' },
      { path: 'tools.workflow_trigger', rule: 'tool_to_skip' },
    ])
    // Under Manual, explicit Required → Default on shell_exec is not an item.
    expect(looseningItems({ before, after, ceiling: 'manual', firstSave: false })).toEqual([
      { path: 'tools.file_write', rule: 'tool_to_skip' },
      { path: 'tools.my_tool', rule: 'custom_row_unknown_default' },
      { path: 'tools.workflow_trigger', rule: 'tool_to_skip' },
    ])
  })

  it('keys stored in another order, and unchanged keys, add no item', () => {
    const before = { tools: { my_tool: false, shell_exec: true, file_write: false } }
    expect(
      looseningItems({
        before,
        after: { tools: { file_write: false, shell_exec: true, my_tool: false } },
        ceiling: 'allow_all',
        firstSave: false,
      })
    ).toEqual([])
    // Partner: the same reordered blocks with one value changed give exactly that item.
    expect(
      looseningItems({
        before,
        after: { tools: { file_write: false, shell_exec: false, my_tool: false } },
        ceiling: 'allow_all',
        firstSave: false,
      })
    ).toEqual([{ path: 'tools.shell_exec', rule: 'tool_to_skip' }])
    // An absent tools map reads like an empty one.
    expect(
      looseningItems({ before: {}, after: { tools: {} }, ceiling: 'manual', firstSave: false })
    ).toEqual([])
    // Partner: a change from an absent tools map is still listed.
    expect(
      looseningItems({
        before: {},
        after: { tools: { shell_exec: false } },
        ceiling: 'manual',
        firstSave: false,
      })
    ).toEqual([{ path: 'tools.shell_exec', rule: 'tool_to_skip' }])
  })

  it('property: the items are the union of single-path items and agree with the oracle', () => {
    const override = fc.constantFrom<Override>(...OVERRIDES)
    const change = fc.record({
      ceiling: fc.constantFrom<Ceiling>(...CEILINGS),
      rows: fc.uniqueArray(
        fc.record({ tool: fc.constantFrom(...ORACLE_TOOLS), from: override, to: override }),
        { selector: row => row.tool, minLength: 2, maxLength: 8 }
      ),
    })
    fc.assert(
      fc.property(change, ({ ceiling, rows }) => {
        const beforeTools: Record<string, boolean> = {}
        const afterTools: Record<string, boolean> = {}
        for (const row of rows) {
          if (row.from !== 'absent') beforeTools[row.tool] = row.from === 'true'
          if (row.to !== 'absent') afterTools[row.tool] = row.to === 'true'
        }
        const items = looseningItems({
          before: { tools: beforeTools },
          after: { tools: afterTools },
          ceiling,
          firstSave: false,
        })
        const union = rows.flatMap(row => singlePathItems(row.tool, row.from, row.to, ceiling))
        expect(items).toEqual(byPath(union))
        for (const host of HOSTS.filter(each => each.ceiling === ceiling)) {
          for (const row of rows) {
            const listed = items.some(item => item.path === `tools.${row.tool}`)
            const witness =
              row.from === row.to ? null : oracleWitness(row.tool, row.from, row.to, host)
            const c = { ...row, host }
            if (witness !== null) expect(listed, describeCase(c)).toBe(true)
            if (witness === null && listed) expect(excusedBy(c), describeCase(c)).not.toEqual([])
          }
        }
      }),
      { numRuns: 200 }
    )
  })
})

describe('looseningItems, first save (spec §6.6)', () => {
  const policyItem = { path: 'defaultPolicy', rule: 'policy_open_on_first_save' }

  it('a first save with an open policy yields policy_open_on_first_save', () => {
    for (const defaultPolicy of ['channel_users', undefined, null, '']) {
      const after = defaultPolicy === undefined ? { tools: {} } : { defaultPolicy, tools: {} }
      expect(
        looseningItems({ before: undefined, after, ceiling: 'manual', firstSave: true }),
        String(defaultPolicy)
      ).toEqual([policyItem])
    }
  })

  it('"Nobody (Desktop only)" is no policy item; the tools count against the code defaults', () => {
    expect(
      looseningItems({
        before: undefined,
        after: {
          defaultPolicy: 'cli_only',
          tools: { shell_exec: false, file_write: false, http_request: true },
        },
        ceiling: 'manual',
        firstSave: true,
      })
    ).toEqual([{ path: 'tools.shell_exec', rule: 'tool_to_skip' }])
  })

  it('an open policy is an item only on a first save', () => {
    const after = { defaultPolicy: 'channel_users', tools: { shell_exec: false } }
    const shellItem = { path: 'tools.shell_exec', rule: 'tool_to_skip' }
    expect(
      looseningItems({ before: { tools: {} }, after, ceiling: 'manual', firstSave: false })
    ).toEqual([shellItem])
    expect(
      looseningItems({ before: undefined, after, ceiling: 'manual', firstSave: true })
    ).toEqual([policyItem, shellItem])
  })

  it('a null block reads as the code defaults, like an absent one', () => {
    const after = { defaultPolicy: 'cli_only', tools: { shell_exec: false, file_write: true } }
    const expected = [{ path: 'tools.shell_exec', rule: 'tool_to_skip' }]
    expect(
      looseningItems({ before: undefined, after, ceiling: 'manual', firstSave: true })
    ).toEqual(expected)
    expect(
      looseningItems({
        before: null as unknown as undefined,
        after,
        ceiling: 'manual',
        firstSave: true,
      })
    ).toEqual(expected)
  })
})

describe('sameLooseningItems', () => {
  const skip = { path: 'tools.shell_exec', rule: 'tool_to_skip' } as const
  const custom = { path: 'tools.my_tool', rule: 'custom_row_unknown_default' } as const
  const policy = { path: 'defaultPolicy', rule: 'policy_open_on_first_save' } as const

  it('compares sets: order does not matter', () => {
    expect(sameLooseningItems([skip, custom, policy], [policy, skip, custom])).toBe(true)
    expect(sameLooseningItems([], [])).toBe(true)
    expect(sameLooseningItems([skip, skip], [skip])).toBe(true)
  })

  it('differs on a missing or extra item, another rule, or another path', () => {
    expect(sameLooseningItems([skip, custom], [skip])).toBe(false)
    expect(sameLooseningItems([skip], [skip, custom])).toBe(false)
    expect(sameLooseningItems([skip], [{ path: skip.path, rule: 'required_to_default' }])).toBe(
      false
    )
    expect(sameLooseningItems([skip], [{ path: 'tools.http_request', rule: skip.rule }])).toBe(
      false
    )
    expect(sameLooseningItems([skip], [])).toBe(false)
  })
})

describe('looseningItemsConfirmed (the check at the write, spec §6.4 step 6)', () => {
  const skip = { path: 'tools.shell_exec', rule: 'tool_to_skip' } as const
  const custom = { path: 'tools.my_tool', rule: 'custom_row_unknown_default' } as const
  const policy = { path: 'defaultPolicy', rule: 'policy_open_on_first_save' } as const

  it('holds when every item at the write was confirmed, in any order; an item gone by the write does not count against it', () => {
    expect(looseningItemsConfirmed([skip, custom], [custom, skip])).toBe(true)
    expect(looseningItemsConfirmed([skip, custom, policy], [skip])).toBe(true)
    expect(looseningItemsConfirmed([skip], [])).toBe(true)
    expect(looseningItemsConfirmed([], [])).toBe(true)
  })

  it('fails when the write has an item the admin did not confirm, by path or by rule', () => {
    expect(looseningItemsConfirmed([skip], [skip, custom])).toBe(false)
    expect(looseningItemsConfirmed([], [skip])).toBe(false)
    expect(
      looseningItemsConfirmed(
        [skip],
        [{ path: skip.path, rule: 'explicit_required_to_default_above_manual' }]
      )
    ).toBe(false)
    expect(looseningItemsConfirmed([skip], [{ path: 'tools.http_request', rule: skip.rule }])).toBe(
      false
    )
  })

  it('a ceiling raised between the dialog and the write adds an item the admin did not confirm', () => {
    const before = { tools: { shell_exec: true } }
    const after = { tools: {} }
    const confirmed = looseningItems({ before, after, ceiling: 'manual', firstSave: false })
    const atWrite = looseningItems({ before, after, ceiling: 'auto', firstSave: false })
    expect(confirmed).toEqual([])
    expect(atWrite).toEqual([
      { path: 'tools.shell_exec', rule: 'explicit_required_to_default_above_manual' },
    ])
    expect(looseningItemsConfirmed(confirmed, atWrite)).toBe(false)
    // A ceiling lowered instead drops the item, and the confirmation still covers the write.
    expect(looseningItemsConfirmed(atWrite, confirmed)).toBe(true)
  })
})
