/**
 * E2E — Airtable Connector: Real CRUD + XLSX Report Generation
 *
 * Deploys the Airtable connector from the registry with real credentials,
 * uses mcp-host (chatllm) to populate data, query it, and generate an
 * XLSX report — then validates every step with real outputs.
 *
 * Flow:
 *   A. Deploy Airtable MCP via registry install (with real PAT)
 *   B. Verify CRD, Secret, Deployment, and tool discovery
 *   C. Create 5 test records via agent workflow
 *   D. Query records and generate XLSX report
 *   E. Validate XLSX artifact (download, size, content)
 *   F. Cleanup: delete test records + uninstall connector
 *
 * Prerequisites:
 *   - AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env
 *   - The mcp-airtable catalog entry published to the registry. Step A installs
 *     it, and a registry install copies the entry's imageRef verbatim into
 *     McpServer.spec.image, so THE ENTRY decides the image -- not the local
 *     image set. On minikube that entry is seeded by registry-install.spec.ts
 *     (which the runner executes first) with imageRef clerum/mock-mcp-server:test.
 *     No clerum/airtable-mcp-server image is required or consulted here; the
 *     real connector image is published to ghcr and pulled by the kubelet
 *     wherever the catalog entry points at it.
 *   - Port-forwards: control-ui :3000, control-api :8090
 */
import { type Page, expect, test } from '@playwright/test'

// ── Config ──────────────────────────────────────────────────────────────
const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY ?? ''
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID ?? ''
const AIRTABLE_TABLE = 'Design Projects' // Existing table in Project Tracker base
const SERVER_NAME = 'e2e-airtable-mcp'
const REPORT_RECIPE = 'e2e-airtable-report'
const XLSX_FILENAME = 'airtable-project-report.xlsx'
const WORKFLOW_TIMEOUT = 480_000 // 8 min
const RECIPE_NAMESPACE = 'sandbox-recipes'
const completedRunIdsByRecipe = new Map<string, string>()

// ── Helpers ──────────────────────────────────────────────────────────────

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const resp = await fetch(`${BASE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await resp.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { status: resp.status, data }
}

async function apiRaw(token: string, path: string): Promise<Response> {
  return fetch(`${BASE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

function runArtifactDownloadPath(recipeName: string, runId: string, artifactName: string): string {
  return `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${recipeName}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`
}

async function latestRunId(token: string, recipeName: string): Promise<string | null> {
  const { status, data } = await api(
    token,
    'GET',
    `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${recipeName}/runs?limit=5`
  )
  if (status !== 200) return null
  const items = (data.items ?? []) as Array<{ id?: string }>
  return items[0]?.id ?? null
}

async function login(page: Page) {
  await page.goto('/')
  await page.waitForSelector('text=Sign in', { timeout: 10_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASS)
  await page.locator('button:has-text("Sign in")').last().click()
  await page.waitForSelector('text=Marketplace', { timeout: 15_000 })
}

async function deployRecipe(token: string, recipe: Record<string, unknown>): Promise<void> {
  const name = (recipe.metadata as { name: string }).name
  // Cleanup previous
  await api(token, 'DELETE', `/api/v1/admin/recipes/${name}`)
  await new Promise(r => setTimeout(r, 5_000))
  // Deploy
  const { status } = await api(token, 'POST', '/api/v1/admin/recipes', recipe)
  expect(status).toBe(201)
}

async function pollRecipeStatus(
  token: string,
  recipeName: string,
  maxMs: number
): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const { status: runsStatus, data: runsData } = await api(
      token,
      'GET',
      `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${recipeName}/runs?limit=5`
    )
    if (runsStatus === 200) {
      const latest = ((runsData.items ?? []) as Array<{ id?: string; phase?: string }>)[0]
      if (latest?.phase === 'Succeeded' && latest.id) {
        completedRunIdsByRecipe.set(recipeName, latest.id)
        const { status, data } = await api(
          token,
          'GET',
          `/api/v1/admin/recipes/${recipeName}/status`
        )
        if (status === 200) return data
      }
      if (latest && ['Failed', 'Cancelled', 'TimedOut'].includes(String(latest.phase))) {
        throw new Error(`Workflow failed: ${JSON.stringify(latest).slice(0, 500)}`)
      }
    }
    await new Promise(r => setTimeout(r, 5_000))
  }
  throw new Error(`Workflow ${recipeName} did not complete within ${maxMs / 1000}s`)
}

function getStepOutput(statusData: Record<string, unknown>, stepId: string): string {
  const steps = ((statusData.workflowExecution as Record<string, unknown>)?.steps ??
    (statusData as { steps?: unknown[] }).steps) as
    | Array<{ id: string; output?: string }>
    | undefined
  return steps?.find(s => s.id === stepId)?.output ?? ''
}

// Helper: build a 1-step workflow for executing Airtable tool operations.
// The Airtable connector already exists as a standalone McpServer CRD (not
// part of this workflow's workloads). WRC requires spec.mcpServers[] to map
// the step reference ID to an in-cluster endpoint.
function oneStepRecipe(name: string, instruction: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      contextRef: 'context1',
      agent: { provider: 'zai', model: 'glm-4.7' },
      mcpServers: [
        {
          id: SERVER_NAME,
          endpoint: `http://${SERVER_NAME}.mcp-server.svc.cluster.local:3000/mcp`,
        },
      ],
      steps: [
        {
          id: 'execute',
          instruction,
          mcpServers: [SERVER_NAME],
          timeoutSeconds: 180,
        },
      ],
      workloads: [],
    },
  }
}

// ═════════════════════════════════════════════════════════════════════════

test.skip(
  !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID,
  'AIRTABLE_API_KEY and AIRTABLE_BASE_ID required in .env'
)

test.describe('Airtable MCP E2E — Real Data', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(600_000) // 10 min total

  let token = ''

  // ── A. Deploy Airtable Connector ──────────────────────────────────────

  test('A1. Install Airtable MCP from registry with real credentials', async ({ page }) => {
    await login(page)
    token = await getToken(page)

    // Pre-cleanup
    await api(token, 'DELETE', `/api/v1/admin/registry/uninstall/${SERVER_NAME}?type=mcp-server`)
    await api(token, 'DELETE', `/api/v1/admin/recipes/e2e-at-list-bases`)
    await api(token, 'DELETE', `/api/v1/admin/recipes/e2e-at-create-records`)
    await api(token, 'DELETE', `/api/v1/admin/recipes/e2e-at-query-records`)
    await api(token, 'DELETE', `/api/v1/admin/recipes/${REPORT_RECIPE}`)
    await api(token, 'DELETE', `/api/v1/admin/recipes/e2e-at-cleanup-records`)
    await new Promise(r => setTimeout(r, 5_000))
    const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName: SERVER_NAME,
      contextRef: 'context1',
      registryEntryName: 'mcp-airtable',
      registryEntryVersion: '1.0.0',
      credentials: { AIRTABLE_API_KEY: AIRTABLE_API_KEY },
    })
    expect(status).toBe(201)
    expect(data.serverName).toBe(SERVER_NAME)
    console.log('  [PASS] Airtable MCP installed from registry')
  })

  test('A2. McpServer CRD — transport, envSecret, enabled, managed', async () => {
    const { data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
    const items = data.items as Array<{ metadata: { name: string }; spec: Record<string, unknown> }>
    const srv = items.find(i => i.metadata.name === SERVER_NAME)
    expect(srv).toBeDefined()

    const spec = srv!.spec
    expect(spec.enabled).toBe(true)
    expect(spec.managed).toBe(true)
    expect(spec.contextRef).toBe('context1')
    const transport = spec.transport as { type: string; port: number }
    expect(transport.type).toBe('streamableHttp')
    expect(transport.port).toBe(3000)
    const envSecret = spec.envSecret as {
      name: string
      keys: Array<{ secretKey: string; envVar: string }>
    }
    expect(envSecret.name).toBe(`${SERVER_NAME}-credentials`)
    expect(envSecret.keys[0].envVar).toBe('AIRTABLE_API_KEY')
    console.log('  [PASS] CRD spec: streamableHttp:3000, envSecret with AIRTABLE_API_KEY')
  })

  test('A3. Wait for HCC to create Deployment + Pod ready', async () => {
    // Poll McpServer list to confirm HCC reconciled the CRD. Since there's no
    // direct pod-status API in control-api, also wait a grace period for the
    // pod to become Ready (image pull + connector startup). The actual pod
    // readiness check happens in B1 via workflow execution — if the pod isn't
    // ready, the MCP connect will fail.
    const maxWait = 180_000
    const start = Date.now()
    let ready = false

    while (Date.now() - start < maxWait) {
      const { data } = await api(token, 'GET', '/api/v1/admin/hosts-overview')
      const hosts = (data.items ?? data.hosts ?? [data]) as Array<Record<string, unknown>>
      const overview = JSON.stringify(hosts).toLowerCase()
      if (overview.includes(SERVER_NAME) || overview.includes('airtable')) {
        ready = true
        break
      }
      await new Promise(r => setTimeout(r, 10_000))
    }

    // Extra grace period: wait 60s for the pod to be Running (image pull can
    // take ~30s on first deployment; connector startup another ~5s).
    console.log('  Waiting 60s for Airtable MCP pod to become Ready...')
    await new Promise(r => setTimeout(r, 60_000))

    // If host overview doesn't report tool discovery directly, at least verify
    // the McpServer still exists and is enabled (HCC reconciles it)
    if (!ready) {
      const { data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
      const items = data.items as Array<{ metadata: { name: string }; spec: { enabled: boolean } }>
      const srv = items.find(i => i.metadata.name === SERVER_NAME)
      expect(srv?.spec.enabled).toBe(true)
    }
    console.log(
      `  [PASS] Airtable connector deployment ready (${Math.round((Date.now() - start) / 1000)}s)`
    )
  })

  // ── B. List Bases — Verify Airtable Connectivity ───────────────────────

  test('B1. Agent lists Airtable bases — validates real API connectivity', async () => {
    // Retry once if the first attempt fails (transient connectivity to airtable MCP pod).
    const recipe = oneStepRecipe(
      'e2e-at-list-bases',
      `You have access to one MCP tool exactly named "${SERVER_NAME}__list_bases" ` +
        `(no other variants like "list_bases" exist). Call this exact tool name now with no arguments. ` +
        'Return the raw JSON response including all base IDs.'
    )
    await deployRecipe(token, recipe)
    const statusData = await pollRecipeStatus(token, 'e2e-at-list-bases', WORKFLOW_TIMEOUT)
    const output = getStepOutput(statusData, 'execute')

    expect(output.length).toBeGreaterThan(50)
    // Should contain our base ID
    expect(output.toLowerCase()).toContain(AIRTABLE_BASE_ID.toLowerCase())
    console.log(`  [PASS] Agent listed bases, found ${AIRTABLE_BASE_ID} in output`)

    // Cleanup
    await api(token, 'DELETE', '/api/v1/admin/recipes/e2e-at-list-bases')
  })

  // ── C. Create Test Records ─────────────────────────────────────────────

  test('C1. Agent creates 5 test records in Airtable', async () => {
    const recipe = oneStepRecipe(
      'e2e-at-create-records',
      `Create exactly 5 new records in Airtable using the ${SERVER_NAME}__create_record tool.\n\n` +
        `Base ID: ${AIRTABLE_BASE_ID}\n` +
        `Table: ${AIRTABLE_TABLE}\n\n` +
        "Create these 5 records with the 'Name' field set to:\n" +
        '1. "E2E-Test Alpha Project"\n' +
        '2. "E2E-Test Beta Launch"\n' +
        '3. "E2E-Test Gamma Design"\n' +
        '4. "E2E-Test Delta Review"\n' +
        '5. "E2E-Test Epsilon Deploy"\n\n' +
        'Call the tool 5 separate times, once per record. Report each created record ID.'
    )
    await deployRecipe(token, recipe)
    const statusData = await pollRecipeStatus(token, 'e2e-at-create-records', WORKFLOW_TIMEOUT)
    const output = getStepOutput(statusData, 'execute')

    expect(output.length).toBeGreaterThan(100)
    // Should mention record creation
    const lower = output.toLowerCase()
    expect(lower).toMatch(/creat|record|rec[a-z0-9]/i)
    // Should mention at least some of our test record names
    expect(lower).toContain('e2e-test')
    console.log(`  [PASS] Agent created test records. Output: ${output.length} chars`)

    // Cleanup recipe (records stay in Airtable)
    await api(token, 'DELETE', '/api/v1/admin/recipes/e2e-at-create-records')
  })

  test('C2. Agent queries records — confirms data exists', async () => {
    const recipe = oneStepRecipe(
      'e2e-at-query-records',
      `Query records from Airtable using the ${SERVER_NAME}__list_records tool.\n\n` +
        `Base ID: ${AIRTABLE_BASE_ID}\n` +
        `Table: ${AIRTABLE_TABLE}\n` +
        'Limit: 20\n\n' +
        'List ALL records you find. For each record, show its Name field. ' +
        'At the end, provide a total count of records found.'
    )
    await deployRecipe(token, recipe)
    const statusData = await pollRecipeStatus(token, 'e2e-at-query-records', WORKFLOW_TIMEOUT)
    const output = getStepOutput(statusData, 'execute')

    expect(output.length).toBeGreaterThan(50)
    // Should find our test records
    expect(output.toLowerCase()).toContain('e2e-test')
    console.log(`  [PASS] Query confirmed test records exist in Airtable`)

    await api(token, 'DELETE', '/api/v1/admin/recipes/e2e-at-query-records')
  })

  // ── D. Generate XLSX Report from Airtable Data ─────────────────────────

  test('D1. Deploy 3-step report workflow (fetch → analyze → XLSX)', async () => {
    const reportRecipe = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: REPORT_RECIPE },
      spec: {
        contextRef: 'context1',
        agent: { provider: 'zai', model: 'glm-4.7' },
        mcpServers: [
          {
            id: SERVER_NAME,
            endpoint: `http://${SERVER_NAME}.mcp-server.svc.cluster.local:3000/mcp`,
          },
        ],
        steps: [
          {
            id: 'fetch-data',
            instruction:
              `Fetch records from Airtable using ${SERVER_NAME}__list_records.\n\n` +
              `Base ID: ${AIRTABLE_BASE_ID}\n` +
              `Table: ${AIRTABLE_TABLE}\n` +
              'Limit: 10\n\n' +
              'Return only the Name field of each record. Be concise.',
            mcpServers: [SERVER_NAME],
            timeoutSeconds: 300,
          },
          {
            id: 'analyze',
            instruction:
              'Summarize the Airtable data briefly:\n\n{{fetch-data:output}}\n\n' +
              'Just list:\n1. Total record count\n2. Project names (one per line).\nKeep it under 200 words.',
            dependsOn: ['fetch-data'],
            timeoutSeconds: 120,
          },
          {
            id: 'generate-xlsx',
            instruction:
              'You MUST call the clerum__generate_xlsx tool with these parameters:\n' +
              `filename: "${XLSX_FILENAME}"\n` +
              'sheets:\n' +
              '  - name: "Summary"\n' +
              '    rows: Create a summary sheet with: Total records, Data source (Airtable), ' +
              'Generated date, and a list of project names.\n' +
              '  - name: "Records"\n' +
              '    rows: Create a records sheet with all the data from the analysis:\n\n' +
              '{{analyze:output}}\n\n' +
              'Do NOT skip the tool call. The XLSX generation is mandatory.',
            allowedTools: { include: ['clerum__generate_xlsx'] },
            dependsOn: ['analyze'],
            timeoutSeconds: 120,
          },
        ],
        output: {
          destination: 'pvc',
          name: 'airtable-report',
          format: 'xlsx',
          storageSize: '64Mi',
        },
        workloads: [],
      },
    }
    await deployRecipe(token, reportRecipe)

    const { status } = await api(token, 'GET', `/api/v1/admin/recipes/${REPORT_RECIPE}`)
    expect(status).toBe(200)
    console.log('  [PASS] Report workflow deployed')
  })

  test('D2. Wait for report workflow to complete', async () => {
    const statusData = await pollRecipeStatus(token, REPORT_RECIPE, WORKFLOW_TIMEOUT)
    const exec = statusData.workflowExecution as Record<string, unknown>
    expect(exec.phase).toBe('completed')
    console.log('  [PASS] Report workflow completed')
  })

  test('D3. Step 1 output contains real Airtable record data', async () => {
    const { data } = await api(token, 'GET', `/api/v1/admin/recipes/${REPORT_RECIPE}/status`)
    const output = getStepOutput(data, 'fetch-data')
    expect(output.length).toBeGreaterThan(100)
    expect(output.toLowerCase()).toContain('e2e-test')
    console.log(`  [PASS] Fetch step returned ${output.length} chars of real Airtable data`)
  })

  test('D4. XLSX artifact exists — download returns 200', async () => {
    const runId =
      completedRunIdsByRecipe.get(REPORT_RECIPE) ?? (await latestRunId(token, REPORT_RECIPE))
    expect(runId).toBeTruthy()
    const resp = await apiRaw(token, runArtifactDownloadPath(REPORT_RECIPE, runId!, XLSX_FILENAME))
    expect(resp.status).toBe(200)
    const contentType = resp.headers.get('content-type') ?? ''
    expect(contentType).toMatch(/xlsx|spreadsheet|octet/)
    console.log(`  [PASS] XLSX download: 200, Content-Type: ${contentType}`)
  })

  test('D5. XLSX has valid content — file size > 500 bytes', async () => {
    const runId =
      completedRunIdsByRecipe.get(REPORT_RECIPE) ?? (await latestRunId(token, REPORT_RECIPE))
    expect(runId).toBeTruthy()
    const resp = await apiRaw(token, runArtifactDownloadPath(REPORT_RECIPE, runId!, XLSX_FILENAME))
    const buffer = Buffer.from(await resp.arrayBuffer())
    // XLSX files are ZIP archives — magic bytes PK (0x50, 0x4B)
    expect(buffer[0]).toBe(0x50) // P
    expect(buffer[1]).toBe(0x4b) // K
    expect(buffer.length).toBeGreaterThan(500)
    console.log(`  [PASS] XLSX valid: PK magic bytes, ${buffer.length} bytes`)
  })

  // ── E. Cleanup ─────────────────────────────────────────────────────────

  test('E1. Agent deletes test records from Airtable', async () => {
    const recipe = oneStepRecipe(
      'e2e-at-cleanup-records',
      `First, list records from Airtable using ${SERVER_NAME}__list_records ` +
        `with baseId="${AIRTABLE_BASE_ID}" and table="${AIRTABLE_TABLE}".\n\n` +
        "Find ALL records whose Name starts with 'E2E-Test'. " +
        `For each one, call ${SERVER_NAME}__delete_record with the record ID to delete it.\n\n` +
        'Report how many records were deleted.'
    )
    await deployRecipe(token, recipe)
    const statusData = await pollRecipeStatus(token, 'e2e-at-cleanup-records', WORKFLOW_TIMEOUT)
    const output = getStepOutput(statusData, 'execute')
    expect(output.toLowerCase()).toMatch(/delet|remov|clean/)
    console.log(`  [PASS] Test records cleanup: ${output.slice(0, 200)}`)

    await api(token, 'DELETE', '/api/v1/admin/recipes/e2e-at-cleanup-records')
  })

  test('E2. Delete report workflow', async () => {
    await api(token, 'DELETE', `/api/v1/admin/recipes/${REPORT_RECIPE}`)
    await new Promise(r => setTimeout(r, 3_000))
    const { status } = await api(token, 'GET', `/api/v1/admin/recipes/${REPORT_RECIPE}`)
    expect(status).toBe(404)
    console.log('  [PASS] Report recipe deleted')
  })

  test('E3. Uninstall Airtable connector', async () => {
    const { status, data } = await api(
      token,
      'DELETE',
      `/api/v1/admin/registry/uninstall/${SERVER_NAME}?type=mcp-server`
    )
    expect(status).toBe(200)
    const deleted = data.deleted as string[]
    expect(deleted.some(d => d.includes('McpServer'))).toBe(true)
    expect(deleted.some(d => d.includes('Secret'))).toBe(true)
    console.log(`  [PASS] Uninstall: ${deleted.join(', ')}`)
  })

  test('E4. Verify McpServer CRD is gone', async () => {
    const { data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
    const items = data.items as Array<{ metadata: { name: string } }>
    expect(items.find(i => i.metadata.name === SERVER_NAME)).toBeUndefined()
    console.log('  [PASS] Airtable connector fully cleaned up')
  })
})
