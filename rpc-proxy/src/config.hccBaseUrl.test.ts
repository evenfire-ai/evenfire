import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The dev default for RPC_PROXY_HCC_BASE_URL must name the same HCC endpoint the
 * deployed configmap injects. They drifted once: the default pointed at
 * host-context-controller.mcp-server (a Service that exists in no overlay, and
 * one the rpc-proxy egress NetworkPolicy would block anyway — it only permits
 * the api-gateway peer), while the real target is
 * host-context-controller-api-gateway.control-plane. NODE_ENV=production is
 * baked into the image so the default is unreachable in-cluster today, but a
 * developer running rpc-proxy locally would inherit the wrong endpoint. Pin the
 * two together so they cannot silently diverge again.
 */
describe('rpc-proxy HCC base URL default', () => {
  const repoRoot = path.join(__dirname, '../..')

  const configSource = readFileSync(path.join(__dirname, 'config.ts'), 'utf8')
  const defaultMatch = configSource.match(
    /requiredOrDevDefault\(\s*'RPC_PROXY_HCC_BASE_URL',\s*(?:\/\/[^\n]*\n\s*)*'([^']+)'/
  )

  const configmap = readFileSync(
    path.join(repoRoot, 'deploy/overlays/minikube/configmaps/rpc-proxy-config.yaml'),
    'utf8'
  )
  const configmapMatch = configmap.match(/RPC_PROXY_HCC_BASE_URL:\s*"?([^"\n]+)"?/)

  // Derive the real endpoint from the api-gateway manifest itself, so renaming
  // the Service or moving its port breaks this test unless the dev default and
  // configmap are updated in lockstep — no hand-copied literal to drift.
  const gatewayManifest = readFileSync(
    path.join(repoRoot, 'deploy/base/control-plane/host-context-controller-api-gateway.yaml'),
    'utf8'
  )
  const serviceDoc = gatewayManifest.split(/^---$/m).find(doc => /\bkind:\s*Service\b/.test(doc))
  const serviceName = serviceDoc?.match(/\bmetadata:[\s\S]*?\bname:\s*([\w.-]+)/)?.[1]
  const serviceNamespace = serviceDoc?.match(/\bnamespace:\s*([\w.-]+)/)?.[1]
  const servicePort = serviceDoc?.match(/\bports:[\s\S]*?\bport:\s*(\d+)/)?.[1]

  it('parses all three sources', () => {
    expect(defaultMatch?.[1]).toBeTruthy()
    expect(configmapMatch?.[1]).toBeTruthy()
    expect(serviceName).toBeTruthy()
    expect(serviceNamespace).toBeTruthy()
    expect(servicePort).toBeTruthy()
  })

  it('dev default matches the deployed configmap endpoint', () => {
    expect(defaultMatch?.[1]).toBe(configmapMatch?.[1]?.trim())
  })

  it('targets the api-gateway Service exactly as the gateway manifest declares it', () => {
    const url = new URL(defaultMatch![1])
    expect(url.hostname).toBe(`${serviceName}.${serviceNamespace}.svc.cluster.local`)
    expect(url.port).toBe(servicePort)
  })
})
