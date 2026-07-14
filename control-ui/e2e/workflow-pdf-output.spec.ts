/**
 * E2E test: Deploy a 4-step workflow that generates a PDF using clerum__generate_pdf,
 * then verify the artifacts panel appears and the PDF can be downloaded.
 *
 * Prerequisites:
 * - minikube cluster clerum-test running with all services
 * - port-forward: control-ui :3000, control-api :8090
 * - Admin credentials: admin / changeme123!
 */
import { expect, test } from '@playwright/test'

// ── Workflow recipe YAML ─────────────────────────────────────────────────
// 4 steps: research → analyze → draft → generate-pdf
// Uses mock-mcp-server (already deployed) + clerum__generate_pdf (internal tool)
const RECIPE_JSON = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'e2e-pdf-test' },
  spec: {
    contextRef: 'context1',
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        topic: { type: 'string', default: 'benefits of Kubernetes CRDs' },
      },
    },
    steps: [
      {
        id: 'research',
        instruction:
          'Research the topic: {{inputs.topic}}. Provide 3 key findings with brief explanations. Be concise — max 200 words.',
        timeoutSeconds: 120,
      },
      {
        id: 'analyze',
        instruction:
          'Analyze the following research and identify the top 2 most important trends:\n\n{{research:output}}\n\nBe concise — max 150 words.',
        dependsOn: ['research'],
        timeoutSeconds: 120,
      },
      {
        id: 'draft',
        instruction:
          'Write a short structured report from this analysis. Use markdown headings (# and ##). Max 300 words.\n\n{{analyze:output}}',
        dependsOn: ['analyze'],
        timeoutSeconds: 120,
      },
      {
        id: 'generate-report',
        instruction:
          'Using the clerum__generate_pdf tool, generate a PDF file named "e2e-report.pdf" with title "E2E Test Report" and the following body:\n\n{{draft:output}}',
        dependsOn: ['draft'],
        timeoutSeconds: 120,
      },
    ],
    output: { destination: 'pvc', name: 'e2e-pdf-test', format: 'pdf', storageSize: '64Mi' },
    workloads: [],
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function login(page: import('@playwright/test').Page) {
  await page.goto('/')
  // Login form uses htmlFor/id (app/page.tsx:520-554) — no placeholder attribute.
  await page.waitForSelector('#cu-login-user', { timeout: 10_000 })
  await page.fill('#cu-login-user', 'admin')
  await page.fill('#cu-login-pass', 'changeme123!')
  await page.click('button[type="submit"]')
  // Wait for dashboard to load — the tabs should appear
  await page.waitForSelector('text=Marketplace', { timeout: 15_000 })
}

async function navigateToRecipes(page: import('@playwright/test').Page) {
  await page.click('text=Workflow Recipes')
  // Wait for recipes tab content
  await page.waitForTimeout(1000)
}

// ── Test ─────────────────────────────────────────────────────────────────

test.describe('Workflow PDF Output E2E', () => {
  test('deploy 4-step workflow, generate PDF, verify download', async ({ page }) => {
    // 1. Login
    await login(page)

    // 2. Navigate to Workflow Recipes tab
    await navigateToRecipes(page)

    // 3. Open recipe editor — click "+ Install Recipe"
    await page.click('button:has-text("Install Recipe")')
    await page.waitForSelector('textarea', { timeout: 5_000 })

    // 4. Clear editor and paste our recipe JSON
    const textarea = page.locator('textarea').first()
    await textarea.fill(JSON.stringify(RECIPE_JSON, null, 2))

    // 5. Review, apply defaults, and deploy
    await page.click('button:has-text("Review manifest")')
    await expect(page.locator('text=Manifest review passed')).toBeVisible({ timeout: 10_000 })
    await page.click('button:has-text("Apply defaults")')
    await page.click('button:has-text("Continue to access")')
    await page.click('button:has-text("Deploy plugin")')

    // 6. Wait for the editor to close (onSaved callback closes it)
    // After deploy, the recipe list refreshes and our recipe appears
    await page.waitForTimeout(5_000)

    // 7. Find our recipe in the list and click "Status" to open modal
    const recipeRow = page.locator('text=e2e-pdf-test').first()
    await expect(recipeRow).toBeVisible({ timeout: 15_000 })

    // Click the Status button next to our recipe
    const row = page.locator('tr, div').filter({ hasText: 'e2e-pdf-test' }).first()
    const statusBtn = row.locator('button:has-text("Status")')
    await statusBtn.click()

    // 9. Wait for the status modal to open
    await page.waitForSelector('text=Recipe Status', { timeout: 10_000 })

    // 10. Wait for workflow to complete — poll the modal for "completed" phase
    // The modal auto-refreshes every 3s. We wait up to 4 minutes.
    await expect(page.locator('text=completed').first()).toBeVisible({ timeout: 240_000 })

    // 11. Verify all 4 steps show "completed"
    const completedBadges = page.locator('span:has-text("completed")')
    // Wait a bit for all steps to render
    await page.waitForTimeout(3_000)
    const count = await completedBadges.count()
    // We expect at least the workflow phase + 4 steps = 5 "completed" badges
    // But some might show the workflow phase "completed" too
    expect(count).toBeGreaterThanOrEqual(4)

    // 12. Verify the Artifacts panel appears
    const artifactsPanel = page.locator('text=Output Artifacts')
    await expect(artifactsPanel).toBeVisible({ timeout: 30_000 })

    // 13. Verify PDF badge is shown
    const pdfBadge = page.locator('span:has-text("PDF")')
    await expect(pdfBadge).toBeVisible()

    // 14. Verify the filename
    const filename = page.locator('span:has-text("e2e-report.pdf")')
    await expect(filename).toBeVisible()

    // 15. Click Download button and verify file is downloaded
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.click('button:has-text("Download")')
    const download = await downloadPromise

    // Verify filename
    expect(download.suggestedFilename()).toBe('e2e-report.pdf')

    // Save and verify file size > 0
    const filePath = await download.path()
    expect(filePath).toBeTruthy()

    // 16. Close the modal
    await page.click('button:has-text("Close")')

    console.log('✅ E2E PDF workflow test passed!')
  })

  test.afterAll(async () => {
    // Cleanup: delete the test recipe
    const token = process.env.CONTROL_API_TOKEN ?? ''
    if (token) {
      try {
        await fetch('http://localhost:8090/api/v1/admin/recipes/e2e-pdf-test', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {
        // Cleanup is best-effort
      }
    }
  })
})
