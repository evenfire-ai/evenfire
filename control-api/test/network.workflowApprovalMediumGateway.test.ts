import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function readBaseControlPlaneConfigmaps(): string {
  return readFileSync(
    new URL('../../deploy/base/control-plane/configmaps.yaml', import.meta.url),
    'utf-8'
  )
}

function yamlDocs(content: string): string[] {
  return content
    .split(/\n---\n/)
    .map(d => d.trim())
    .filter(Boolean)
}

function docContaining(docs: string[], substring: string): string {
  const hit = docs.find(d => d.includes(substring))
  if (!hit) throw new Error(`No YAML document containing: ${substring}`)
  return hit
}

function locationBlock(config: string, marker: string): string {
  const start = config.indexOf(marker)
  if (start < 0) throw new Error(`No gateway location containing: ${marker}`)
  const next = config.indexOf('\n        location ', start + marker.length)
  return next < 0 ? config.slice(start) : config.slice(start, next)
}

describe('workflow approval medium gateway routes', () => {
  it('exposes Telegram provider-event confirmations only through the mcp-host JWT gateway route', () => {
    const gatewayConf = docContaining(
      yamlDocs(readBaseControlPlaneConfigmaps()),
      'name: nginx-workflow-approval-gateway'
    )

    expect(gatewayConf).not.toContain(
      '/api/v1/internal/workflow-approval-mediums/telegram/challenges/confirm-provider-event'
    )
    const route = locationBlock(
      gatewayConf,
      'location = /api/v1/workflow-approval-mediums/telegram/challenges/confirm-provider-event'
    )

    expect(route).toContain('limit_except POST')
    expect(route).toContain('proxy_set_header Authorization $http_authorization;')
    expect(route).not.toContain('proxy_set_header x-service-token $http_x_service_token;')
    expect(gatewayConf).not.toContain('/api/v1/admin/workflow-approval-mediums')
  })
})
