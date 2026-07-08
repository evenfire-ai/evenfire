/**
 * E2E: CRD Integrity — verify CRDs are installed and instances exist.
 */
import { describe, expect, it } from 'vitest'
import { kubectl } from '../helpers.js'

describe('CRD Integrity', () => {
  it('all 4 CRDs are installed', () => {
    const output = kubectl('get crds -o name')
    expect(output).toContain('hosts.clerum.io')
    expect(output).toContain('contexts.clerum.io')
    expect(output).toContain('mcpservers.clerum.io')
    expect(output).toContain('communicationchannels.clerum.io')
  })

  it('Host CRD instance "chatllm" exists with expected spec', () => {
    const raw = kubectl('get host chatllm -n mcp-host -o json')
    const host = JSON.parse(raw)
    expect(host.spec.host).toBe('chatLLM')
    expect(host.spec.contextRef).toBe('context1')
    expect(host.spec.secretRef).toBe('chatllm-api-keys')
  })

  it('Context CRD instance "context1" exists with mcpServers list', () => {
    const raw = kubectl('get context context1 -n mcp-server -o json')
    const ctx = JSON.parse(raw)
    expect(ctx.spec.contextId).toBe('context1')
    expect(Array.isArray(ctx.spec.mcpServers)).toBe(true)
    expect(ctx.spec.mcpServers.length).toBeGreaterThan(0)
  })

  it('context1 references installed McpServer CRDs', () => {
    const rawContext = kubectl('get context context1 -n mcp-server -o json')
    const ctx = JSON.parse(rawContext)
    const firstServer = ctx.spec.mcpServers[0]
    const rawServer = kubectl(`get mcpserver ${firstServer} -n mcp-server -o json`)
    const server = JSON.parse(rawServer)
    expect(server.metadata.name).toBe(firstServer)
    expect(server.spec.transport).toBeDefined()
  })
})
