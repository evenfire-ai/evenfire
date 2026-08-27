/**
 * U5 — connect_required marker extraction + suspension builder.
 */
import { describe, expect, it } from 'vitest'
import {
  buildConnectRequiredApproval,
  extractConnectRequiredMarker,
} from '../mcpApprovalGateController'

describe('extractConnectRequiredMarker', () => {
  it('reads a well-formed marker', () => {
    expect(
      extractConnectRequiredMarker({
        connect_required: { mcpServerName: 'monday' },
      })
    ).toEqual({ mcpServerName: 'monday' })
  })

  it('projects only mcpServerName, dropping any extra fields', () => {
    expect(
      extractConnectRequiredMarker({
        connect_required: { mcpServerName: 'clickup', provider: 'x' },
      })
    ).toEqual({ mcpServerName: 'clickup' })
  })

  it('returns null for absent/malformed markers (no server → no suspension)', () => {
    expect(extractConnectRequiredMarker(undefined)).toBeNull()
    expect(extractConnectRequiredMarker({})).toBeNull()
    expect(extractConnectRequiredMarker({ connect_required: null })).toBeNull()
    expect(extractConnectRequiredMarker({ connect_required: {} })).toBeNull()
    expect(extractConnectRequiredMarker({ connect_required: { foo: 'bar' } })).toBeNull()
    expect(extractConnectRequiredMarker({ connect_required: [] })).toBeNull()
  })
})

describe('buildConnectRequiredApproval', () => {
  it('builds a connect_required PendingApproval carrying the tool coordinates', () => {
    const approval = buildConnectRequiredApproval(
      { id: 'call-1', name: 'monday__list_boards', arguments: { limit: 5 } },
      { mcpServerName: 'monday' }
    )
    expect(approval.reason).toBe('connect_required')
    expect(approval.mcpServerName).toBe('monday')
    expect(approval.tool_name).toBe('monday__list_boards')
    expect(approval.tool_call_id).toBe('call-1')
    expect(approval.parameters).toEqual({ limit: 5 })
    expect(approval.tool_kind).toBe('mcp_server_tool')
    expect(approval.tool_source_ref).toBe('monday')
    expect(typeof approval.request_id).toBe('string')
  })
})
