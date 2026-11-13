import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadAll } from 'js-yaml'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config'

// deploy/base says "both equal the code defaults". Each case reads both sides, so
// moving one without the other fails here. Overlays may differ: minikube pins the
// overlap through its own patch, checked by test-wrc-egress-gate-overlap-render.sh.
const MANIFEST = path.resolve(__dirname, '../../deploy/base/control-plane/workflow-recipes.yaml')

type WrcContainer = { name: string; env: Array<{ name: string; value?: string }> }
type ManifestDoc = {
  kind?: string
  metadata?: { name?: string }
  spec?: { template?: { spec?: { containers?: WrcContainer[] } } }
}

function baseValue(name: string): string {
  const deployment = (loadAll(readFileSync(MANIFEST, 'utf8')) as ManifestDoc[]).find(
    doc => doc?.kind === 'Deployment' && doc.metadata?.name === 'workflow-recipes'
  )
  const container = deployment?.spec?.template?.spec?.containers?.find(
    c => c.name === 'workflow-recipes'
  )
  if (!container) throw new Error(`no workflow-recipes container in ${MANIFEST}`)
  const entries = container.env.filter(entry => entry.name === name)
  if (entries.length !== 1 || entries[0].value === undefined) {
    throw new Error(`${name}: expected one literal env entry in deploy/base, got ${entries.length}`)
  }
  return entries[0].value
}

describe('WRC code defaults against deploy/base', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS
    delete process.env.WRC_EXTERNAL_EGRESS_MAX_ENTRIES
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('the external-egress overlap equals the deploy/base value', () => {
    expect(String(loadConfig().externalEgressOverlapSeconds)).toBe(
      baseValue('WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS')
    )
  })

  it('the external-egress entry cap equals the deploy/base value', () => {
    expect(String(loadConfig().externalEgressMaxEntries)).toBe(
      baseValue('WRC_EXTERNAL_EGRESS_MAX_ENTRIES')
    )
  })

  it('the Grok subscription switch default equals the deploy/base value (on)', () => {
    delete process.env.WRC_GROK_SUBSCRIPTION_ENABLED
    expect(loadConfig().grokSubscriptionEnabled).toBe(true)
    expect(String(loadConfig().grokSubscriptionEnabled)).toBe(
      baseValue('WRC_GROK_SUBSCRIPTION_ENABLED')
    )
  })
})

describe('WRC Grok subscription switch parsing', () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
  })

  it('is on when unset, empty, true in any case or 1, and off for false, 0 or other values', () => {
    for (const [raw, expected] of [
      [undefined, true],
      ['', true],
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['false', false],
      ['0', false],
      ['off', false],
    ] as const) {
      process.env = { ...originalEnv }
      if (raw === undefined) delete process.env.WRC_GROK_SUBSCRIPTION_ENABLED
      else process.env.WRC_GROK_SUBSCRIPTION_ENABLED = raw
      expect(loadConfig().grokSubscriptionEnabled, String(raw)).toBe(expected)
    }
  })
})
