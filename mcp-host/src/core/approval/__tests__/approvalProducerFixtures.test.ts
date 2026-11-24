/**
 * Producer fixtures for Control UI's Approvals tab (spec §6.11 and §7 A6).
 *
 * Control UI shows which tools ask for approval, and checks that its
 * loosening function misses no loosening. It learns both from two files that
 * this test computes from mcp-host's own code (approvalProducerFixtures.build.ts)
 * and pins in test/fixtures/wire/:
 *
 * - mcp-host-tool-approval.json: every tool chat registers, with the tool's
 *   own requiresApproval() in each context of the ToolContext matrix, and
 *   null where chat does not register it;
 * - mcp-host-approval-asks.json: for those tools, one custom name and one
 *   server__tool name, whether a call shows a card in each approval context.
 *
 * With UPDATE_WIRE_GOLDENS=1 the test writes both files. Otherwise it fails
 * when what mcp-host computes differs from them. Only `_source.commit` (HEAD
 * when the files were written) is left out of the comparison.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ApprovalProducerFixtures,
  CUSTOM_TOOL_PROBE,
  MCP_TOOL_PROBE,
  type ProducerFile,
  buildApprovalProducerFixtures,
} from './approvalProducerFixtures.build'

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const WIRE_DIR = join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'wire')
const TOOL_FILE = 'mcp-host-tool-approval.json'
const ASKS_FILE = 'mcp-host-approval-asks.json'
const SIZE_BUDGET_BYTES = 512 * 1024

/** The asks key's fields, in key order, with every value each one takes. */
const KEY_VALUES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['effectiveMode', ['manual', 'auto', 'allow_all']],
  ['override', ['true', 'false', 'absent']],
  ['channelType', ['rpc', 'telegram', 'slack', 'teams', 'email']],
  ['cronFired', ['false', 'true']],
  ['stateless', ['false', 'true']],
  ['allowStatelessCron', ['false', 'true']],
  ['judge', ['false', 'true']],
]

type AsksContext = Record<string, string>

function serialize(file: ProducerFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

function headCommit(): string {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`git rev-parse HEAD printed ${JSON.stringify(commit)}, not a commit`)
  }
  return commit
}

function withoutCommit(file: ProducerFile): ProducerFile {
  const { commit: _commit, ...source } = file._source
  return { ...file, _source: source }
}

/** Writes the file in record mode; in both modes, the file must equal what mcp-host computes. */
function pin(file: string, produced: ProducerFile): void {
  const path = join(WIRE_DIR, file)
  if (UPDATE) {
    mkdirSync(WIRE_DIR, { recursive: true })
    writeFileSync(
      path,
      serialize({ ...produced, _source: { commit: headCommit(), ...produced._source } })
    )
  }
  expect(existsSync(path), `${file} is missing: run with UPDATE_WIRE_GOLDENS=1`).toBe(true)
  const committed = JSON.parse(readFileSync(path, 'utf8')) as ProducerFile
  expect(
    withoutCommit(committed),
    `${file} differs from what mcp-host computes: run with UPDATE_WIRE_GOLDENS=1`
  ).toEqual(produced)
}

/** Every combination of the key's values, one context per combination. */
function everyAsksContext(): AsksContext[] {
  return KEY_VALUES.reduce<AsksContext[]>(
    (partial, [field, values]) =>
      partial.flatMap(context => values.map(value => ({ ...context, [field]: value }))),
    [{}]
  )
}

function matchingEntries(
  fixtures: ApprovalProducerFixtures,
  tool: string,
  context: AsksContext
): Array<[string, boolean]> {
  // A tool missing from the table matches nothing; every caller fails on that.
  return Object.entries(fixtures.approvalAsks.asks[tool] ?? {}).filter(([key]) =>
    key.split('|').every((part, index) => part === '*' || part === context[KEY_VALUES[index][0]])
  )
}

describe('approval producer fixtures for Control UI', () => {
  let fixtures: ApprovalProducerFixtures
  let envBefore: NodeJS.ProcessEnv

  beforeAll(async () => {
    envBefore = { ...process.env }
    fixtures = await buildApprovalProducerFixtures()
  }, 120_000)

  /**
   * The one asks entry that covers this context. Unless overridden: Manual, no
   * override, an interactive rpc task, a Host that is not stateless, a judge.
   */
  function asksAt(tool: string, overrides: AsksContext = {}): boolean {
    const context: AsksContext = {
      effectiveMode: 'manual',
      override: 'absent',
      channelType: 'rpc',
      cronFired: 'false',
      stateless: 'false',
      allowStatelessCron: 'false',
      judge: 'true',
      ...overrides,
    }
    const entries = matchingEntries(fixtures, tool, context)
    expect(entries, `${tool} entries for ${JSON.stringify(context)}`).toHaveLength(1)
    return entries[0][1]
  }

  it('pins the tools chat registers and their requiresApproval()', () => {
    pin(TOOL_FILE, fixtures.toolApproval)
  })

  it('pins whether a call asks, per tool and context', () => {
    pin(ASKS_FILE, fixtures.approvalAsks)
  })

  it('keeps each file under 512 KiB', () => {
    const commit = '0'.repeat(40)
    for (const file of [fixtures.toolApproval, fixtures.approvalAsks]) {
      const bytes = Buffer.byteLength(serialize({ ...file, _source: { commit, ...file._source } }))
      expect(bytes).toBeLessThan(SIZE_BUDGET_BYTES)
    }
  })

  it('registers the named tools in the matching contexts', () => {
    const { contexts, tools } = fixtures.toolApproval
    // 2 stateless x 2 allow x 5 channels x 4 GFS scope sets x 2 desktop x 2 workflow.
    expect(contexts).toHaveLength(320)
    for (const [name, values] of Object.entries(tools)) {
      expect(values, name).toHaveLength(contexts.length)
    }

    expect(tools.cron_manage).toEqual(
      contexts.map(context => !(context.statelessLifecycle && !context.allowStatelessCronManage))
    )
    expect(tools.workflow_trigger).toEqual(
      contexts.map(context =>
        context.workflowTools && context.channelType !== 'email'
          ? context.channelType === 'rpc'
          : null
      )
    )
    expect(tools.memory_search).toEqual(contexts.map(() => false))
    expect(tools.clerum__gfs_write).toEqual(
      contexts.map(context =>
        context.gfsScopes === 'write' || context.gfsScopes === 'read-write' ? false : null
      )
    )
    // The brief's `get_capabilities`: chat registers it under its internal-tool name.
    expect(tools.get_capabilities).toBeUndefined()
    expect(tools.clerum__get_capabilities).toEqual(contexts.map(() => false))
    expect(tools.browser_open).toEqual(
      contexts.map(context => (context.desktopTools ? true : null))
    )
    expect(tools.shell_exec).toEqual(contexts.map(() => true))
  })

  it('answers the asks spot checks', () => {
    // Adapter-served tools never ask by default; an explicit Required asks below allow_all.
    expect(asksAt('clerum__gfs_write')).toBe(false)
    expect(asksAt('clerum__gfs_write', { override: 'true' })).toBe(true)
    expect(asksAt('clerum__gfs_write', { override: 'true', effectiveMode: 'allow_all' })).toBe(
      false
    )

    // Shell: manual asks, allow_all runs, auto asks only when no judge can classify it.
    expect(asksAt('shell_exec')).toBe(true)
    expect(asksAt('shell_exec', { effectiveMode: 'allow_all' })).toBe(false)
    expect(asksAt('shell_exec', { effectiveMode: 'auto', judge: 'true' })).toBe(false)
    expect(asksAt('shell_exec', { effectiveMode: 'auto', judge: 'false' })).toBe(true)
    expect(asksAt('shell_exec', { effectiveMode: 'auto', override: 'true' })).toBe(true)

    // http_request runs in auto unless it is explicitly Required.
    expect(asksAt('http_request', { effectiveMode: 'auto' })).toBe(false)
    expect(asksAt('http_request', { effectiveMode: 'auto', override: 'true' })).toBe(true)

    // cron_manage always takes the manual column.
    expect(asksAt('cron_manage', { effectiveMode: 'allow_all' })).toBe(true)
    expect(asksAt('cron_manage', { effectiveMode: 'allow_all', override: 'false' })).toBe(false)
    // Stateless, cron allowed: create and enable always ask, but Skip lets list,
    // delete and trigger run, so not every call asks.
    const statelessAllowed = { stateless: 'true', allowStatelessCron: 'true' }
    expect(asksAt('cron_manage', statelessAllowed)).toBe(true)
    expect(asksAt('cron_manage', { ...statelessAllowed, override: 'false' })).toBe(false)
    // Stateless, cron forbidden: the tool never asks unless it is explicitly Required.
    expect(asksAt('cron_manage', { stateless: 'true' })).toBe(false)
    expect(asksAt('cron_manage', { stateless: 'true', override: 'true' })).toBe(true)

    // Cron-fired tasks: no gate on a Host that is not stateless; on a stateless
    // Host only cron_manage create and enable are gated.
    expect(asksAt('shell_exec', { cronFired: 'true' })).toBe(false)
    expect(asksAt('shell_exec', { cronFired: 'true', ...statelessAllowed })).toBe(false)
    expect(asksAt('cron_manage', { cronFired: 'true', ...statelessAllowed })).toBe(false)

    // workflow_trigger asks from Desktop, not from Telegram, Slack or Teams.
    expect(asksAt('workflow_trigger')).toBe(true)
    expect(asksAt('workflow_trigger', { channelType: 'telegram' })).toBe(false)

    // A server__tool name asks below allow_all whatever its override; a custom
    // name asks only when Required.
    expect(asksAt(MCP_TOOL_PROBE, { override: 'false' })).toBe(true)
    expect(asksAt(MCP_TOOL_PROBE, { effectiveMode: 'allow_all' })).toBe(false)
    expect(asksAt(CUSTOM_TOOL_PROBE)).toBe(false)
    expect(asksAt(CUSTOM_TOOL_PROBE, { override: 'true' })).toBe(true)
  })

  it('finds exactly one asks entry for every tool in every context', () => {
    const { keys, asks } = fixtures.approvalAsks
    expect(keys).toEqual(KEY_VALUES.map(([field]) => field))
    expect(Object.keys(asks).sort()).toEqual(
      [...Object.keys(fixtures.toolApproval.tools), CUSTOM_TOOL_PROBE, MCP_TOOL_PROBE].sort()
    )
    const contexts = everyAsksContext()
    expect(contexts).toHaveLength(720)
    for (const tool of Object.keys(asks)) {
      const unmatched = contexts.filter(
        context => matchingEntries(fixtures, tool, context).length !== 1
      )
      expect(unmatched, `${tool}: contexts without exactly one entry`).toEqual([])
    }
  })

  it('leaves the environment as it found it', () => {
    expect({ ...process.env }).toEqual(envBefore)
  })
})
