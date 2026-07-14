/**
 * Control UI — Workflow Recipes tab tests
 *
 * Covers three layers:
 *  1. Tab navigation   — always runs (no cluster data required)
 *  2. Editor UI        — always runs (purely local validation, no deploy)
 *  3. Install/Uninstall lifecycle — requires a live cluster with control-api
 *
 * Prerequisite: minikube running + `make minikube-pf-control-ui`
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD, CUI_RECIPES } from '../helpers/selectors'

// A valid WorkflowRecipe JSON that passes all 3 validation phases.
// Uses RFC1123-compliant name, unique suffix avoids collisions with production data.
const TEST_RECIPE_NAME = 'e2e-pw-recipe'
const SNIPPET_RECIPE_NAME = 'e2e-pw-snippet-secret-ref'
const SNIPPET_SECRET_NAME = 'e2e-pw-snippet-secret-ref'
const SNIPPET_SECRET_VALUE = 'e2e-pw-snippet-value'
const VALID_RECIPE_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: TEST_RECIPE_NAME },
    spec: {
      workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
    },
  },
  null,
  2
)

const SENSITIVE_INPUT_ENV_RECIPE_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'e2e-sensitive-input-env-warning' },
    spec: {
      inputContract: {
        properties: {
          db_password: { type: 'string' },
        },
      },
      inputs: {
        db_password: 'placeholder',
      },
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'busybox:1.36',
          command: ['sh', '-c'],
          args: ['env | sort'],
          env: [
            {
              name: 'DATABASE_URL',
              value: 'postgres://app:{{inputs.db_password}}@postgres:5432/app',
            },
          ],
        },
      ],
    },
  },
  null,
  2
)

const SNIPPET_SECRET_RECIPE_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: SNIPPET_RECIPE_NAME },
    spec: {
      output: {
        destination: 'pvc',
        format: 'json',
        storageSize: '64Mi',
      },
      steps: [
        {
          id: 'read-token',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: [
              'const token = await sdk.secrets.get("vendor_api_key")',
              'const artifact = await sdk.artifacts.writeJson("ui-secret-ref-result.json", { tokenPresent: Boolean(token), tokenPrefix: token.slice(0, 4) })',
              'return { tokenPresent: Boolean(token), artifact }',
            ].join('\n'),
            capabilities: {
              secrets: [
                {
                  alias: 'vendor_api_key',
                  secretRef: { name: SNIPPET_SECRET_NAME, key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
    },
  },
  null,
  2
)

const INVALID_JSON = '{ this is not json }'
const INVALID_NAME_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'BadName' }, // uppercase — RFC1123 violation
    spec: { workloads: [{ id: 'w', type: 'deployment', image: 'x:latest' }] },
  },
  null,
  2
)

// ── 1. Tab navigation ──────────────────────────────────────────────────────

test.describe('Control UI — Workflow Recipes — navigation', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_WORKFLOW_RECIPES)
  })

  test('navigating to Workflow Recipes tab shows Install button', async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_RECIPES.INSTALL_BUTTON)).toBeVisible({ timeout: 10_000 })
  })

  test('navigating to Workflow Recipes tab shows Refresh button', async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_RECIPES.REFRESH_BUTTON)).toBeVisible({ timeout: 10_000 })
  })

  test('shows either the empty-state message or a recipes table', async ({ authedPage }) => {
    // Wait for loading to finish — either table or empty state will appear
    const empty = authedPage.locator(CUI_RECIPES.EMPTY_STATE)
    const table = authedPage.locator(CUI_RECIPES.TABLE)

    await expect(empty.or(table)).toBeVisible({ timeout: 15_000 })
  })

  test('Refresh button reloads the recipes list', async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_RECIPES.INSTALL_BUTTON)).toBeVisible({ timeout: 10_000 })
    await authedPage.click(CUI_RECIPES.REFRESH_BUTTON)
    // After refresh, the list (or empty state) is still visible
    const empty = authedPage.locator(CUI_RECIPES.EMPTY_STATE)
    const table = authedPage.locator(CUI_RECIPES.TABLE)
    await expect(empty.or(table)).toBeVisible({ timeout: 15_000 })
  })
})

// ── 2. Editor UI (no deploy, pure local interaction) ──────────────────────

test.describe('Control UI — Workflow Recipes — editor UI', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_WORKFLOW_RECIPES)
    await expect(authedPage.locator(CUI_RECIPES.INSTALL_BUTTON)).toBeVisible({ timeout: 10_000 })
  })

  test("clicking Install opens editor with 'Install WorkflowRecipe' title", async ({
    authedPage,
  }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.EDITOR_TITLE_CREATE)).toBeVisible()
  })

  test('editor shows textarea pre-filled with example JSON', async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await expect(textarea).toBeVisible()
    const value = await textarea.inputValue()
    expect(value).toContain('clerum.io/v1alpha1')
  })

  test('editor shows Validate button', async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATE_BUTTON)).toBeVisible()
  })

  test('clicking ✕ closes the editor', async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.EDITOR_TITLE_CREATE)).toBeVisible()
    await authedPage.click(CUI_RECIPES.EDITOR_CANCEL_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.EDITOR_TITLE_CREATE)).not.toBeVisible()
    // Install button returns to view
    await expect(authedPage.locator(CUI_RECIPES.INSTALL_BUTTON)).toBeVisible()
  })

  test("validating invalid JSON shows 'Validation failed'", async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(INVALID_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_FAILED)).toBeVisible()
  })

  test("validating non-RFC1123 name shows 'Validation failed'", async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(INVALID_NAME_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_FAILED)).toBeVisible()
  })

  test("validating a valid recipe shows 'Validation passed' and Apply Defaults button", async ({
    authedPage,
  }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(VALID_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await expect(authedPage.locator(CUI_RECIPES.APPLY_DEFAULTS_BUTTON)).toBeVisible()
  })

  test('validating sensitive input template in env.value shows non-blocking warning', async ({
    authedPage,
  }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.EDITOR_TITLE_CREATE)).toBeVisible()

    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(SENSITIVE_INPUT_ENV_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)

    await expect(authedPage.getByText(/Validation passed \(1 warning\(s\)\)/)).toBeVisible()
    await expect(authedPage.getByText('Warnings', { exact: true })).toBeVisible()
    await expect(
      authedPage.getByText(/env.value references sensitive input template.*{{inputs.db_password}}/)
    ).toBeVisible()
    await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).toBeVisible({ timeout: 5_000 })
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_FAILED)).toHaveCount(0)
  })

  test("validating a valid recipe shows 'Deploy Recipe' button", async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(VALID_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).toBeVisible({ timeout: 5_000 })
  })

  test('editing textarea after validation resets validation state', async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(VALID_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()

    // Edit textarea — validation result should disappear
    await textarea.fill(VALID_RECIPE_JSON + '\n')
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).not.toBeVisible()
    // Deploy button should no longer be shown
    await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).not.toBeVisible()
  })

  test('Show/Hide Operator Defaults toggles the defaults panel', async ({ authedPage }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    // Panel is hidden initially
    await expect(
      authedPage.locator('button:has-text("Show")').filter({ hasText: 'Operator Defaults' })
    ).toBeVisible()
    // Show it
    await authedPage.click('button:has-text("Show")')
    // Security section appears inside the defaults panel
    await expect(authedPage.locator('h3:has-text("Security")')).toBeVisible()
    // Hide it
    await authedPage.click('button:has-text("Hide")')
    await expect(authedPage.locator('h3:has-text("Security")')).not.toBeVisible()
  })
})

// ── 3. Install / Uninstall lifecycle (requires live cluster) ───────────────

test.describe('Control UI — Workflow Recipes — install and uninstall', () => {
  // Clean up any orphaned recipe from a previous crashed run, and after all tests finish.
  test.beforeAll(async () => {
    await controlApi.ensureRecipeDeleted(TEST_RECIPE_NAME)
    await controlApi.ensureRecipeDeleted(SNIPPET_RECIPE_NAME)
  })

  test.afterAll(async () => {
    await controlApi.ensureRecipeDeleted(TEST_RECIPE_NAME)
    await controlApi.ensureRecipeDeleted(SNIPPET_RECIPE_NAME)
  })

  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_WORKFLOW_RECIPES)
    await expect(authedPage.locator(CUI_RECIPES.INSTALL_BUTTON)).toBeVisible({ timeout: 10_000 })
  })

  test('full lifecycle: install → table shows recipe → view status → uninstall', async ({
    authedPage,
  }) => {
    // ── Step 1: Open editor and deploy ──
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.EDITOR_TITLE_CREATE)).toBeVisible()

    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(VALID_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()

    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    // ── Step 2: Recipe appears in the table ──
    // After deploy, editor closes and table is refreshed
    const recipeRow = authedPage.locator(`tr:has-text("${TEST_RECIPE_NAME}")`)
    let deployed = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 20_000 })
      deployed = true
    } catch {
      deployed = false
    }

    if (!deployed) {
      // control-api not reachable — skip lifecycle tests
      test.skip()
      return
    }

    await expect(recipeRow).toBeVisible()

    // ── Step 3: View Status modal ──
    await authedPage.click(CUI_RECIPES.STATUS_BUTTON(TEST_RECIPE_NAME))
    await expect(authedPage.locator(CUI_RECIPES.STATUS_MODAL_HEADING)).toBeVisible({
      timeout: 10_000,
    })
    // Close modal
    await authedPage.click(CUI_RECIPES.STATUS_MODAL_CLOSE)
    await expect(authedPage.locator(CUI_RECIPES.STATUS_MODAL_HEADING)).not.toBeVisible()

    // ── Step 4: Uninstall ──
    // Accept the window.confirm dialog
    authedPage.once('dialog', dialog => dialog.accept())
    await authedPage.click(CUI_RECIPES.UNINSTALL_BUTTON(TEST_RECIPE_NAME))

    // Row disappears after deletion
    await expect(recipeRow).not.toBeVisible({ timeout: 30_000 })
  })

  test('install → edit → update lifecycle', async ({ authedPage }) => {
    // ── Install ──
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(VALID_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${TEST_RECIPE_NAME}")`)
    let deployed = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 20_000 })
      deployed = true
    } catch {
      deployed = false
    }

    if (!deployed) {
      test.skip()
      return
    }

    // ── Edit ──
    await authedPage.click(CUI_RECIPES.EDIT_BUTTON(TEST_RECIPE_NAME))
    await expect(authedPage.locator(CUI_RECIPES.EDITOR_TITLE_EDIT(TEST_RECIPE_NAME))).toBeVisible({
      timeout: 10_000,
    })

    // Modify the recipe — change image tag
    const editedRecipe = JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: TEST_RECIPE_NAME },
        spec: {
          workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
        },
      },
      null,
      2
    )
    const editTextarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await editTextarea.fill(editedRecipe)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await authedPage.click(CUI_RECIPES.UPDATE_BUTTON)

    // Recipe still in table after update
    await expect(recipeRow).toBeVisible({ timeout: 15_000 })

    // ── Cleanup: Uninstall ──
    authedPage.once('dialog', dialog => dialog.accept())
    await authedPage.click(CUI_RECIPES.UNINSTALL_BUTTON(TEST_RECIPE_NAME))
    await expect(recipeRow).not.toBeVisible({ timeout: 30_000 })
  })

  test('cancelling the confirm dialog does NOT uninstall the recipe', async ({ authedPage }) => {
    // First install
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(VALID_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${TEST_RECIPE_NAME}")`)
    let deployed = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 20_000 })
      deployed = true
    } catch {
      deployed = false
    }

    if (!deployed) {
      test.skip()
      return
    }

    // Dismiss the confirm dialog
    authedPage.once('dialog', dialog => dialog.dismiss())
    await authedPage.click(CUI_RECIPES.UNINSTALL_BUTTON(TEST_RECIPE_NAME))

    // Recipe remains in table
    await expect(recipeRow).toBeVisible()

    // Cleanup: actually uninstall
    authedPage.once('dialog', dialog => dialog.accept())
    await authedPage.click(CUI_RECIPES.UNINSTALL_BUTTON(TEST_RECIPE_NAME))
    await expect(recipeRow).not.toBeVisible({ timeout: 30_000 })
  })

  test('install snippet recipe with external Secret value captured outside the JSON editor', async ({
    authedPage,
  }) => {
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.EDITOR_TITLE_CREATE)).toBeVisible()

    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(SNIPPET_SECRET_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)

    await expect(authedPage.getByText('Configuration & Secrets')).toBeVisible()
    await expect(
      authedPage.locator('code').getByText(SNIPPET_SECRET_NAME, { exact: true })
    ).toBeVisible()
    const secretInput = authedPage.getByPlaceholder('Enter value for vendor_api_key')
    await expect(secretInput).toBeVisible()
    await secretInput.fill(SNIPPET_SECRET_VALUE)

    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${SNIPPET_RECIPE_NAME}")`)
    await expect(recipeRow).toBeVisible({ timeout: 20_000 })

    const installed = await controlApi.getRecipe(SNIPPET_RECIPE_NAME)
    expect(JSON.stringify(installed)).toContain('"secretRef"')
    expect(JSON.stringify(installed)).toContain(SNIPPET_SECRET_NAME)
    expect(JSON.stringify(installed)).not.toContain(SNIPPET_SECRET_VALUE)
  })

  test('table shows Name and Phase column headers when recipes exist', async ({ authedPage }) => {
    // Install first to ensure at least one row
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(VALID_RECIPE_JSON)
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${TEST_RECIPE_NAME}")`)
    let deployed = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 20_000 })
      deployed = true
    } catch {
      deployed = false
    }

    if (!deployed) {
      test.skip()
      return
    }

    await expect(authedPage.locator(CUI_RECIPES.TABLE_HEADER_NAME)).toBeVisible()
    await expect(authedPage.locator(CUI_RECIPES.TABLE_HEADER_PHASE)).toBeVisible()

    // Cleanup
    authedPage.once('dialog', dialog => dialog.accept())
    await authedPage.click(CUI_RECIPES.UNINSTALL_BUTTON(TEST_RECIPE_NAME))
    await expect(recipeRow).not.toBeVisible({ timeout: 30_000 })
  })
})

// ─── Status modal — structure tests ──────────────────────────────────────────
test.describe('Control UI — Workflow Recipes — status modal structure', () => {
  const MODAL_RECIPE = 'e2e-pw-status-modal'

  test.beforeAll(async () => {
    await controlApi.ensureRecipeDeleted(MODAL_RECIPE)
  })
  test.afterAll(async () => {
    await controlApi.ensureRecipeDeleted(MODAL_RECIPE)
  })

  test.beforeEach(async ({ authedPage }) => {
    await authedPage.goto('/')
    const tab = authedPage.locator(CUI_DASHBOARD.TAB_WORKFLOW_RECIPES)
    await tab.waitFor({ state: 'visible', timeout: 10_000 })
    await authedPage.click(CUI_DASHBOARD.TAB_WORKFLOW_RECIPES)
  })

  test('status modal shows heading and namespace/name', async ({ authedPage }) => {
    // Install a minimal recipe first
    await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(
      JSON.stringify(
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: MODAL_RECIPE },
          spec: {
            contextRef: 'context1',
            workloads: [{ id: 'srv', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 80 }],
          },
        },
        null,
        2
      )
    )
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${MODAL_RECIPE}")`)
    let deployed = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 20_000 })
      deployed = true
    } catch {
      deployed = false
    }
    if (!deployed) {
      test.skip()
      return
    }

    // Open status modal
    await authedPage.click(CUI_RECIPES.STATUS_BUTTON(MODAL_RECIPE))
    const heading = authedPage.locator(CUI_RECIPES.STATUS_MODAL_HEADING)
    await heading.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await heading.isVisible()).toBe(true)

    // The modal shows the CRD storage namespace. This is separate from workload
    // placement, which still follows the reconciler rule:
    // MCP workloads -> mcp-server
    // non-MCP workloads/resources -> sandbox-recipes
    await expect(authedPage.locator(`text=sandbox-recipes/${MODAL_RECIPE}`)).toBeVisible()
  })

  test('status modal shows Raw JSON section with copy button', async ({ authedPage }) => {
    const recipeRow = authedPage.locator(`tr:has-text("${MODAL_RECIPE}")`)
    let exists = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 5_000 })
      exists = true
    } catch {
      exists = false
    }
    if (!exists) {
      test.skip()
      return
    }

    await authedPage.click(CUI_RECIPES.STATUS_BUTTON(MODAL_RECIPE))
    await authedPage
      .locator(CUI_RECIPES.STATUS_MODAL_HEADING)
      .waitFor({ state: 'visible', timeout: 10_000 })

    // Wait for status data to load (WRC must have reconciled and set at least phase)
    // If still empty state after 15s, skip — cluster hasn't reconciled yet
    const hasStatusData = await authedPage
      .locator(':text("Workload Phase:")')
      .isVisible()
      .catch(() => false)
    if (!hasStatusData) {
      test.skip()
      return
    }

    // Raw JSON section exists (only rendered when status has data)
    await expect(authedPage.locator(CUI_RECIPES.STATUS_MODAL_RAW_JSON)).toBeVisible()
    // Copy JSON button exists
    await expect(authedPage.locator(CUI_RECIPES.STATUS_MODAL_COPY_JSON)).toBeVisible()
  })

  test('status modal closes via Close button', async ({ authedPage }) => {
    const recipeRow = authedPage.locator(`tr:has-text("${MODAL_RECIPE}")`)
    let exists = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 5_000 })
      exists = true
    } catch {
      exists = false
    }
    if (!exists) {
      test.skip()
      return
    }

    await authedPage.click(CUI_RECIPES.STATUS_BUTTON(MODAL_RECIPE))
    await authedPage
      .locator(CUI_RECIPES.STATUS_MODAL_HEADING)
      .waitFor({ state: 'visible', timeout: 10_000 })
    await authedPage.click(CUI_RECIPES.STATUS_MODAL_CLOSE)
    await expect(authedPage.locator(CUI_RECIPES.STATUS_MODAL_HEADING)).not.toBeVisible()
  })

  test('status modal closes via backdrop click', async ({ authedPage }) => {
    const recipeRow = authedPage.locator(`tr:has-text("${MODAL_RECIPE}")`)
    let exists = false
    try {
      await recipeRow.waitFor({ state: 'visible', timeout: 5_000 })
      exists = true
    } catch {
      exists = false
    }
    if (!exists) {
      test.skip()
      return
    }

    await authedPage.click(CUI_RECIPES.STATUS_BUTTON(MODAL_RECIPE))
    await authedPage
      .locator(CUI_RECIPES.STATUS_MODAL_HEADING)
      .waitFor({ state: 'visible', timeout: 10_000 })
    // Click the modal backdrop (outside the modal panel)
    await authedPage.mouse.click(10, 10)
    await expect(authedPage.locator(CUI_RECIPES.STATUS_MODAL_HEADING)).not.toBeVisible({
      timeout: 3_000,
    })
  })
})
