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
