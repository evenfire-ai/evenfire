import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as YAML from 'yaml'

const ENV_NAME = 'CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL'
const MANIFEST = path.resolve(
  __dirname,
  '../../deploy/base/control-plane/host-context-controller.yaml'
)
const originalEnv = process.env

async function loadConfigWith(value: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (value === undefined) delete process.env[ENV_NAME]
  else process.env[ENV_NAME] = value
  return import('../src/config')
}

function shippedSelector(): string {
  const deployment = YAML.parseAllDocuments(readFileSync(MANIFEST, 'utf8'))
    .map(doc => doc.toJS())
    .find(doc => doc?.kind === 'Deployment' && doc.metadata?.name === 'host-context-controller')
  const entries = (
    deployment?.spec?.template?.spec?.containers as
      | Array<{ name: string; env?: Array<{ name: string; value?: string }> }>
      | undefined
  )
    ?.find(container => container.name === 'host-context-controller')
    ?.env?.filter(entry => entry.name === ENV_NAME)
  if (entries?.length !== 1 || entries[0]!.value === undefined) {
    throw new Error(`${ENV_NAME}: expected one literal env entry in ${MANIFEST}`)
  }
  return entries[0]!.value
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('config.hostRpcProxyEdgeProtocol', () => {
  it('loads signed-assertion-v1', async () => {
    const { config } = await loadConfigWith('signed-assertion-v1')
    expect(config.hostRpcProxyEdgeProtocol).toBe('signed-assertion-v1')
  })

  it('loads the selector value deploy/base ships', async () => {
    const shipped = shippedSelector()
    const { config } = await loadConfigWith(shipped)
    expect(config.hostRpcProxyEdgeProtocol).toBe(shipped)
  })

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['legacy-headers', 'legacy-headers'],
    ['dedicated-header-v1', 'dedicated-header-v1'],
    ['an unknown value', 'signed-assertion-v2'],
  ])('refuses to load when the selector is %s', async (_case, value) => {
    await expect(loadConfigWith(value)).rejects.toThrow(
      'CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL must be signed-assertion-v1'
    )
  })
})
