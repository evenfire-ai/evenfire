import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// Validate admission before the inherited global setup can contact services.
// A missing opt-in is a failed explicit lane, never a successful all-skipped run.
const UPSTREAM_CONFIRM: Record<string, string> = {
  'codex-subscription': 'CODEX_REAL_UPSTREAM_CONFIRM',
  'grok-subscription': 'GROK_REAL_UPSTREAM_CONFIRM',
}
const provider = process.env.E2E_NATIVE_DISCOVERY_PROVIDER ?? ''
const confirm = UPSTREAM_CONFIRM[provider]
if (!confirm) {
  throw new Error(
    `Native discovery lane requires E2E_NATIVE_DISCOVERY_PROVIDER in ${Object.keys(UPSTREAM_CONFIRM).join(', ')}`
  )
}
for (const name of ['E2E_NATIVE_DISCOVERY', confirm, 'E2E_NATIVE_DISCOVERY_ALLOW_SESSION_RESET']) {
  if (process.env[name] !== '1') throw new Error(`Native discovery lane requires ${name}=1`)
}
for (const name of [
  'E2E_K8S_CONTEXT',
  'E2E_HOST_REF',
  'E2E_NATIVE_DISCOVERY_HOST_LABEL',
  'E2E_NATIVE_DISCOVERY_MODEL',
]) {
  if (!process.env[name]?.trim()) throw new Error(`Native discovery lane requires explicit ${name}`)
}
if (!['direct', 'auto'].includes(process.env.E2E_EXPECTED_NATIVE_TOOL_PRESENTATION ?? '')) {
  throw new Error(
    'Native discovery lane requires E2E_EXPECTED_NATIVE_TOOL_PRESENTATION=direct|auto'
  )
}

export default defineConfig({
  ...base,
  // Real upstream turns, including search → describe → call, can take minutes.
  timeout: 600_000,
  projects: [{ name: 'native-tool-discovery', testMatch: '**/native-tool-discovery.spec.ts' }],
})
