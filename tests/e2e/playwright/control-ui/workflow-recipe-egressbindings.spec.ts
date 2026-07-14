import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD, CUI_RECIPES } from '../helpers/selectors'

const NON_TRANSPORT_PUBLIC_WEB_MESSAGE =
  'public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings'

const UI_EXACT_HOST_RECIPE = 'e2e-pw-nontransport-exact-host'
const UI_PUBLIC_WEB_RECIPE = 'e2e-pw-nontransport-public-web'
const UI_INTERNAL_SIBLING_RECIPE = 'e2e-pw-internal-sibling-egress'
const SALES_CRM_LIKE_RECIPE = 'e2e-pw-sales-crm-egress-regression'
const HELPDESK_PLUGIN_RECIPE = 'e2e-helpdesk-plugin-egress'
const API_EXACT_HOST_RECIPE = 'e2e-api-nontransport-exact-host'
const API_PUBLIC_WEB_RECIPE = 'e2e-api-nontransport-public-web'
const API_INTERNAL_SIBLING_RECIPE = 'e2e-api-internal-sibling-egress'
const API_HELPDESK_PLUGIN_WRONG_NS_RECIPE = 'e2e-api-helpdesk-plugin-wrong-ns'
const API_TRANSPORT_PUBLIC_WEB_RECIPE = 'e2e-api-transport-public-web'
const API_RUNTIME_PUBLIC_WEB_RECIPE = 'e2e-api-runtime-public-web'
const SANDBOX_RECIPES_NS = 'sandbox-recipes'
const KUBE_CONTEXT =
  process.env.KUBECONTEXT ?? process.env.E2E_K8S_CONTEXT ?? process.env.K8S_CONTEXT

type NetworkPolicy = {
  spec?: {
    podSelector?: { matchLabels?: Record<string, string> }
    egress?: Array<{
      to?: Array<{
        namespaceSelector?: { matchLabels?: Record<string, string> }
        podSelector?: { matchLabels?: Record<string, string> }
      }>
      ports?: Array<{ port?: number; protocol?: string }>
    }>
    ingress?: Array<{
      from?: Array<{
        namespaceSelector?: { matchLabels?: Record<string, string> }
        podSelector?: { matchLabels?: Record<string, string> }
      }>
      ports?: Array<{ port?: number; protocol?: string }>
    }>
  }
}

function recipeWithEgress(name: string, egressBindings: unknown[]) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      workloads: [
        {
          id: 'worker',
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
          egressBindings,
        },
      ],
    },
  }
}

function exactHostRecipe(name: string, dns = 'example.com') {
  return recipeWithEgress(name, [{ dns, port: 443, protocol: 'TCP' }])
}

function publicWebRecipe(name: string) {
  return recipeWithEgress(name, [{ egressClass: 'public-web' }])
}

function internalSiblingRecipe(name: string, dns = 'db.sandbox-recipes.svc.cluster.local') {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
          port: 8080,
          env: [
            { name: 'PG_HOST', value: '{{db:host}}' },
            { name: 'PG_PORT', value: '{{db:port}}' },
          ],
          egressBindings: [{ dns, port: 5432, protocol: 'TCP' }],
        },
        {
          id: 'db',
          type: 'statefulset',
          image: 'nginx:1.30.1-alpine',
          port: 5432,
        },
      ],
    },
  }
}

function helpdeskPluginRecipe(
  name: string,
  dbDns = 'helpdesk-db.sandbox-recipes.svc.cluster.local'
) {
  // Derived from your-org/helpdesk-plugin recipe.yaml. External exact-host
  // bindings and real app images are intentionally omitted so this E2E isolates
  // the cluster-local regression without requiring plugin secrets or model boot.
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      description: 'Helpdesk plugin E2E fixture derived from your-org/helpdesk-plugin.',
      contextRef: 'context1',
      workloads: [
        {
          id: 'chat-api',
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
          port: 8080,
          env: [
            { name: 'PG_HOST', value: '{{helpdesk-db:host}}' },
            { name: 'PG_PORT', value: '{{helpdesk-db:port}}' },
          ],
          egressBindings: [{ dns: dbDns, port: 5432, protocol: 'TCP' }],
        },
        {
          id: 'helpdesk-db',
          type: 'statefulset',
          image: 'nginx:1.30.1-alpine',
          port: 5432,
        },
        {
          id: 'surveyor',
          type: 'cronjob',
          image: 'nginx:1.30.1-alpine',
          schedule: '0 */6 * * *',
          command: ['sh', '-c'],
          args: ['echo surveyor'],
          env: [
            { name: 'PG_HOST', value: '{{helpdesk-db:host}}' },
            { name: 'PG_PORT', value: '{{helpdesk-db:port}}' },
          ],
          egressBindings: [{ dns: dbDns, port: 5432, protocol: 'TCP' }],
        },
        {
          id: 'ui',
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
          port: 8080,
          env: [
            { name: 'API_HOST', value: '{{chat-api:host}}' },
            { name: 'API_PORT', value: '{{chat-api:port}}' },
          ],
        },
      ],
      ui: {
        workloadRef: 'ui',
        port: 8080,
        title: 'Helpdesk',
        defaultPath: '/',
        egress: { internal: [{ workloadRef: 'chat-api', port: 8080 }] },
      },
      security: { isolationLevel: 'minimal' },
    },
  }
}

function salesCrmLikeRecipe(name: string) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      ui: {
        workloadRef: 'ui',
        port: 8080,
        title: 'Sales CRM Regression',
        egress: { internal: [{ workloadRef: 'api', port: 8080 }] },
      },
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
          port: 8080,
          egressBindings: [{ dns: 'api.salesforce.com', port: 443, protocol: 'TCP' }],
        },
        {
          id: 'ui',
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
          port: 8080,
        },
        {
          id: 'db',
          type: 'statefulset',
          image: 'nginx:1.30.1-alpine',
        },
        {
          id: 'followup',
          type: 'cronjob',
          image: 'nginx:1.30.1-alpine',
          schedule: '*/15 * * * *',
          command: ['sh', '-c'],
          args: ['echo followup'],
          egressBindings: [{ dns: 'example.com', port: 443, protocol: 'TCP' }],
        },
        {
          id: 'inbox-poll',
          type: 'cronjob',
          image: 'nginx:1.30.1-alpine',
          schedule: '*/10 * * * *',
          command: ['sh', '-c'],
          args: ['echo inbox-poll'],
          egressBindings: [{ dns: 'www.example.com', port: 443, protocol: 'TCP' }],
        },
      ],
    },
  }
}

function transportPublicWebRecipe(name: string) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      workloads: [
        {
          id: 'web-search',
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
          port: 3000,
          transport: { type: 'streamableHttp' },
          egressBindings: [{ egressClass: 'public-web' }],
        },
      ],
    },
  }
}

function runtimePublicWebRecipe(name: string) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      triggers: { onDemand: { allowedActors: ['user'] } },
      runtimeEgress: { http: { egressClass: 'public-web' } },
      steps: [
        {
          id: 'public-http',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: { http: { egressClass: 'public-web' } },
          },
        },
      ],
    },
  }
}

function kubectlJson(args: string[]): unknown {
  if (!KUBE_CONTEXT) {
    throw new Error('KUBECONTEXT, E2E_K8S_CONTEXT, or K8S_CONTEXT is required for WRC assertions')
  }
  const stdout = execFileSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(stdout)
}

function kubectl(args: string[]): void {
  if (!KUBE_CONTEXT) {
    throw new Error('KUBECONTEXT, E2E_K8S_CONTEXT, or K8S_CONTEXT is required for WRC assertions')
  }
  execFileSync('kubectl', ['--context', KUBE_CONTEXT, ...args], { stdio: 'ignore' })
}

function getNetworkPolicy(name: string, namespace = SANDBOX_RECIPES_NS): NetworkPolicy | null {
  try {
    return kubectlJson([
      'get',
      'networkpolicy',
      name,
      '-n',
      namespace,
      '-o',
      'json',
    ]) as NetworkPolicy
  } catch {
    return null
  }
}

function deleteNetworkPolicy(name: string, namespace = SANDBOX_RECIPES_NS) {
  kubectl(['delete', 'networkpolicy', name, '-n', namespace, '--ignore-not-found=true'])
}

function workloadEgressPolicyName(recipeName: string, workloadId: string) {
  return `wl-egress-${recipeName}-${workloadId}`
}

function workloadIngressPolicyName(recipeName: string, workloadId: string) {
  return `wl-ingress-${recipeName}-${workloadId}`
}

function helpdeskPluginPolicyNames() {
  return [
    workloadEgressPolicyName(HELPDESK_PLUGIN_RECIPE, 'chat-api'),
    workloadEgressPolicyName(HELPDESK_PLUGIN_RECIPE, 'surveyor'),
    workloadIngressPolicyName(HELPDESK_PLUGIN_RECIPE, 'helpdesk-db'),
  ]
}

function deleteHelpdeskPluginPolicies() {
  for (const policyName of helpdeskPluginPolicyNames()) {
    deleteNetworkPolicy(policyName)
  }
}

async function ensureHelpdeskPluginDeleted() {
  await controlApi.ensureRecipeDeleted(HELPDESK_PLUGIN_RECIPE)
  if (!KUBE_CONTEXT) return

  await expect
    .poll(
      () => {
        deleteHelpdeskPluginPolicies()
        return helpdeskPluginPolicyNames().filter(policyName => getNetworkPolicy(policyName)).length
      },
      { message: 'helpdesk plugin fixture NetworkPolicies cleaned up', timeout: 10_000 }
    )
    .toBe(0)
}

function hasClusterLocalEgressTo(policy: NetworkPolicy, workloadId: string, port: number) {
  return (
    policy.spec?.egress?.some(rule => {
      const allowsTarget = rule.to?.some(peer => {
        return (
          peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] ===
            SANDBOX_RECIPES_NS &&
          peer.podSelector?.matchLabels?.['clerum.io/recipe'] === HELPDESK_PLUGIN_RECIPE &&
          peer.podSelector?.matchLabels?.['clerum.io/workload'] === workloadId
        )
      })
      const allowsPort = rule.ports?.some(p => p.port === port && (p.protocol ?? 'TCP') === 'TCP')
      return allowsTarget && allowsPort
    }) ?? false
  )
}

function ingressSources(policy: NetworkPolicy) {
  return (
    policy.spec?.ingress
      ?.flatMap(rule => rule.from ?? [])
      .map(peer => peer.podSelector?.matchLabels?.['clerum.io/workload'])
      .filter(Boolean)
      .sort() ?? []
  )
}

async function openWorkflowRecipeInstaller(authedPage: Page) {
  await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  await authedPage.click(CUI_DASHBOARD.TAB_WORKFLOW_RECIPES)
  await expect(authedPage.locator(CUI_RECIPES.INSTALL_BUTTON)).toBeVisible({ timeout: 10_000 })
  await authedPage.click(CUI_RECIPES.INSTALL_BUTTON)
  await expect(authedPage.getByRole('heading', { name: 'Install Recipe' })).toBeVisible()
}

test.describe('WorkflowRecipe non-transport egressBindings contract', () => {
  test.beforeAll(async () => {
    await controlApi.ensureRecipeDeleted(UI_EXACT_HOST_RECIPE)
    await controlApi.ensureRecipeDeleted(UI_PUBLIC_WEB_RECIPE)
    await controlApi.ensureRecipeDeleted(UI_INTERNAL_SIBLING_RECIPE)
    await controlApi.ensureRecipeDeleted(SALES_CRM_LIKE_RECIPE)
    await ensureHelpdeskPluginDeleted()
    await controlApi.ensureRecipeDeleted(API_EXACT_HOST_RECIPE)
    await controlApi.ensureRecipeDeleted(API_PUBLIC_WEB_RECIPE)
    await controlApi.ensureRecipeDeleted(API_INTERNAL_SIBLING_RECIPE)
    await controlApi.ensureRecipeDeleted(API_HELPDESK_PLUGIN_WRONG_NS_RECIPE)
    await controlApi.ensureRecipeDeleted(API_TRANSPORT_PUBLIC_WEB_RECIPE)
    await controlApi.ensureRecipeDeleted(API_RUNTIME_PUBLIC_WEB_RECIPE)
  })

  test.afterAll(async () => {
    await controlApi.ensureRecipeDeleted(UI_EXACT_HOST_RECIPE)
    await controlApi.ensureRecipeDeleted(UI_PUBLIC_WEB_RECIPE)
    await controlApi.ensureRecipeDeleted(UI_INTERNAL_SIBLING_RECIPE)
    await controlApi.ensureRecipeDeleted(SALES_CRM_LIKE_RECIPE)
    await ensureHelpdeskPluginDeleted()
    await controlApi.ensureRecipeDeleted(API_EXACT_HOST_RECIPE)
    await controlApi.ensureRecipeDeleted(API_PUBLIC_WEB_RECIPE)
    await controlApi.ensureRecipeDeleted(API_INTERNAL_SIBLING_RECIPE)
    await controlApi.ensureRecipeDeleted(API_HELPDESK_PLUGIN_WRONG_NS_RECIPE)
    await controlApi.ensureRecipeDeleted(API_TRANSPORT_PUBLIC_WEB_RECIPE)
    await controlApi.ensureRecipeDeleted(API_RUNTIME_PUBLIC_WEB_RECIPE)
  })

  test('Control UI validates and deploys non-transport exact-host egressBindings', async ({
    authedPage,
  }) => {
    await openWorkflowRecipeInstaller(authedPage)

    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(JSON.stringify(exactHostRecipe(UI_EXACT_HOST_RECIPE), null, 2))
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).toBeVisible()

    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${UI_EXACT_HOST_RECIPE}")`)
    await expect(recipeRow).toBeVisible({ timeout: 20_000 })

    const installed = (await controlApi.getRecipe(UI_EXACT_HOST_RECIPE)) as {
      spec?: { workloads?: Array<{ egressBindings?: unknown[] }> }
    }
    expect(installed.spec?.workloads?.[0]?.egressBindings).toEqual([
      { egressClass: 'exact-host', dns: 'example.com', port: 443, protocol: 'TCP' },
    ])
  })

  test('Control UI rejects non-transport public-web egressBindings before deploy', async ({
    authedPage,
  }) => {
    await openWorkflowRecipeInstaller(authedPage)

    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(JSON.stringify(publicWebRecipe(UI_PUBLIC_WEB_RECIPE), null, 2))
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)

    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_FAILED)).toBeVisible()
    await expect(authedPage.getByText(NON_TRANSPORT_PUBLIC_WEB_MESSAGE)).toBeVisible()
    await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).toHaveCount(0)
    await expect(authedPage.locator(`tr:has-text("${UI_PUBLIC_WEB_RECIPE}")`)).toHaveCount(0)
    await expect(controlApi.getRecipe(UI_PUBLIC_WEB_RECIPE)).rejects.toThrow(/404|not found/i)
  })

  test('Control UI deploys a Sales CRM-like sandbox-ui recipe with multiple exact-host non-transport egress bindings', async ({
    authedPage,
  }) => {
    await openWorkflowRecipeInstaller(authedPage)

    const recipe = salesCrmLikeRecipe(SALES_CRM_LIKE_RECIPE)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(JSON.stringify(recipe, null, 2))
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).toBeVisible()

    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${SALES_CRM_LIKE_RECIPE}")`)
    await expect(recipeRow).toBeVisible({ timeout: 20_000 })

    const installed = (await controlApi.getRecipe(SALES_CRM_LIKE_RECIPE)) as {
      spec?: {
        ui?: { title?: string; egress?: { internal?: unknown[] } }
        workloads?: Array<{ id?: string; egressBindings?: unknown[] }>
      }
    }
    expect(installed.spec?.ui?.title).toBe('Sales CRM Regression')
    expect(installed.spec?.ui?.egress?.internal).toEqual([{ workloadRef: 'api', port: 8080 }])
    expect(
      installed.spec?.workloads
        ?.filter(workload => ['api', 'followup', 'inbox-poll'].includes(workload.id ?? ''))
        .map(workload => [workload.id, workload.egressBindings])
    ).toEqual([
      [
        'api',
        [{ egressClass: 'exact-host', dns: 'api.salesforce.com', port: 443, protocol: 'TCP' }],
      ],
      ['followup', [{ egressClass: 'exact-host', dns: 'example.com', port: 443, protocol: 'TCP' }]],
      [
        'inbox-poll',
        [{ egressClass: 'exact-host', dns: 'www.example.com', port: 443, protocol: 'TCP' }],
      ],
    ])
  })

  test('Control UI validates and deploys declared cluster-local sibling egressBindings', async ({
    authedPage,
  }) => {
    await openWorkflowRecipeInstaller(authedPage)

    const recipe = internalSiblingRecipe(UI_INTERNAL_SIBLING_RECIPE)
    const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
    await textarea.fill(JSON.stringify(recipe, null, 2))
    await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
    await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
    await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).toBeVisible()

    await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

    const recipeRow = authedPage.locator(`tr:has-text("${UI_INTERNAL_SIBLING_RECIPE}")`)
    await expect(recipeRow).toBeVisible({ timeout: 20_000 })

    const installed = (await controlApi.getRecipe(UI_INTERNAL_SIBLING_RECIPE)) as {
      spec?: { workloads?: Array<{ id?: string; env?: unknown[]; egressBindings?: unknown[] }> }
    }
    const apiWorkload = installed.spec?.workloads?.find(workload => workload.id === 'api')
    expect(apiWorkload?.env).toEqual([
      { name: 'PG_HOST', value: '{{db:host}}' },
      { name: 'PG_PORT', value: '{{db:port}}' },
    ])
    expect(apiWorkload?.egressBindings).toEqual([
      {
        egressClass: 'exact-host',
        dns: 'db.sandbox-recipes.svc.cluster.local',
        port: 5432,
        protocol: 'TCP',
      },
    ])
  })

  test('Control UI deploys helpdesk-plugin-derived internal egress and WRC materializes sibling policies', async ({
    authedPage,
  }) => {
    await test.step('install helpdesk-derived recipe through the Control UI', async () => {
      await openWorkflowRecipeInstaller(authedPage)

      const recipe = helpdeskPluginRecipe(HELPDESK_PLUGIN_RECIPE)
      const textarea = authedPage.locator(CUI_RECIPES.EDITOR_TEXTAREA)
      await textarea.fill(JSON.stringify(recipe, null, 2))
      await authedPage.click(CUI_RECIPES.VALIDATE_BUTTON)
      await expect(authedPage.locator(CUI_RECIPES.VALIDATION_PASSED)).toBeVisible()
      await expect(authedPage.locator(CUI_RECIPES.DEPLOY_BUTTON)).toBeVisible()

      await authedPage.click(CUI_RECIPES.DEPLOY_BUTTON)

      const recipeRow = authedPage.locator(`tr:has-text("${HELPDESK_PLUGIN_RECIPE}")`)
      await expect(recipeRow).toBeVisible({ timeout: 20_000 })
    })

    await test.step('verify the WorkflowRecipe CRD preserves helpdesk internal egress', async () => {
      const installed = (await controlApi.getRecipe(HELPDESK_PLUGIN_RECIPE)) as {
        spec?: {
          ui?: { egress?: { internal?: unknown[] } }
          workloads?: Array<{ id?: string; env?: unknown[]; egressBindings?: unknown[] }>
        }
      }
      const chatApi = installed.spec?.workloads?.find(workload => workload.id === 'chat-api')
      const surveyor = installed.spec?.workloads?.find(workload => workload.id === 'surveyor')

      expect(installed.spec?.ui?.egress?.internal).toEqual([
        { workloadRef: 'chat-api', port: 8080 },
      ])
      expect(chatApi?.env).toEqual([
        { name: 'PG_HOST', value: '{{helpdesk-db:host}}' },
        { name: 'PG_PORT', value: '{{helpdesk-db:port}}' },
      ])
      expect(chatApi?.egressBindings).toEqual([
        {
          egressClass: 'exact-host',
          dns: 'helpdesk-db.sandbox-recipes.svc.cluster.local',
          port: 5432,
          protocol: 'TCP',
        },
      ])
      expect(surveyor?.egressBindings).toEqual(chatApi?.egressBindings)
    })

    await test.step('verify WRC creates symmetric NetworkPolicies for helpdesk-db sibling access', async () => {
      await expect
        .poll(
          () =>
            getNetworkPolicy(workloadEgressPolicyName(HELPDESK_PLUGIN_RECIPE, 'chat-api')) !== null,
          { timeout: 60_000 }
        )
        .toBe(true)

      await expect
        .poll(
          () =>
            getNetworkPolicy(workloadEgressPolicyName(HELPDESK_PLUGIN_RECIPE, 'surveyor')) !== null,
          { timeout: 60_000 }
        )
        .toBe(true)

      await expect
        .poll(
          () =>
            getNetworkPolicy(workloadIngressPolicyName(HELPDESK_PLUGIN_RECIPE, 'helpdesk-db')) !==
            null,
          { timeout: 60_000 }
        )
        .toBe(true)

      const chatApiPolicy = getNetworkPolicy(
        workloadEgressPolicyName(HELPDESK_PLUGIN_RECIPE, 'chat-api')
      )
      const surveyorPolicy = getNetworkPolicy(
        workloadEgressPolicyName(HELPDESK_PLUGIN_RECIPE, 'surveyor')
      )
      const ingressPolicy = getNetworkPolicy(
        workloadIngressPolicyName(HELPDESK_PLUGIN_RECIPE, 'helpdesk-db')
      )

      expect(chatApiPolicy?.spec?.podSelector?.matchLabels).toMatchObject({
        'clerum.io/recipe': HELPDESK_PLUGIN_RECIPE,
        'clerum.io/workload': 'chat-api',
      })
      expect(surveyorPolicy?.spec?.podSelector?.matchLabels).toMatchObject({
        'clerum.io/recipe': HELPDESK_PLUGIN_RECIPE,
        'clerum.io/workload': 'surveyor',
      })
      expect(hasClusterLocalEgressTo(chatApiPolicy!, 'helpdesk-db', 5432)).toBe(true)
      expect(hasClusterLocalEgressTo(surveyorPolicy!, 'helpdesk-db', 5432)).toBe(true)
      expect(ingressSources(ingressPolicy!)).toEqual(['chat-api', 'surveyor'])
    })
  })

  test('Control API enforces the non-transport exact-host and public-web contract', async () => {
    const exact = exactHostRecipe(API_EXACT_HOST_RECIPE)
    const updatedExact = exactHostRecipe(API_EXACT_HOST_RECIPE, 'www.example.com')
    const publicWeb = publicWebRecipe(API_PUBLIC_WEB_RECIPE)

    await expect(controlApi.validateRecipe(exact)).resolves.toMatchObject({ valid: true })
    await expect(controlApi.validateRecipe(publicWeb)).rejects.toThrow(
      NON_TRANSPORT_PUBLIC_WEB_MESSAGE
    )

    const created = (await controlApi.createRecipe(exact)) as {
      spec?: { workloads?: Array<{ egressBindings?: unknown[] }> }
    }
    expect(created.spec?.workloads?.[0]?.egressBindings).toEqual([
      { egressClass: 'exact-host', dns: 'example.com', port: 443, protocol: 'TCP' },
    ])

    const updated = (await controlApi.updateRecipe(API_EXACT_HOST_RECIPE, updatedExact)) as {
      spec?: { workloads?: Array<{ egressBindings?: unknown[] }> }
    }
    expect(updated.spec?.workloads?.[0]?.egressBindings).toEqual([
      { egressClass: 'exact-host', dns: 'www.example.com', port: 443, protocol: 'TCP' },
    ])

    await expect(controlApi.createRecipe(publicWeb)).rejects.toThrow(
      NON_TRANSPORT_PUBLIC_WEB_MESSAGE
    )
    await expect(controlApi.updateRecipe(API_EXACT_HOST_RECIPE, publicWeb)).rejects.toThrow(
      NON_TRANSPORT_PUBLIC_WEB_MESSAGE
    )
  })

  test('Control API accepts declared internal sibling egress and rejects cross-namespace sibling DNS', async () => {
    const internal = internalSiblingRecipe(API_INTERNAL_SIBLING_RECIPE)
    const wrongNamespace = internalSiblingRecipe(
      'e2e-api-internal-sibling-wrong-ns',
      'db.other.svc.cluster.local'
    )

    await expect(controlApi.validateRecipe(internal)).resolves.toMatchObject({ valid: true })
    await expect(controlApi.validateRecipe(wrongNamespace)).rejects.toThrow(
      /targets namespace.*other/
    )

    const created = (await controlApi.createRecipe(internal)) as {
      spec?: { workloads?: Array<{ id?: string; egressBindings?: unknown[] }> }
    }
    const apiWorkload = created.spec?.workloads?.find(workload => workload.id === 'api')
    expect(apiWorkload?.egressBindings).toEqual([
      {
        egressClass: 'exact-host',
        dns: 'db.sandbox-recipes.svc.cluster.local',
        port: 5432,
        protocol: 'TCP',
      },
    ])
  })

  test('Control API rejects helpdesk-plugin-derived internal DNS outside the recipe namespace', async () => {
    const wrongNamespace = helpdeskPluginRecipe(
      API_HELPDESK_PLUGIN_WRONG_NS_RECIPE,
      'helpdesk-db.other.svc.cluster.local'
    )

    await expect(controlApi.validateRecipe(wrongNamespace)).rejects.toThrow(
      /targets namespace.*other/
    )
    await expect(controlApi.getRecipe(API_HELPDESK_PLUGIN_WRONG_NS_RECIPE)).rejects.toThrow(
      /404|not found/i
    )
  })

  test('Control API leaves adjacent public-web contracts untouched', async () => {
    await expect(
      controlApi.validateRecipe(transportPublicWebRecipe(API_TRANSPORT_PUBLIC_WEB_RECIPE))
    ).resolves.toMatchObject({ valid: true })
    await expect(
      controlApi.validateRecipe(runtimePublicWebRecipe(API_RUNTIME_PUBLIC_WEB_RECIPE))
    ).resolves.toMatchObject({ valid: true })
  })
})
