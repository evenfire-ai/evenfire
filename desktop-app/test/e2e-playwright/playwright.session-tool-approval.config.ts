import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// Validate admission before the inherited global setup can contact services.
// A missing opt-in is a failed explicit lane, never a successful all-skipped run.
if (process.env.E2E_SESSION_TOOL_APPROVAL !== '1') {
  throw new Error('Session tool approval lane requires E2E_SESSION_TOOL_APPROVAL=1')
}
// The spec reads Host logs with kubectl; never fall back to a default context.
if (!process.env.E2E_K8S_CONTEXT?.trim()) {
  throw new Error('Session tool approval lane requires explicit E2E_K8S_CONTEXT')
}
// The approval-mode rows patch the Host's modeCeiling under the branch
// profile's T2 mutation lease, which needs the profile to match the context.
if (process.env.MINIKUBE_PROFILE !== process.env.E2E_K8S_CONTEXT) {
  throw new Error('Session tool approval lane requires MINIKUBE_PROFILE equal to E2E_K8S_CONTEXT')
}

export default defineConfig({
  ...base,
  // Up to four real LLM turns with attended approvals run in one serial test.
  timeout: 1_500_000,
  projects: [
    { name: 'session-tool-approval', testMatch: '**/session-tool-approval-scope.test.ts' },
  ],
})
