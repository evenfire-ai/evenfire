import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMcpStatusHeartbeatDuration } from '../config'

describe('MCP status heartbeat configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses documented defaults for unset or blank values', () => {
    expect(
      parseMcpStatusHeartbeatDuration('CLERUM_MCP_STATUS_HEARTBEAT_INTERVAL', undefined, 30_000)
    ).toBe(30_000)
    expect(
      parseMcpStatusHeartbeatDuration('CLERUM_MCP_STATUS_HEARTBEAT_TIMEOUT_MS', '   ', 25_000)
    ).toBe(25_000)
  })

  it.each(['0', '-1', '1.5', '30ms', '9007199254740992'])('rejects %s', raw => {
    expect(() =>
      parseMcpStatusHeartbeatDuration('CLERUM_MCP_STATUS_HEARTBEAT_INTERVAL', raw, 30_000)
    ).toThrow("CLERUM_MCP_STATUS_HEARTBEAT_INTERVAL='" + raw + "' is not a positive safe integer")
  })

  it('accepts an explicit positive safe integer', () => {
    expect(
      parseMcpStatusHeartbeatDuration('CLERUM_MCP_STATUS_HEARTBEAT_TIMEOUT_MS', '25000', 25_000)
    ).toBe(25_000)
  })
})
