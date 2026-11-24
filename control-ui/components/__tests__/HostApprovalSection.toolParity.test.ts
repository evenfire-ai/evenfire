/**
 * NATIVE_TOOLS must match the tools mcp-host chat registers.
 *
 * mcp-host is not importable from this package (it pulls jose and prom-client),
 * so the truth is the producer fixture mcp-host records:
 * mcp-host/src/core/approval/__tests__/approvalProducerFixtures.test.ts →
 * mcp-host/test/fixtures/wire/mcp-host-tool-approval.json.
 * Each tool has one entry per context: true = asks, false = never asks,
 * null = not registered there. Contexts are iterated as recorded (not a grid).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NATIVE_TOOLS, TOOL_PARITY_EXCLUSIONS } from '../HostApprovalSection/constants'

type ToolApprovalWire = {
  contexts: unknown[]
  tools: Record<string, Array<boolean | null>>
}

const WIRE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../mcp-host/test/fixtures/wire/mcp-host-tool-approval.json'),
    'utf8'
  )
) as ToolApprovalWire

const registered = Object.keys(WIRE.tools).sort()
const excluded = new Set(TOOL_PARITY_EXCLUSIONS.map(entry => entry.name))
// `conditional` is added to the row type by the later per-tool work; read it loosely.
type Row = { name: string; codeDefault: string; conditional?: { conditions?: unknown } }
const rows = NATIVE_TOOLS as unknown as Row[]

/** The true/false values a tool holds over the contexts where it is registered. */
function valuesOf(name: string): Set<boolean> {
  const values = new Set<boolean>()
  for (const value of WIRE.tools[name] ?? []) if (value !== null) values.add(value)
  return values
}

describe('NATIVE_TOOLS matches the tools chat registers', () => {
  it('the fixture lists the registry the test pins to', () => {
    expect(registered.length).toBeGreaterThanOrEqual(20)
    expect(registered).toContain('shell_exec')
    expect(registered).toContain('clerum__gfs_write')
    for (const name of registered) expect(WIRE.tools[name]).toHaveLength(WIRE.contexts.length)
  })

  it('every exclusion has a reason and names a registered tool', () => {
    for (const entry of TOOL_PARITY_EXCLUSIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(0)
      expect(registered).toContain(entry.name)
    }
  })

  it('every row maps to exactly one registered tool', () => {
    const names = rows.map(row => row.name)
    expect(names.filter((name, i) => names.indexOf(name) !== i).sort()).toEqual([])
    expect(names.filter(name => !registered.includes(name)).sort()).toEqual([])
  })

  it('every registered tool has a row or an exclusion', () => {
    const rowNames = new Set(rows.map(row => row.name))
    expect(registered.filter(name => !rowNames.has(name) && !excluded.has(name))).toEqual([])
  })

  it('a row varies only where the tool varies, and otherwise holds the registered value', () => {
    const mismatches: string[] = []
    for (const row of rows) {
      if (!(row.name in WIRE.tools)) continue
      const values = valuesOf(row.name)
      if (values.size > 1) {
        if (typeof row.conditional?.conditions !== 'string') {
          mismatches.push(
            `${row.name}: value varies across contexts but the row has no conditional`
          )
        }
      } else if (values.size === 1) {
        const expected = values.has(true) ? 'required' : 'skip'
        if (row.codeDefault !== expected) {
          mismatches.push(`${row.name}: codeDefault ${row.codeDefault}, registry ${expected}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('the fixture records tools whose value varies across contexts', () => {
    const varying = registered.filter(name => valuesOf(name).size > 1)
    expect(varying.length).toBeGreaterThan(0)
  })
})
