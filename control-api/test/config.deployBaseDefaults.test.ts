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

  for (const [flag, field] of [
    ['CONTROL_API_CODEX_SUBSCRIPTION_ENABLED', 'codexSubscriptionEnabled'],
    ['CONTROL_API_GROK_SUBSCRIPTION_ENABLED', 'grokSubscriptionEnabled'],
  ] as const) {
    it(`${flag} defaults to the deploy/base value (on)`, async () => {
      delete process.env[flag]
      const { config } = await import('../src/config.js')
      expect(config[field]).toBe(true)
      expect(String(config[field])).toBe(baseValue(flag))
    })

    it(`${flag} accepts empty, true and false`, async () => {
      for (const [raw, expected] of [
        ['', true],
        ['true', true],
        ['false', false],
      ] as const) {
        vi.resetModules()
        process.env[flag] = raw
        const { config } = await import('../src/config.js')
        expect(config[field], `${flag}='${raw}'`).toBe(expected)
      }
    })

    it(`${flag} refuses any other value at startup`, async () => {
      for (const raw of ['TRUE', '0', 'off', 'true\n']) {
        vi.resetModules()
        process.env[flag] = raw
        await expect(import('../src/config.js'), `${flag}=${JSON.stringify(raw)}`).rejects.toThrow(
          new RegExp(`${flag} must be 'true' or 'false'`)
        )
      }
    })
  }

  it('the plugin image allowlist default is the deploy/base list plus the Evenfire registry', async () => {
    const { config } = await import('../src/config.js')
    expect(config.allowedPluginImagePrefixes).toEqual([
      ...baseValue('CONTROL_API_ALLOWED_IMAGE_PREFIXES').split(','),
      'registry.evenfire.ai/',
    ])
  })
})
