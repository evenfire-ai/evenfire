// control-ui/e2e/qa-recorder-recipe-scope-copy.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires
// QA_RECORDER_CONFIRM_MUTATIONS=1. Ports the recipe-editor connector-scope
// copy journey from
// tests/e2e/playwright/control-ui/recipe-scope-copy.spec.ts (payload shapes
// included):
//  - (a) an agentic recipe with spec.contextRef is seeded through the API
//    WITH security.allowContextRef (the API's policy gate only stores agentic
//    recipes that carry the opt-in), the editor's manifest textarea then
//    strips it, and the review step's policy banner must say "shared
//    connector scope" and "WRC will auto-create a private connector scope"
//    — never "private Context";
//  - (b) a transport-workload recipe WITHOUT spec.contextRef must show the
//    INFO note "Omitted — WRC will auto-create a private connector scope for
//    this recipe."
// Both recipes and the staging context are deleted via the Control API in a
// finally (recipes first, then the context they may reference).
import { type Page, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

const RECIPE_NAMESPACE_FALLBACK = 'sandbox-recipes'

// A minimal agentic manifest (spec.steps[]) WITHOUT security.allowContextRef —
// exactly the state the review-step banner must reject.
function agenticManifestWithoutOptIn(recipeName: string, contextName: string): string {
  return JSON.stringify(
    {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: recipeName },
      spec: {
        contextRef: contextName,
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
function transportManifest(recipeName: string): string {
  return JSON.stringify(
    {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: recipeName },
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

async function createRecipeViaApi(page: Page, manifest: string): Promise<string> {
  const res = await api<{ metadata?: { namespace?: string } }>(
    page.request,
    'POST',
    '/api/v1/admin/recipes',
    JSON.parse(manifest)
  )
  expect(res.status, `create recipe: ${JSON.stringify(res.data)}`).toBeLessThan(300)
  return res.data.metadata?.namespace ?? RECIPE_NAMESPACE_FALLBACK
}

test.describe('optional QA recorder: Control UI recipe connector-scope copy', () => {
  test('records the recipe editor connector-scope policy banner and omitted-scope info note', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes two workflow recipes and a staging context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('qa-recorder-recipe-ctx')
    const agenticRecipeName = uniqueE2EName('qa-recorder-recipe-agentic')
    const transportRecipeName = uniqueE2EName('qa-recorder-recipe-transport')

    try {
      await loginThroughUi(page, credentials)

      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'qa recorder recipe scope copy fixture',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      // (a) Agentic recipe + spec.contextRef. Seeded WITH the
      // security.allowContextRef opt-in (the API's policy gate only stores
      // agentic recipes that carry it); the editor JSON below strips it,
      // reproducing the exact state the review-step banner must reject.
      const agenticNamespace = await createRecipeViaApi(
        page,
        JSON.stringify({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: agenticRecipeName },
          spec: {
            contextRef: contextName,
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

      await page.goto(
        `${CONTROL_UI_URL}/plugins/${encodeURIComponent(agenticNamespace)}/${encodeURIComponent(agenticRecipeName)}?edit=1`
      )
      const editor = page.locator('textarea')
      await expect(editor).toBeVisible({ timeout: 20_000 })

      // Drop the opt-in flag — the manifest now sets spec.contextRef on an
      // agentic recipe without security.allowContextRef.
      await editor.fill(agenticManifestWithoutOptIn(agenticRecipeName, contextName))

      const primaryAction = page.locator('.cu-create-actions button')
      await primaryAction.filter({ hasText: 'Review manifest' }).click()
      await expect(page.getByText(/Manifest review passed/)).toBeVisible()
      await screenshotAndLog(page, testInfo, 'control-ui-recipe-agentic-manifest-review')

      await primaryAction.filter({ hasText: 'Apply defaults' }).click()
      await primaryAction.filter({ hasText: 'Continue to access' }).click()

      const banner = page.locator('.cu-recipe-status-panel--error[role="alert"]')
      await expect(banner).toBeVisible({ timeout: 20_000 })
      await expect(banner).toContainText('Cannot deploy: policy violation')
      await expect(banner).toContainText('shared connector scope')
      await expect(banner).toContainText('WRC will auto-create a private connector scope')
      await expect(banner).not.toContainText('private Context')
      await screenshotAndLog(page, testInfo, 'control-ui-recipe-agentic-scope-banner')

      // (b) Transport workload, no spec.contextRef — the INFO note about the
      // auto-created private connector scope.
      const transportNamespace = await createRecipeViaApi(
        page,
        transportManifest(transportRecipeName)
      )

      await page.goto(
        `${CONTROL_UI_URL}/plugins/${encodeURIComponent(transportNamespace)}/${encodeURIComponent(transportRecipeName)}?edit=1`
      )
      const transportEditor = page.locator('textarea')
      await expect(transportEditor).toBeVisible({ timeout: 20_000 })
      await transportEditor.fill(transportManifest(transportRecipeName))

      await page.locator('.cu-create-actions button').filter({ hasText: 'Review manifest' }).click()

      await expect(page.getByText(/Manifest review passed/)).toBeVisible()
      const infoGroup = page.locator('.cu-recipe-issue-group--info')
      await expect(infoGroup).toBeVisible({ timeout: 20_000 })
      await expect(infoGroup).toContainText('Informational notes')
      await expect(
        page.getByText(
          /Omitted — WRC will auto-create a private connector scope for this recipe\./u
        )
      ).toBeVisible()
      await expect(infoGroup).not.toContainText('private Context')
      await screenshotAndLog(page, testInfo, 'control-ui-recipe-transport-scope-info')
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/recipes/${encodeURIComponent(transportRecipeName)}`
      )
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/recipes/${encodeURIComponent(agenticRecipeName)}`
      )
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
