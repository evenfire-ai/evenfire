import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as YAML from 'yaml'

// config.ts and the manifest both say these defaults equal deploy/base. Each case
// reads both sides, so moving one without the other fails here.
const MANIFEST = path.resolve(
  __dirname,
  '../../deploy/base/control-plane/host-context-controller.yaml'
)
const VARIABLES = [
  'CONTEXT_MAPPER_RUNTIME_NAMESPACES',
  'CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES',
  'HCC_EXTERNAL_EGRESS_OVERLAP_SEC',
  'CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES',
  'CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET',
  'CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET',
  'CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS',
] as const
const originalEnv = process.env

type HccContainer = {
  name: string
  env: Array<{ name: string; value?: string }>
  envFrom?: unknown[]
}

function hccContainer(): HccContainer {
  const deployment = YAML.parseAllDocuments(readFileSync(MANIFEST, 'utf8'))
    .map(doc => doc.toJS())
    .find(doc => doc?.kind === 'Deployment' && doc.metadata?.name === 'host-context-controller')
  const container = (
    deployment?.spec?.template?.spec?.containers as HccContainer[] | undefined
  )?.find(c => c.name === 'host-context-controller')
  if (!container) throw new Error(`no host-context-controller container in ${MANIFEST}`)
  return container
}

function baseValue(name: string): string {
  const entries = hccContainer().env.filter(entry => entry.name === name)
  if (entries.length !== 1 || entries[0].value === undefined) {
    throw new Error(`${name}: expected one literal env entry in deploy/base, got ${entries.length}`)
  }
  return entries[0].value
}

async function codeDefaults() {
  vi.resetModules()
  process.env = { ...originalEnv }
  for (const name of VARIABLES) delete process.env[name]
  return (await import('./config')).config
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('HCC code defaults against deploy/base', () => {
  it('runtime namespaces equal the deploy/base value', async () => {
    const config = await codeDefaults()
    expect(config.runtimeNamespaces.join(',')).toBe(baseValue('CONTEXT_MAPPER_RUNTIME_NAMESPACES'))
  })

  it('minimal-infra namespaces equal the deploy/base value', async () => {
    const config = await codeDefaults()
    expect(config.minimalInfraNamespaces.join(',')).toBe(
      baseValue('CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES')
    )
  })

  it('the external-egress overlap equals the deploy/base value', async () => {
    const config = await codeDefaults()
    expect(String(config.externalEgressOverlapSec)).toBe(
      baseValue('HCC_EXTERNAL_EGRESS_OVERLAP_SEC')
    )
  })

  it('the plugin image allowlist default is the deploy/base list plus the Evenfire registry', async () => {
    const config = await codeDefaults()
    expect(config.allowedPluginImagePrefixes).toEqual([
      ...baseValue('CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES').split(','),
      'registry.evenfire.ai/',
    ])
  })

  it('deploy/base leaves the pull Secrets and the workspace StorageClass to a code default of none', async () => {
    const container = hccContainer()
    const names = container.env.map(entry => entry.name)
    // Witness: this is the env list the other cases read.
    expect(names).toContain('CONTEXT_MAPPER_RUNTIME_NAMESPACES')
    expect(container.envFrom ?? []).toEqual([])
    expect(names).not.toContain('CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET')
    expect(names).not.toContain('CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET')
    expect(names).not.toContain('CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS')

    const config = await codeDefaults()
    expect(config.hostImagePullSecretName).toBe('')
    expect(config.wfcImagePullSecretName).toBe('')
    expect(config.hostWorkspaceStorageClassName).toBeUndefined()
  })
})
