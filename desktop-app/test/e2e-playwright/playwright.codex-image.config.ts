import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// Validate admission before the inherited global setup can contact services.
// A missing opt-in is a failed explicit lane, never a successful all-skipped run.
for (const name of [
  'E2E_CODEX_IMAGE_INPUT',
  'CODEX_REAL_UPSTREAM_CONFIRM',
  'E2E_CODEX_ALLOW_SESSION_RESET',
]) {
  if (process.env[name] !== '1') throw new Error(`Codex image lane requires ${name}=1`)
}
for (const name of [
  'E2E_HOST_REF',
  'E2E_CODEX_HOST_LABEL',
  'E2E_CODEX_IMAGE_MODEL',
  'E2E_CODEX_IMAGE_MODEL_LABEL',
]) {
  if (!process.env[name]?.trim()) throw new Error(`Codex image lane requires explicit ${name}`)
}

export default defineConfig({
  ...base,
  projects: [{ name: 'codex-image-input', testMatch: '**/codex-image-input.spec.ts' }],
})
