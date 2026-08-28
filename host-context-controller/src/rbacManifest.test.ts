import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('host-context-controller RBAC manifest', () => {
  it('can patch McpServer metadata annotations in the mcp-server namespace', () => {
    const manifest = readFileSync(
      path.join(__dirname, '../../deploy/base/mcp-server/rbac.yaml'),
      'utf8'
    )

    const role = manifest
      .split('name: host-context-controller\n  namespace: mcp-server\nrules:')[1]
      ?.split('---')[0]

    expect(role).toBeTruthy()
    const mcpServerRule = role?.match(/resources: \["mcpservers"\]\n\s+verbs: \[([^\]]+)\]/)

    expect(mcpServerRule?.[1]).toContain('"patch"')
  })

  it('can reconcile LlmHook workloads and read pods in the llm-hooks namespace', () => {
    const manifest = readFileSync(
      path.join(__dirname, '../../deploy/base/llm-hooks/rbac.yaml'),
      'utf8'
    )

    const role = manifest
      .split('name: host-context-controller\n  namespace: llm-hooks\nrules:')[1]
      ?.split('---')[0]

    expect(role).toBeTruthy()

    // llmhooks: watch + patch (status write-back path)
    const llmhooksRule = role?.match(/resources: \["llmhooks"\]\n\s+verbs: \[([^\]]+)\]/)
    expect(llmhooksRule?.[1]).toContain('"watch"')
    expect(llmhooksRule?.[1]).toContain('"patch"')

    // llmhooks/status: patch
    const statusRule = role?.match(/resources: \["llmhooks\/status"\]\n\s+verbs: \[([^\]]+)\]/)
    expect(statusRule?.[1]).toContain('"patch"')

    // pods get/list — required for status.observedDigest (live pod image)
    const podsRule = role?.match(/resources: \["pods"\]\n\s+verbs: \[([^\]]+)\]/)
    expect(podsRule?.[1]).toContain('"get"')
    expect(podsRule?.[1]).toContain('"list"')

    // networkpolicies + deployments + services managed by HCC
    expect(role).toContain('resources: ["networkpolicies"]')
    expect(role).toContain('resources: ["deployments"]')
    expect(role).toContain('resources: ["services"]')

    // Bound to the HCC ServiceAccount in control-plane
    expect(manifest).toContain('kind: ServiceAccount')
    expect(manifest).toMatch(/name: host-context-controller\n\s+namespace: control-plane/)
  })

  it('can reconcile GFS writer PodDisruptionBudgets in the gfs namespace', () => {
    const manifest = readFileSync(path.join(__dirname, '../../deploy/base/gfs/rbac.yaml'), 'utf8')

    const role = manifest
      .split('name: host-context-controller-gfs-runtime\n  namespace: gfs')[1]
      ?.split('---')[0]

    expect(role).toBeTruthy()
    expect(role).toContain("apiGroups: ['policy']")
    expect(role).toContain("resources: ['poddisruptionbudgets']")
    expect(role).toContain("verbs: ['get', 'create', 'update', 'delete']")
  })
})
