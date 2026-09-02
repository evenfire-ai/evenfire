/**
 * Control UI — Recipe editor connector-scope copy tests
 *
 * The recipe editor's context-removal vocabulary:
 *  - L1 policy banner (step "confirm") for agentic recipes that set
 *    spec.contextRef without security.allowContextRef: must say "shared
 *    connector scope" and "WRC will auto-create a private connector scope",
 *    and must NOT say "private Context".
 *  - INFO note for recipes with a transport workload and no spec.contextRef:
 *    "Omitted — WRC will auto-create a private connector scope for this recipe."
 *
 * Recipes are created through the admin API and opened on their edit page
 * (/plugins/<ns>/<name>?edit=1 — rewritten by next.config.js to
 * /workflow-recipes/<ns>/<name>?edit=1, which mounts the RecipeEditor).
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN_ID = Date.now()
const CONTEXT_NAME = `e2e-pw-recipe-ctx-${RUN_ID}`
const AGENTIC_RECIPE_NAME = `e2e-pw-recipe-agentic-${RUN_ID}`
const TRANSPORT_RECIPE_NAME = `e2e-pw-recipe-transport-${RUN_ID}`
const RECIPE_NAMESPACE_FALLBACK = 'sandbox-recipes'

// A minimal agentic manifest (spec.steps[]) based on the working fixtures in
// recipes.spec.ts: the MODAL_RECIPE workload plus the SNIPPET step shape.
// WITHOUT security.allowContextRef this is exactly the state L1 must reject.
function agenticManifestWithoutOptIn(): string {
  return JSON.stringify(
    {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: AGENTIC_RECIPE_NAME },
      spec: {
        contextRef: CONTEXT_NAME,
        workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
        steps: [
          {
            id: 'run',
            run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
          },
        ],
      },
    },
    null,
    2
  )
}

// Transport (MCP) workload, no spec.contextRef — the shape that must produce
// the INFO note about WRC's auto-created private connector scope.
function transportManifest(): string {
  return JSON.stringify(
    {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: TRANSPORT_RECIPE_NAME },
      spec: {
        workloads: [
          {
            id: 'mock-tools',
            type: 'deployment',
            image: 'clerum/mock-mcp-server:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
      },
    },
    null,
    2
  )
}

type CreatedRecipe = { metadata?: { namespace?: string } }

async function createRecipeViaApi(manifest: string): Promise<string> {
  const created = (await controlApi.createRecipe(JSON.parse(manifest))) as CreatedRecipe
  return created?.metadata?.namespace ?? RECIPE_NAMESPACE_FALLBACK
}

test.describe('Control UI — Recipe editor — connector scope copy', () => {
  test.beforeAll(async () => {
    // Orphan cleanup from a previous crashed run, then seed the shared context.
    await controlApi.ensureRecipeDeleted(AGENTIC_RECIPE_NAME)
    await controlApi.ensureRecipeDeleted(TRANSPORT_RECIPE_NAME)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
    await controlApi.createContext({
      metadata: { name: CONTEXT_NAME },
      spec: { contextId: CONTEXT_NAME, description: 'recipe-scope-copy e2e fixture' },
    })
  })

  test.afterAll(async () => {
    await controlApi.ensureRecipeDeleted(AGENTIC_RECIPE_NAME)
    await controlApi.ensureRecipeDeleted(TRANSPORT_RECIPE_NAME)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('agentic recipe with spec.contextRef and no opt-in shows the connector-scope policy banner', async ({
    authedPage,
  }) => {
    // The API's policy gate (checkPolicyInvariant) only stores agentic recipes
    // that carry security.allowContextRef=true together with a namespace
    // WorkflowRecipePolicy (the minikube overlay ships that dev policy), so the
    // seeded recipe includes the opt-in flag. The editor JSON below strips it,
    // reproducing the exact state the L1 banner must reject.
    const namespace = await createRecipeViaApi(
      JSON.stringify({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: AGENTIC_RECIPE_NAME },
        spec: {
          contextRef: CONTEXT_NAME,
          security: { allowContextRef: true },
          workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
          steps: [
            {
              id: 'run',
              run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
            },
          ],
        },
      })
    )

    await authedPage.goto(
      `/plugins/${encodeURIComponent(namespace)}/${encodeURIComponent(AGENTIC_RECIPE_NAME)}?edit=1`
    )
    const textarea = authedPage.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 20_000 })

    // Drop the opt-in flag — the manifest now sets spec.contextRef on an
    // agentic recipe without security.allowContextRef.
    await textarea.fill(agenticManifestWithoutOptIn())

    const primaryAction = authedPage.locator('.cu-create-actions button')
    await primaryAction.filter({ hasText: 'Review manifest' }).click()
    await expect(authedPage.getByText(/Manifest review passed/)).toBeVisible()

    await primaryAction.filter({ hasText: 'Apply defaults' }).click()
    await primaryAction.filter({ hasText: 'Continue to access' }).click()

    const banner = authedPage.locator('.cu-recipe-status-panel--error[role="alert"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Cannot deploy: policy violation')
    await expect(banner).toContainText('shared connector scope')
    await expect(banner).toContainText('WRC will auto-create a private connector scope')
    await expect(banner).not.toContainText('private Context')
  })

  test('transport recipe without spec.contextRef shows the omitted-scope informational note', async ({
    authedPage,
  }) => {
    const namespace = await createRecipeViaApi(transportManifest())

    await authedPage.goto(
      `/plugins/${encodeURIComponent(namespace)}/${encodeURIComponent(TRANSPORT_RECIPE_NAME)}?edit=1`
    )
    const textarea = authedPage.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 20_000 })
    await textarea.fill(transportManifest())

    await authedPage
      .locator('.cu-create-actions button')
      .filter({ hasText: 'Review manifest' })
      .click()

    await expect(authedPage.getByText(/Manifest review passed/)).toBeVisible()
    const infoGroup = authedPage.locator('.cu-recipe-issue-group--info')
    await expect(infoGroup).toBeVisible()
    await expect(infoGroup).toContainText('Informational notes')
    await expect(
      authedPage.getByText(
        /Omitted — WRC will auto-create a private connector scope for this recipe\./u
      )
    ).toBeVisible()
    await expect(infoGroup).not.toContainText('private Context')
  })
})
