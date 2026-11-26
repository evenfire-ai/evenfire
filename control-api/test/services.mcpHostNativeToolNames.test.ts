/**
 * MCP_HOST_NATIVE_TOOL_NAMES must match the tools mcp-host registers. mcp-host
 * is not importable here, so the truth is its producer fixture
 * (mcp-host/test/fixtures/wire/mcp-host-tool-approval.json, recorded by
 * mcp-host/src/core/approval/__tests__/approvalProducerFixtures.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MCP_HOST_NATIVE_TOOL_NAMES,
  isMcpHostNativeToolName,
} from '../src/services/mcpHostNativeToolNames.js'

const WIRE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../mcp-host/test/fixtures/wire/mcp-host-tool-approval.json'),
    'utf8'
  )
) as { tools: Record<string, unknown> }

describe('MCP_HOST_NATIVE_TOOL_NAMES', () => {
  it('equals the tool set of the mcp-host producer fixture', () => {
    const registered = Object.keys(WIRE.tools).sort()
    expect(registered.length).toBeGreaterThanOrEqual(20)
    expect([...MCP_HOST_NATIVE_TOOL_NAMES].sort()).toEqual(registered)
  })

  it('has no duplicate and recognizes a name by exact match only', () => {
    expect(new Set(MCP_HOST_NATIVE_TOOL_NAMES).size).toBe(MCP_HOST_NATIVE_TOOL_NAMES.length)
    expect(isMcpHostNativeToolName('shell_exec')).toBe(true)
    expect(isMcpHostNativeToolName('shell_exec2')).toBe(false)
    expect(isMcpHostNativeToolName('a00')).toBe(false)
    expect(isMcpHostNativeToolName('__proto__')).toBe(false)
  })
})
