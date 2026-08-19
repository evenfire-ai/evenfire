import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_CREDENTIAL_SLOTS, PROVIDER_IDS } from '@clerum/llm-providers'

// The dev/e2e shell scripts enumerate the provider list BY HAND (mirrored from
// PROVIDER_CREDENTIAL_SLOTS). Nothing type-checks them, so a provider added to
// the shared package but not to these scripts ships green and only fails at
// runtime — a Host with the new provider can't resolve its credential in the
// local T1/T2 / e2e lanes. This test derives the expected tokens from the real
// registry (never a hand-written list) and asserts every provider is mirrored,
// so the class of omission that missed `minimax` cannot recur silently.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8')

describe('hand-maintained provider mirrors (shell scripts)', () => {
  it('apply-llm-secret.sh SLOTS carries every credential slot dataKey', () => {
    const script = read('scripts/minikube/apply-llm-secret.sh')
    for (const id of PROVIDER_IDS) {
      for (const slot of PROVIDER_CREDENTIAL_SLOTS[id]) {
        expect(script, `missing slot ${slot.dataKey} (${id})`).toContain(
          `${slot.dataKey}|${slot.envName}|`
        )
      }
    }
  })

  it('check-prereqs.sh PROVIDER_KEYS maps every provider to its primary env', () => {
    const script = read('scripts/check-prereqs.sh')
    for (const id of PROVIDER_IDS) {
      const primaryEnv = PROVIDER_CREDENTIAL_SLOTS[id][0].envName
      expect(script, `missing provider key ${id}:${primaryEnv}`).toContain(`${id}:${primaryEnv}`)
    }
  })

  it('both e2e scripts have a provider->slot case arm for every provider', () => {
    const scripts = ['scripts/e2e/e2e-plugin-workload-sdk.sh', 'scripts/e2e/seed-e2e-data.sh']
    for (const rel of scripts) {
      const script = read(rel)
      for (const id of PROVIDER_IDS) {
        const primarySlot = PROVIDER_CREDENTIAL_SLOTS[id][0].dataKey
        expect(script, `${rel}: missing case arm ${id})`).toContain(`${id})`)
        expect(script, `${rel}: ${id}) arm must resolve ${primarySlot}`).toContain(primarySlot)
      }
    }
  })
})
