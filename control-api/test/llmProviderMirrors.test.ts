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
      // These scripts have more than one `case` over providers (a model-name
      // block and a credential-slot block), so match on the arm LINES, not the
      // whole file: at least one `id)` arm must resolve this provider's slot.
      // That catches an absent arm and a mis-wired one, while tolerating the
      // multiple case blocks.
      const lines = read(rel).split('\n')
      for (const id of PROVIDER_IDS) {
        const primarySlot = PROVIDER_CREDENTIAL_SLOTS[id][0].dataKey
        const idArms = lines.filter(line => line.trimStart().startsWith(`${id})`))
        expect(idArms.length, `${rel}: missing case arm ${id})`).toBeGreaterThan(0)
        expect(
          // Match the arm's CODE only — strip any trailing `# comment` so an
          // annotated-but-mis-wired arm can't pass on the comment text.
          idArms.some(arm => arm.split('#')[0].includes(primarySlot)),
          `${rel}: no ${id}) arm resolves ${primarySlot}`
        ).toBe(true)
      }
    }
  })
})
