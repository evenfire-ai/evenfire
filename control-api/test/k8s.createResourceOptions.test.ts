import { describe, expect, it, vi } from 'vitest'
import { K8sGateway } from '../src/k8s.js'

// The Host intent summary (spec 2026-11-24-control-ui-approval-settings §6.8)
// reaches ResourceService through K8sGateway; dropping the forward would lose
// the summary silently, because the route harness binds the service directly.
function makeGateway() {
  const createResource = vi.fn().mockResolvedValue({})
  const updateResource = vi.fn().mockResolvedValue({})
  const gateway = Object.create(K8sGateway.prototype) as K8sGateway
  Object.defineProperty(gateway, 'resources', { value: { createResource, updateResource } })
  return { gateway, createResource, updateResource }
}

describe('K8sGateway forwards the approval change summary', () => {
  const body = { metadata: { name: 'foo' }, spec: {} }

  it('createResource forwards its options', async () => {
    const { gateway, createResource } = makeGateway()
    await gateway.createResource('hosts', body, 'mcp-host', { approvalChangeSummary: '{}' })
    expect(createResource).toHaveBeenCalledWith('hosts', body, 'mcp-host', {
      approvalChangeSummary: '{}',
    })
  })

  it('updateResource forwards its options', async () => {
    const { gateway, updateResource } = makeGateway()
    await gateway.updateResource('hosts', 'foo', body, 'mcp-host', { approvalChangeSummary: '{}' })
    expect(updateResource).toHaveBeenCalledWith('hosts', 'foo', body, 'mcp-host', {
      approvalChangeSummary: '{}',
    })
  })
})
