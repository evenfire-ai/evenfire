import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TOOL_PARITY_EXCLUSIONS } from '../../components/HostApprovalSection/constants'
import {
  APPROVAL_TOOL_CATALOG,
  type ApprovalToolAsks,
  neverAskTools,
  skipOverrides,
} from '../approvalToolCatalog'

type Context = {
  statelessLifecycle: boolean
  allowStatelessCronManage: boolean
  channelType: string
  gfsScopes: string
  workflowTools: boolean
  gfsDownloadStore: boolean
}
type Wire = { contexts: Context[]; tools: Record<string, Array<boolean | null>> }

const WIRE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../mcp-host/test/fixtures/wire/mcp-host-tool-approval.json'),
    'utf8'
  )
) as Wire

/** The catalog value the fixture implies, judged over the contexts where the tool is registered. */
function derive(name: string): 'always' | 'never' | 'conditional' {
  const values = new Set(WIRE.tools[name].filter((value): value is boolean => value !== null))
  if (values.size > 1) return 'conditional'
  return values.has(true) ? 'always' : 'never'
}

function kindOf(asks: ApprovalToolAsks): 'always' | 'never' | 'conditional' {
  return typeof asks === 'string' ? asks : 'conditional'
}

/** Contexts (as recorded, not a grid) where the tool is registered. */
function registeredIn(name: string): Context[] {
  return WIRE.contexts.filter((_, i) => WIRE.tools[name][i] !== null)
}

describe('APPROVAL_TOOL_CATALOG', () => {
  it("the catalog equals the fixture's derivation", () => {
    const fixtureNames = Object.keys(WIRE.tools).sort()
    expect(APPROVAL_TOOL_CATALOG.map(entry => entry.name)).toEqual(fixtureNames)
    for (const entry of APPROVAL_TOOL_CATALOG) {
      expect(kindOf(entry.asks), entry.name).toBe(derive(entry.name))
      if (typeof entry.asks !== 'string') {
        expect(entry.asks.conditions.trim().length, entry.name).toBeGreaterThan(0)
      }
    }
  })

  it('the conditions of the two varying tools match the contexts that differ', () => {
    // cron_manage is false only on a stateless Host that has not allowed cron management.
    for (const [i, context] of WIRE.contexts.entries()) {
      const value = WIRE.tools.cron_manage[i]
      expect(value).toBe(!(context.statelessLifecycle && !context.allowStatelessCronManage))
    }
    // workflow_trigger asks in Desktop chats (rpc) and not from Telegram, Slack or Teams.
    const byChannel = new Map<string, Set<boolean>>()
    for (const [i, context] of WIRE.contexts.entries()) {
      const value = WIRE.tools.workflow_trigger[i]
      if (value === null) continue
      byChannel.set(
        context.channelType,
        (byChannel.get(context.channelType) ?? new Set()).add(value)
      )
    }
    expect(Object.fromEntries([...byChannel].map(([k, v]) => [k, [...v]]))).toEqual({
      rpc: [true],
      slack: [false],
      teams: [false],
      telegram: [false],
    })
  })

  it('clerum__gfs_download is registered exactly where the store is available and gfs.read is held', () => {
    const contexts = registeredIn('clerum__gfs_download')
    expect(contexts.length).toBeGreaterThan(0)
    for (const context of contexts) {
      expect(context.gfsDownloadStore).toBe(true)
      expect(['read', 'read-write']).toContain(context.gfsScopes)
    }
    const expected = WIRE.contexts.filter(
      context => context.gfsDownloadStore && ['read', 'read-write'].includes(context.gfsScopes)
    )
    expect(contexts).toEqual(expected)
  })
})

describe('neverAskTools', () => {
  const never = neverAskTools()
  const names = never.map(entry => entry.name)

  it('lists clerum__gfs_write, file_write and clerum__get_capabilities', () => {
    expect(names).toContain('clerum__gfs_write')
    expect(names).toContain('file_write')
    expect(names).toContain('clerum__get_capabilities')
    // A constant false carries no conditions text.
    expect(never.find(entry => entry.name === 'file_write')?.conditions).toBeUndefined()
  })

  it('does not list shell_exec or http_request', () => {
    expect(names).not.toContain('shell_exec')
    expect(names).not.toContain('http_request')
    // Partner: the list is not simply empty or the catalog filtered to nothing.
    expect(names.length).toBeGreaterThan(20)
  })

  it('lists workflow_trigger with "from Telegram, Slack and Teams tasks"', () => {
    const entry = never.find(item => item.name === 'workflow_trigger')
    expect(entry?.conditions).toContain('from Telegram, Slack and Teams tasks')
  })

  it('lists cron_manage with its conditions', () => {
    const entry = never.find(item => item.name === 'cron_manage')
    expect(entry?.conditions).toMatch(/stateless/i)
  })

  it('lists clerum__gfs_download with the store condition', () => {
    const entry = never.find(item => item.name === 'clerum__gfs_download')
    expect(entry?.conditions).toMatch(/gfs\.read/)
  })

  it('does not list clerum__tool_call, whose calls run under the target tool rule', () => {
    expect(TOOL_PARITY_EXCLUSIONS.map(entry => entry.name)).toContain('clerum__tool_call')
    // Partner: the catalog does hold it as never-ask, so only the explicit exclusion removes it.
    expect(derive('clerum__tool_call')).toBe('never')
    expect(names).not.toContain('clerum__tool_call')
  })

  it('every listed tool is never-ask or conditional in the catalog, and sorted', () => {
    for (const entry of never) {
      const catalogEntry = APPROVAL_TOOL_CATALOG.find(item => item.name === entry.name)
      expect(catalogEntry, entry.name).toBeDefined()
      expect(catalogEntry?.asks).not.toBe('always')
    }
    expect(names).toEqual([...names].sort())
  })
})

describe('skipOverrides', () => {
  it('returns the names stored as false, sorted', () => {
    expect(skipOverrides({ shell_exec: false, a_tool: false, http_request: true })).toEqual([
      'a_tool',
      'shell_exec',
    ])
  })

  it('ignores non-false values and an absent map', () => {
    expect(skipOverrides({ a: true, b: 'false', c: null, d: 0, e: undefined })).toEqual([])
    expect(skipOverrides(undefined)).toEqual([])
  })
})
