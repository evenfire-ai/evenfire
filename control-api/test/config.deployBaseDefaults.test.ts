import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as YAML from 'yaml'

// configmaps.yaml says the approval TTL cap is "also the code default", and the
// allowlist default is documented as the deploy/base list plus the Evenfire
// registry. Each case reads both sides, so moving one without the other fails here.
const MANIFEST = new URL('../../deploy/base/control-plane/configmaps.yaml', import.meta.url)
const ORIGINAL_ENV = { ...process.env }

function baseValue(name: string): string {
  const configMap = YAML.parseAllDocuments(readFileSync(MANIFEST, 'utf8'))
    .map(doc => doc.toJS())
    .find(doc => doc?.kind === 'ConfigMap' && doc.metadata?.name === 'control-api-config')
  const value = configMap?.data?.[name]
  if (typeof value !== 'string') throw new Error(`${name} is not in control-api-config`)
  return value
}

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.WORKFLOW_APPROVAL_MAX_TTL_SEC
  delete process.env.CONTROL_API_ALLOWED_IMAGE_PREFIXES
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  vi.resetModules()
})

describe('control-api code defaults against deploy/base', () => {
  it('the approval TTL cap equals the deploy/base value', async () => {
    const { config } = await import('../src/config.js')
    expect(String(config.userApprovalRequestMaxTtlSec)).toBe(
      baseValue('WORKFLOW_APPROVAL_MAX_TTL_SEC')
    )
  })

  it('the plugin image allowlist default is the deploy/base list plus the Evenfire registry', async () => {
    const { config } = await import('../src/config.js')
    expect(config.allowedPluginImagePrefixes).toEqual([
      ...baseValue('CONTROL_API_ALLOWED_IMAGE_PREFIXES').split(','),
      'registry.evenfire.ai/',
    ])
  })
})
