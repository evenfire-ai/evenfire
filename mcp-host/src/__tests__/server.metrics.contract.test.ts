import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { RPCServer } from '../server'

describe('RPCServer metrics contract', () => {
  it('exposes process and MCP status-heartbeat metrics without runtime auth', async () => {
    const server = new RPCServer(0)
    await server.start()
    const address = (server as unknown as { server: { address(): AddressInfo } }).server.address()

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/metrics`)
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('process_cpu_user_seconds_total')
      expect(body).toContain('clerum_mcp_status_heartbeat_runs_total')
      expect(body).toContain('clerum_mcp_status_heartbeat_in_flight')
    } finally {
      await server.stop()
    }
  })
})
