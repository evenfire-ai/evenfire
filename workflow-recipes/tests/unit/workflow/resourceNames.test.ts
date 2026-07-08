import { describe, expect, it } from 'vitest'
import {
  buildArtifactReaderServiceName,
  buildArtifactReaderUrl,
  buildMcpHostRouteAliasKey,
  buildMcpHostRouteAliasServiceName,
  buildMcpHostRouteAliasUrl,
  buildMcpHostServiceName,
  buildMcpHostUrl,
} from '../../../src/workflow/resourceNames'

describe('workflow resource names', () => {
  it('keeps the legacy mcp-host service name for short recipes', () => {
    expect(buildMcpHostServiceName('my-wf')).toBe('wf-my-wf-mcp-host')
  })

  it('normalizes dotted recipe names into DNS-safe service names', () => {
    expect(buildMcpHostServiceName('finance.v1')).toBe('wf-finance-v1-mcp-host')
    expect(buildArtifactReaderServiceName('finance.v1')).toBe('wf-finance-v1-artifact-reader')
  })

  it('truncates long mcp-host service names to fit the kubernetes 63-char limit', () => {
    const recipeName = 'e2e-ondemand-approval-9ade863f-5368-4850-9016-510293e56f76'
    const name = buildMcpHostServiceName(recipeName)

    expect(name.length).toBeLessThanOrEqual(63)
    expect(name).toMatch(/^wf-[a-z0-9-]+-mcp-host$/)
    expect(name).toContain('-mcp-host')
  })

  it('builds the mcp-host URL from the truncated service name', () => {
    const recipeName = 'e2e-ondemand-simple-8b94b2cb-256d-45ec-ac90-2b76e4e555f0'
    const serviceName = buildMcpHostServiceName(recipeName)

    expect(buildMcpHostUrl(recipeName, 'sandbox-recipes')).toBe(
      `http://${serviceName}.sandbox-recipes.svc.cluster.local:8080`
    )
  })

  it('builds a short mcp-host route alias for Telegram callback routing', () => {
    const recipeName = 'e2e-ondemand-simple-8b94b2cb-256d-45ec-ac90-2b76e4e555f0'
    const aliasKey = buildMcpHostRouteAliasKey(recipeName, 'sandbox-recipes')
    const serviceName = buildMcpHostRouteAliasServiceName(recipeName, 'sandbox-recipes')

    expect(aliasKey).toMatch(/^[0-9a-f]{16}$/)
    expect(serviceName).toBe(`wf-${aliasKey}-mcp-host`)
    expect(serviceName.length).toBeLessThanOrEqual(63)
    expect(buildMcpHostRouteAliasUrl(recipeName, 'sandbox-recipes')).toBe(
      `http://${serviceName}.sandbox-recipes.svc.cluster.local:8080`
    )
  })

  it('builds a distinct artifact-reader service and URL for pure workflow artifacts', () => {
    const recipeName = 'e2e-ondemand-simple-8b94b2cb-256d-45ec-ac90-2b76e4e555f0'
    const serviceName = buildArtifactReaderServiceName(recipeName)

    expect(serviceName.length).toBeLessThanOrEqual(63)
    expect(serviceName).toMatch(/^wf-[a-z0-9-]+-artifact-reader$/)
    expect(buildArtifactReaderUrl(recipeName, 'sandbox-recipes')).toBe(
      `http://${serviceName}.sandbox-recipes.svc.cluster.local:8080`
    )
  })
})
