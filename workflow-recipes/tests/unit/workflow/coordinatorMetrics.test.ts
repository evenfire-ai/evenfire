import { describe, expect, it } from 'vitest'
import { once } from 'node:events'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { registry } from '../../../src/metrics'
import { startCoordinatorHealthServer } from '../../../src/workflow/coordinatorHttpServer'

async function get(server: http.Server, path: string): Promise<{ status: number; body: string }> {
  const { port } = server.address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
  })
}

describe('coordinator metrics endpoint', () => {
  it('serves Prometheus metrics from the coordinator health server', async () => {
    const server = startCoordinatorHealthServer({
      port: 0,
      getPhase: () => 'running',
      metricsRegistry: registry,
    })
    try {
      await once(server, 'listening')
      const response = await get(server, '/metrics')

      expect(response.status).toBe(200)
      expect(response.body).toContain('# HELP workflow_step_total')
      expect(response.body).toContain('# HELP workflow_step_duration_seconds')
      expect(response.body).toBe(await registry.metrics())
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
