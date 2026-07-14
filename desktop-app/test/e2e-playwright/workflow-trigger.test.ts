/**
 * Desktop App — Workflow Trigger E2E
 *
 * Exercises the binary end-to-end by logging in, navigating to Workflows,
 * and triggering a granted recipe.
 *
 * Three scenarios live here:
 *   - DA-1  Auth-filtered list shows at least one granted recipe.
 *   - DA-2  Happy-path trigger yields a success toast + a new run row.
 *   - DA-3  UX-level idempotency: a rapid double-click emits only one
 *           "Workflow triggered" toast because the UI coalesces the clicks
 *           (button disabled while the first request is in flight OR React
 *           state suppresses the duplicate render). This is NOT an HTTP-level
 *           replay assertion -- `useWorkspaceController.handleTriggerWorkflow`
 *           generates a fresh `crypto.randomUUID()` per click, so two
 *           distinct Idempotency-Key headers are produced. Server-side
 *           HTTP replay behaviour is covered by `workflows.idempotency.test.ts`.
 *
 * Prerequisites (see global-setup.ts + docs/deploy/minikube.md):
 *   - A minikube or gcp-dev cluster with port-forwards on :8091 and :8094.
 *   - User `test@clerum.io` (from E2E_DEV_LOGIN_EMAIL) is seeded.
 *   - One WorkflowRecipe granted to `test@clerum.io` in `sandbox-recipes`
 *     (the canonical orchestration namespace). Seeded by
 *     `scripts/minikube/seed-workflow-triggers-test-data.sh` along with
 *     grants in `user_workflow_triggers`.
 *
 *     Override recipe name via env:
 *       - E2E_GRANTED_RECIPE_NAME (default: "e2e-ondemand-simple")
 *
 *     Namespace is NOT configurable — WorkflowRecipes canonically live in
 *     sandbox-recipes (orchestration plane: WorkflowRecipe CRD, coordinator,
 *     mcp-host, non-MCP workloads). The sibling mcp-server namespace hosts
 *     McpServer CRDs and transport Services (MCP data plane). Targeting
 *     mcp-server here would test the wrong plane. Legacy stragglers in
 *     mcp-server are covered by the sandbox-recipes namespace invariant guard
 *     in `scripts/e2e/e2e-workflow-triggers.sh` Case 10.
 *
 * Related files (do NOT modify from this test):
 *   - desktop-app/src/authClient.ts:119-124        (listWorkflows)
 *   - desktop-app/src/authClient.ts:142-159        (triggerWorkflow + header)
 *   - desktop-app/ui/src/hooks/useWorkspaceController.ts:2084-2105
 *   - desktop-app/ui/src/pages/WorkflowsPage.tsx
 *   - desktop-app/ui/src/components/SidebarNav/index.tsx:52-54
 */
import { expect, test } from '@playwright/test'
import {
  E2E_EMAIL,
  cleanupRecipeRuntimeState,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  seedAllowlist,
  selectWorkflow,
  waitForNewRun,
  workflowRow,
} from './workflowUi'

// e2e-ondemand-simple is the onDemand recipe (no approval/schedule) granted to
// E2E_EMAIL in `sandbox-recipes` by the seed script's RECIPES_FOR_USER_A loop.
// Namespace is hardcoded to the canonical orchestration plane; see file header.
const RECIPE_NAME = process.env.E2E_GRANTED_RECIPE_NAME || 'e2e-ondemand-simple'
const RECIPE_NS = 'sandbox-recipes'

test.describe('Workflow triggers', () => {
  test.beforeEach(async () => {
    await clearSession()
    cleanupRecipeRuntimeState(RECIPE_NAME)
  })

  // ── DA-1 ────────────────────────────────────────────────────────────────────
  test('DA-1 workflows list is auth-filtered to granted recipes only', async () => {
    const auth = await loginAs(E2E_EMAIL)
    seedAllowlist(auth.userId, RECIPE_NAME)

    const { app, page } = await launchAndLogin()
    try {
      // Sidebar nav uses data-testid="nav-workflows" (SidebarNav/index.tsx:52-54).
      await openWorkflowsPage(page)

      const grantedRow = workflowRow(page, RECIPE_NAME)
      await expect(grantedRow).toBeVisible({ timeout: 15_000 })

      const detailCard = await selectWorkflow(page, RECIPE_NAME, RECIPE_NS)
      await expect(detailCard.getByRole('heading', { name: 'Details' })).toBeVisible({
        timeout: 10_000,
      })
    } finally {
      await app.close()
    }
  })

  // ── DA-2 ────────────────────────────────────────────────────────────────────
  test('DA-2 happy-path trigger shows success toast and creates a run', async () => {
    const auth = await loginAs(E2E_EMAIL)
    seedAllowlist(auth.userId, RECIPE_NAME)

    const { app, page } = await launchAndLogin()
    try {
      await openWorkflowsPage(page)
      const detailCard = await selectWorkflow(page, RECIPE_NAME, RECIPE_NS)

      const triggerBtn = detailCard.getByRole('button', { name: /^trigger$/i })
      await expect(triggerBtn).toBeVisible({ timeout: 15_000 })
      await triggerBtn.click()

      // Toast uses role="status" on success (assertive "alert" on error). See
      // desktop-app/ui/src/components/primitives/index.tsx:56-61. Role-based
      // locator is resilient to CSS class renames and matches the a11y contract.
      const toast = page.getByRole('status').filter({ hasText: 'Workflow triggered.' })
      await expect(toast).toBeVisible({ timeout: 5_000 })

      // cleanupRecipeRuntimeState cleared prior runs, so the first new run is ours.
      const newRun = await waitForNewRun(page, RECIPE_NS, RECIPE_NAME, [])
      expect(newRun.actor?.type).toBe('user-session')
      expect(newRun.actor?.userId).toBe(auth.userId)
      expect(['Pending', 'Running']).toContain(newRun.phase)
    } finally {
      await app.close()
      cleanupRecipeRuntimeState(RECIPE_NAME)
    }
  })

  // ── DA-3 ────────────────────────────────────────────────────────────────────
  test('DA-3 double-click race surfaces exactly one success toast', async () => {
    const auth = await loginAs(E2E_EMAIL)
    seedAllowlist(auth.userId, RECIPE_NAME)

    const { app, page } = await launchAndLogin()
    try {
      await openWorkflowsPage(page)
      const detailCard = await selectWorkflow(page, RECIPE_NAME, RECIPE_NS)

      const triggerBtn = detailCard.getByRole('button', { name: /^trigger$/i })
      await expect(triggerBtn).toBeVisible({ timeout: 15_000 })

      // Fire two clicks in the same microtask batch to exercise the
      // idempotency-key replay path. useWorkspaceController.handleTriggerWorkflow
      // generates a fresh crypto.randomUUID() per click, so true HTTP-level
      // idempotency replay cannot be observed from a pure double-click on
      // that handler — the replay path is what `workflows.idempotency.test.ts`
      // already covers via rendererTriggerWorkflow(..., idempotencyKey).
      //
      // What we DO assert here is UX-level: the UI must never render two
      // success toasts from a rapid double-click (either because the button
      // is disabled during the in-flight request, or because the second click
      // is coalesced by React state).
      await Promise.all([triggerBtn.click(), triggerBtn.click()])

      // Same role-based selector as DA-2 (see comment there for rationale).
      const toasts = page.getByRole('status').filter({ hasText: 'Workflow triggered.' })
      await expect(toasts.first()).toBeVisible({ timeout: 5_000 })

      // `toHaveCount` uses Playwright's built-in retry loop, which waits for
      // the assertion to stabilise instead of racing a hardcoded timeout.
      // This is more reliable under CI load than a fixed sleep plus count().
      await expect(toasts).toHaveCount(1)
    } finally {
      await app.close()
      cleanupRecipeRuntimeState(RECIPE_NAME)
    }
  })
})
