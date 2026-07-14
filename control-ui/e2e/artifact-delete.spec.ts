/**
 * E2E test: Validate artifact download + delete (per-file and bulk) through
 * the Control UI. Deploys a workflow that generates a PDF, then exercises:
 *
 *   1. Download — verify file arrives via the delegation JWT chain
 *   2. Delete per-file — click "✕" button, verify file disappears from panel
 *   3. Re-deploy + generate — create a second artifact to test Clear All
 *   4. Clear All — click "Clear All" → "Confirm", verify panel empties
 *
 * This test uses its own recipe name (e2e-artifact-delete-test) and operates
 * exclusively in sandbox-recipes namespace. It does NOT touch:
 *   - mcp-host namespace (autonomous agents / desktop app)
 *   - channels namespace
 *   - rpc-proxy namespace
 *
 * Prerequisites:
 *   - minikube cluster clerum-test running with all services
 *   - port-forward: control-ui :3000, control-api :8090
 *   - Admin credentials: admin / changeme123!
 */
import { expect, test } from '@playwright/test'

const RECIPE_NAME = 'e2e-artifact-delete-test'

const RECIPE_JSON = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: RECIPE_NAME },
  spec: {
    contextRef: 'context1',
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        topic: { type: 'string', default: 'artifact delete E2E test' },
      },
    },
    steps: [
      {
        id: 'generate-report',
        instruction:
          'You MUST call the clerum__generate_markdown tool with filename "e2e-delete-test.md" and content "# E2E Delete Test\\n\\nThis file tests artifact deletion.". Do NOT skip the tool call.',
        timeoutSeconds: 120,
      },
    ],
    output: { destination: 'pvc', name: RECIPE_NAME, format: 'md', storageSize: '64Mi' },
    workloads: [],
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function login(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForSelector('text=Sign in', { timeout: 10_000 })
  // Form has 2 inputs: first is username (text), second is password
  const inputs = page.locator('input')
  await inputs.nth(0).fill('admin')
  await inputs.nth(1).fill('changeme123!')
  // Click the "Sign in" submit button (last one — the first is a tab label)
  await page.locator('button:has-text("Sign in")').last().click()
  await page.waitForSelector('text=Marketplace', { timeout: 15_000 })
}

async function navigateToRecipes(page: import('@playwright/test').Page) {
  await page.click('text=Workflow Recipes')
  await page.waitForTimeout(1000)
}

async function deployRecipe(page: import('@playwright/test').Page) {
  // Click "+ Install Recipe" to open the editor
  await page.click('button:has-text("Install")')
  await page.waitForSelector('textarea', { timeout: 5_000 })
  const textarea = page.locator('textarea').first()
  await textarea.fill(JSON.stringify(RECIPE_JSON, null, 2))

  // Step 1: Click "Review manifest"
  await page.locator('button:has-text("Review manifest")').click()
  await expect(page.locator('text=Manifest review passed')).toBeVisible({ timeout: 10_000 })
  await page.locator('button:has-text("Apply defaults")').click()
  await page.locator('button:has-text("Continue to access")').click()
  await page.waitForTimeout(3_000)

  // Step 2: Click "Deploy plugin"
  const deployBtn = page.locator('button:has-text("Deploy plugin")')
  await expect(deployBtn).toBeVisible({ timeout: 10_000 })
  await deployBtn.click()
  await page.waitForTimeout(5_000)
}

async function openStatusModal(page: import('@playwright/test').Page) {
  const recipeRow = page.locator(`text=${RECIPE_NAME}`).first()
  await expect(recipeRow).toBeVisible({ timeout: 15_000 })
  const row = page.locator('tr, div').filter({ hasText: RECIPE_NAME }).first()
  const statusBtn = row.locator('button:has-text("Status")')
  await statusBtn.click()
  await page.waitForSelector('text=Recipe Status', { timeout: 10_000 })
}

async function waitForCompletion(page: import('@playwright/test').Page) {
  await expect(page.locator('text=completed').first()).toBeVisible({ timeout: 240_000 })
  // Extra wait for artifacts panel to render
  await page.waitForTimeout(3_000)
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Artifact Delete E2E', () => {
  test.describe.configure({ mode: 'serial' })

  test('1. deploy workflow, wait for artifact generation', async ({ page }) => {
    await login(page)
    await navigateToRecipes(page)
    await deployRecipe(page)
    await openStatusModal(page)
    await waitForCompletion(page)

    // Verify artifacts panel appears with our file
    const artifactsPanel = page.locator('text=Output Artifacts')
    await expect(artifactsPanel).toBeVisible({ timeout: 30_000 })
    const filename = page.locator('span:has-text("e2e-delete-test.md")')
    await expect(filename).toBeVisible()
  })

  test('2. download artifact via delegation JWT chain', async ({ page }) => {
    await login(page)
    await navigateToRecipes(page)
    await openStatusModal(page)

    // Wait for artifacts panel
    await expect(page.locator('text=Output Artifacts')).toBeVisible({ timeout: 30_000 })

    // Click Download and verify file downloads
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    const downloadBtn = page.locator('button:has-text("Download")').first()
    await downloadBtn.click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toContain('e2e-delete-test')
    const filePath = await download.path()
    expect(filePath).toBeTruthy()

    console.log('  ✅ Download via delegation JWT chain works')
  })

  test('3. delete single artifact via ✕ button', async ({ page }) => {
    await login(page)
    await navigateToRecipes(page)
    await openStatusModal(page)

    // Wait for artifacts panel
    await expect(page.locator('text=Output Artifacts')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('span:has-text("e2e-delete-test.md")')).toBeVisible()

    // Click the ✕ delete button
    const deleteBtn = page.locator('button:has-text("✕")').first()
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Wait for optimistic UI update — file should disappear
    await page.waitForTimeout(2_000)

    // The file should no longer be visible (optimistic removal)
    const fileAfterDelete = page.locator('span:has-text("e2e-delete-test.md")')
    await expect(fileAfterDelete).toBeHidden({ timeout: 10_000 })

    console.log('  ✅ Single file delete via ✕ button works')
  })

  test('4. clear all artifacts via Clear All button', async ({ page }) => {
    // First re-trigger the workflow so we have artifacts again
    // We do this via the control-api directly to avoid re-deploying
    await login(page)
    await navigateToRecipes(page)

    // Delete old recipe and redeploy to get fresh artifacts
    try {
      const token = await page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
      if (token) {
        await page.evaluate(async t => {
          await fetch(`http://localhost:8090/api/v1/admin/recipes/e2e-artifact-delete-test`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${t}` },
          })
        }, token)
        await page.waitForTimeout(5_000)
      }
    } catch {
      /* best effort cleanup */
    }

    await deployRecipe(page)
    await openStatusModal(page)
    await waitForCompletion(page)

    // Wait for artifacts panel
    await expect(page.locator('text=Output Artifacts')).toBeVisible({ timeout: 30_000 })

    // Click "Clear All" button
    const clearAllBtn = page.locator('button:has-text("Clear All")')
    await expect(clearAllBtn).toBeVisible()
    await clearAllBtn.click()

    // Confirmation dialog should appear
    const confirmBtn = page.locator('button:has-text("Confirm")')
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 })
    await confirmBtn.click()

    // Wait for delete to complete
    await page.waitForTimeout(3_000)

    // Artifacts panel should show 0 items or disappear
    const noArtifacts = page.locator('span:has-text("e2e-delete-test.md")')
    await expect(noArtifacts).toBeHidden({ timeout: 10_000 })

    console.log('  ✅ Clear All with confirmation works')
  })

  test.afterAll(async () => {
    // Cleanup: delete the test recipe via API
    try {
      await fetch(`http://localhost:8090/api/v1/admin/recipes/${RECIPE_NAME}`, { method: 'DELETE' })
    } catch {
      // Best-effort
    }
  })
})
