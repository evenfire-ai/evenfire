/**
 * E2E: Resilience — verify recovery from pod restarts.
 *
 * NOTE: Pod deletion breaks kubectl port-forward. These tests verify recovery
 * via kubectl exec (in-cluster) rather than HTTP through port-forward.
 */
import { describe, expect, it } from 'vitest'
import { kubectl, sleep } from '../helpers.js'

const MCP_HOST_NS = process.env.E2E_MCP_HOST_NAMESPACE ?? 'mcp-host'

function assertResourceName(value: string): string {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
    throw new Error(`Invalid Kubernetes resource name: ${value}`)
  }
  return value
}

function detectMcpHostRuntime(): { deployment: string; service: string; label: string } {
  const configured = process.env.E2E_MCP_HOST_DEPLOYMENT
    ? [process.env.E2E_MCP_HOST_DEPLOYMENT]
    : []
  const candidates = [...configured, 'chatllm', 'mcp-host']

  for (const candidate of candidates) {
    const name = assertResourceName(candidate)
    try {
      kubectl(`get deployment ${name} -n ${MCP_HOST_NS} -o name`)
      return { deployment: name, service: name, label: `app=${name}` }
    } catch {
      // Try the next supported runtime name.
    }
  }

  throw new Error(`No mcp-host runtime deployment found in namespace ${MCP_HOST_NS}`)
}

describe('Resilience', () => {
  it('mcp-host recovers after pod delete', async () => {
    const runtime = detectMcpHostRuntime()

    // Delete the pod (Kubernetes will recreate it)
    kubectl(`delete pod -n ${MCP_HOST_NS} -l ${runtime.label} --force --grace-period=0`)

    // Wait for the new pod to be ready
    kubectl(`wait --for=condition=ready pod -n ${MCP_HOST_NS} -l ${runtime.label} --timeout=90s`)

    // Give it time to fully initialize (CRD watch, host-context-controller polling)
    await sleep(5000)

    // Verify health via kubectl exec (port-forward is broken after pod delete)
    const health = kubectl(
      `exec -n ${MCP_HOST_NS} deploy/${runtime.deployment} -- wget -qO- http://localhost:8080/v1/runtime/health`
    )
    expect(health).toContain('"ok"')

    // Verify agent is idle
    const status = kubectl(
      `exec -n ${MCP_HOST_NS} deploy/${runtime.deployment} -- wget -qO- http://localhost:8080/v1/runtime/status`
    )
    expect(status).toContain('"idle"')
  })

  it('host-context-controller recovers after pod delete', async () => {
    kubectl('delete pod -n control-plane -l app=host-context-controller --force --grace-period=0')
    kubectl(
      'wait --for=condition=ready pod -n control-plane -l app=host-context-controller --timeout=90s'
    )
    await sleep(3000)

    // Verify health via kubectl exec
    const health = kubectl(
      'exec -n control-plane deploy/host-context-controller -- wget -qO- http://localhost:8081/health'
    )
    expect(health).toContain('"ok"')
  })

  it('re-establish port-forwarding after pod restarts', async () => {
    const runtime = detectMcpHostRuntime()

    // Restart port-forwarding for subsequent test suites
    try {
      kubectl(`port-forward -n ${MCP_HOST_NS} svc/${runtime.service} 8080:8080 &`)
    } catch {
      // port-forward runs in background, kubectl returns immediately
    }
    try {
      kubectl('port-forward -n control-plane svc/host-context-controller 8081:8081 &')
    } catch {
      // same
    }
    await sleep(2000)
  })
})
