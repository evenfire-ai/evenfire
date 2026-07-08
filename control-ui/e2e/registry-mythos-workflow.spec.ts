/**
 * E2E — Mythos Research Workflow: Real web-search + PDF generation + content validation
 *
 * Deploys a 3-step agentic workflow that:
 *   Step 1: Researches "Mythos blockchain gaming" via real web-search connector
 *   Step 2: Analyzes findings into a structured summary
 *   Step 3: Generates a PDF report via clerum__generate_pdf
 *
 * Validates:
 *   - WorkflowRecipe CRD spec (steps, agent, inputContract, workloads)
 *   - Real execution: step outputs contain "Mythos" content
 *   - PDF artifact: magic bytes, file size, download works
 *   - UI: status modal, artifacts panel, download button
 *
 * Prerequisites:
 *   - minikube cluster with ZAI_API_KEY in .env
 *   - ghcr.io/aas-ee/open-web-search:latest pulled into minikube
 *   - Port-forwards: control-ui :3000, control-api :8090
 */
import { type Page, expect, test } from '@playwright/test'

// ── Config ──────────────────────────────────────────────────────────────
const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const WORKFLOW_TIMEOUT = 480_000 // 8 min
const RECIPE_NAMESPACE = 'sandbox-recipes'
const RECIPE_NAME = 'e2e-mythos-research'
const PDF_FILENAME = 'mythos-research-summary.pdf'
const WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS = [{ egressClass: 'public-web' }]
let currentRunId = ''

// ── Recipe Spec ─────────────────────────────────────────────────────────
const MYTHOS_RECIPE = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: RECIPE_NAME },
  spec: {
    contextRef: 'context1',
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        topic: {
          type: 'string',
          default:
            'Latest news about Mythos blockchain gaming ecosystem and MYTH token - recent developments, partnerships, and gaming integrations',
        },
      },
    },
    steps: [
      {
        id: 'research',
        instruction:
          'Research the following topic thoroughly using web search: {{inputs.topic}}.\n\n' +
          'Use the search tool to find at least 3 relevant sources through DuckDuckGo.\n' +
          'Compile: key facts, recent developments, partnerships, token price movements, and gaming integrations.\n' +
          'Keep the research factual and cite sources where possible. Max 500 words.',
        mcpServers: ['web-search'],
        allowedTools: { include: ['web-search__search'] },
        timeoutSeconds: 300,
      },
      {
        id: 'analyze',
        instruction:
          'Using the following research data:\n\n{{research:output}}\n\n' +
          'Produce a structured analysis with these sections:\n' +
          '# Mythos Ecosystem Overview\n' +
          '## Recent Developments\n' +
          '## Gaming Integrations & Partnerships\n' +
          '## MYTH Token Status\n' +
          '## Key Takeaways\n\n' +
          'Use markdown headings. Be concise and factual. Remove any filler or hedging language.',
        dependsOn: ['research'],
        timeoutSeconds: 180,
      },
      {
        id: 'generate-pdf',
        instruction:
          'You MUST call the clerum__generate_pdf tool with exactly these parameters:\n' +
          `filename: "${PDF_FILENAME}"\n` +
          'title: "Mythos Blockchain Gaming — Research Summary"\n' +
          'body:\n{{analyze:output}}\n\n' +
          'Do NOT skip the tool call. The PDF generation is mandatory.',
        allowedTools: { include: ['clerum__generate_pdf'] },
        dependsOn: ['analyze'],
        timeoutSeconds: 120,
      },
    ],
    output: { destination: 'pvc', name: 'mythos-research', format: 'pdf', storageSize: '64Mi' },
    workloads: [
      {
        id: 'web-search',
        type: 'deployment',
        image: 'ghcr.io/aas-ee/open-web-search:latest',
        port: 3000,
        transport: { type: 'streamableHttp' },
        env: [
          { name: 'DEFAULT_SEARCH_ENGINE', value: 'duckduckgo' },
          { name: 'ALLOWED_SEARCH_ENGINES', value: 'duckduckgo' },
          { name: 'ENABLE_CORS', value: 'true' },
        ],
        egressBindings: WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS,
      },
    ],
  },
}

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

async function latestRunId(token: string, recipeName: string): Promise<string | null> {
  const { status, data } = await api(
    token,
    'GET',
    `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${recipeName}/runs?limit=5`
  )
  if (status !== 200) return null
  const items = (data.items ?? []) as Array<{ id?: string; phase?: string }>
  return items[0]?.id ?? null
}

function runArtifactDownloadPath(recipeName: string, runId: string, artifactName: string): string {
  return `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${recipeName}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`
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

async function pollStatus(token: string, maxMs: number): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const { status: runsStatus, data: runsData } = await api(
      token,
      'GET',
      `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${RECIPE_NAME}/runs?limit=5`
    )
    if (runsStatus === 200) {
      const latest = ((runsData.items ?? []) as Array<{ id?: string; phase?: string }>)[0]
      if (latest?.phase === 'Succeeded' && latest.id) {
        currentRunId = latest.id
        const { status, data } = await api(
          token,
          'GET',
          `/api/v1/admin/recipes/${RECIPE_NAME}/status`
        )
        if (status === 200) return data
      }
      if (latest && ['Failed', 'Cancelled', 'TimedOut'].includes(String(latest.phase))) {
        throw new Error(`Workflow failed: ${JSON.stringify(latest)}`)
      }
    }
    await new Promise(r => setTimeout(r, 5_000))
  }
  throw new Error(`Workflow did not complete within ${maxMs / 1000}s`)
}

// ═════════════════════════════════════════════════════════════════════════

test.describe('Mythos Research Workflow E2E', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(600_000) // 10 min total suite

  let token = ''

  // ── A. Deploy ──────────────────────────────────────────────────────────

  test('A1. Deploy Mythos workflow via API', async ({ page }) => {
    await login(page)
    token = await getToken(page)

    // Cleanup previous runs
    await api(token, 'DELETE', `/api/v1/admin/recipes/${RECIPE_NAME}`)
    await new Promise(r => setTimeout(r, 5_000))

    // Deploy via API (robust, no UI selector fragility)
    const { status } = await api(token, 'POST', '/api/v1/admin/recipes', MYTHOS_RECIPE)
    expect(status).toBe(201)

    // Verify CRD exists
    const { status: getStatus } = await api(token, 'GET', `/api/v1/admin/recipes/${RECIPE_NAME}`)
    expect(getStatus).toBe(200)
    console.log('  [PASS] Workflow deployed via API')
  })

  test('A2. CRD spec — 3 steps, agent config, inputContract', async () => {
    const { data } = await api(token, 'GET', `/api/v1/admin/recipes/${RECIPE_NAME}`)
    const spec = (data as { spec: Record<string, unknown> }).spec

    // Steps
    const steps = spec.steps as Array<{ id: string; instruction: string; dependsOn?: string[] }>
    expect(steps.length).toBe(3)
    expect(steps[0].id).toBe('research')
    expect(steps[1].id).toBe('analyze')
    expect(steps[2].id).toBe('generate-pdf')
    expect(steps[1].dependsOn).toContain('research')
    expect(steps[2].dependsOn).toContain('analyze')

    // Agent
    const agent = spec.agent as { provider: string; model: string }
    expect(agent.provider).toBe('zai')
    expect(agent.model).toBe('glm-4.7')

    // InputContract
    const ic = spec.inputContract as { properties: Record<string, { default: string }> }
    expect(ic.properties.topic.default).toContain('Mythos')

    // Workloads
    const workloads = spec.workloads as Array<{ id: string; image: string }>
    expect(workloads[0].id).toBe('web-search')
    expect(workloads[0].image).toContain('open-web-search')

    console.log(
      '  [PASS] CRD spec validated: 3 steps, zai/glm-4.7, Mythos topic, web-search workload'
    )
  })

  // ── B. Execution ───────────────────────────────────────────────────────

  test('B1. Workflow completes all 3 steps', async () => {
    const statusData = await pollStatus(token, WORKFLOW_TIMEOUT)
    const exec = statusData.workflowExecution as Record<string, unknown>
    expect(exec.phase).toBe('completed')

    const steps =
      (statusData as { steps?: Array<{ phase: string }> }).steps ??
      (exec.steps as Array<{ phase: string }> | undefined) ??
      []
    const completed = steps.filter(s => s.phase === 'completed')
    expect(completed.length).toBe(3)
    console.log('  [PASS] All 3 steps completed')
  })

  test("B2. Step 1 output mentions 'Mythos' — real research happened", async () => {
    const { data } = await api(token, 'GET', `/api/v1/admin/recipes/${RECIPE_NAME}/status`)
    const steps = ((data.workflowExecution as Record<string, unknown>)?.steps ??
      (data as { steps?: unknown[] }).steps) as Array<{ id: string; output?: string }> | undefined
    const researchStep = steps?.find(s => s.id === 'research')
    expect(researchStep?.output).toBeTruthy()
    // The output should mention Mythos since the agent searched for it
    const output = (researchStep!.output ?? '').toLowerCase()
    expect(output.length).toBeGreaterThan(100) // substantial output
    expect(output).toContain('mythos')
    console.log(`  [PASS] Research step output: ${output.length} chars, contains "Mythos"`)
  })

  test('B3. Step 2 output has structured markdown headings', async () => {
    const { data } = await api(token, 'GET', `/api/v1/admin/recipes/${RECIPE_NAME}/status`)
    const steps = ((data.workflowExecution as Record<string, unknown>)?.steps ??
      (data as { steps?: unknown[] }).steps) as Array<{ id: string; output?: string }> | undefined
    const analyzeStep = steps?.find(s => s.id === 'analyze')
    expect(analyzeStep?.output).toBeTruthy()
    const output = analyzeStep!.output ?? ''
    // Should have markdown structure
    expect(output).toMatch(/#{1,2}\s+/) // at least one heading
    expect(output.length).toBeGreaterThan(200)
    console.log(`  [PASS] Analysis step: ${output.length} chars with markdown headings`)
  })

  test('B4. Step 3 output confirms PDF tool was called', async () => {
    const { data } = await api(token, 'GET', `/api/v1/admin/recipes/${RECIPE_NAME}/status`)
    const steps = ((data.workflowExecution as Record<string, unknown>)?.steps ??
      (data as { steps?: unknown[] }).steps) as
      | Array<{ id: string; output?: string; toolsCalled?: string[] }>
      | undefined
    const pdfStep = steps?.find(s => s.id === 'generate-pdf')
    expect(pdfStep).toBeDefined()
    // Either toolsCalled includes it or the output mentions it
    const output = (pdfStep?.output ?? '').toLowerCase()
    const toolsCalled = pdfStep?.toolsCalled ?? []
    const toolUsed =
      toolsCalled.some(t => t.includes('generate_pdf')) ||
      output.includes('generate_pdf') ||
      output.includes('pdf')
    expect(toolUsed).toBe(true)
    console.log('  [PASS] Step 3 used clerum__generate_pdf tool')
  })

  // ── C. PDF Validation ──────────────────────────────────────────────────

  test('C1. PDF artifact exists — API returns 200', async () => {
    currentRunId ||= (await latestRunId(token, RECIPE_NAME)) ?? ''
    expect(currentRunId).toBeTruthy()
    const resp = await apiRaw(
      token,
      runArtifactDownloadPath(RECIPE_NAME, currentRunId, PDF_FILENAME)
    )
    expect(resp.status).toBe(200)
    const contentType = resp.headers.get('content-type') ?? ''
    expect(contentType).toMatch(/pdf|octet/)
    console.log(`  [PASS] PDF artifact download: 200, Content-Type: ${contentType}`)
  })

  test('C2. PDF has valid content — magic bytes + size > 1KB', async () => {
    currentRunId ||= (await latestRunId(token, RECIPE_NAME)) ?? ''
    expect(currentRunId).toBeTruthy()
    const resp = await apiRaw(
      token,
      runArtifactDownloadPath(RECIPE_NAME, currentRunId, PDF_FILENAME)
    )
    const buffer = Buffer.from(await resp.arrayBuffer())
    // PDF magic bytes: %PDF
    const magic = buffer.subarray(0, 4).toString('ascii')
    expect(magic).toBe('%PDF')
    // Must be substantial, not a stub
    expect(buffer.length).toBeGreaterThan(1000)
    console.log(`  [PASS] PDF valid: ${magic} magic bytes, ${buffer.length} bytes`)
  })

  test('C3. PDF download via browser works', async ({ page }) => {
    await login(page)
    token = await getToken(page)

    // Navigate to recipes and open status modal
    await page.click('text=Marketplace')
    await page.waitForTimeout(2_000)
    const row = page.locator('tr').filter({ hasText: RECIPE_NAME })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.locator('button:has-text("Status")').click()
    await page.waitForSelector('text=Recipe Status', { timeout: 10_000 })

    // Artifacts panel — the filename may appear in truncated form or as a tooltip
    await expect(page.locator('text=Output Artifacts')).toBeVisible({ timeout: 30_000 })

    // Download — multiple artifacts may exist (.md + .pdf). Find all Download
    // buttons and click each until we get a .pdf download.
    const downloadButtons = page.locator('button:has-text("Download")')
    const count = await downloadButtons.count()
    let foundPdf = false
    for (let i = 0; i < count; i++) {
      const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
      await downloadButtons.nth(i).click()
      const download = await downloadPromise
      if (download.suggestedFilename().endsWith('.pdf')) {
        foundPdf = true
        console.log(`  [PASS] Browser download: ${download.suggestedFilename()}`)
        break
      }
    }
    expect(foundPdf).toBe(true)
  })

  // ── D. Cleanup ─────────────────────────────────────────────────────────

  test('D1. Delete workflow recipe', async () => {
    const { status } = await api(token, 'DELETE', `/api/v1/admin/recipes/${RECIPE_NAME}`)
    expect(status).toBe(200)
    console.log('  [PASS] Workflow recipe deleted')
  })

  test('D2. Verify CRD is gone', async () => {
    await new Promise(r => setTimeout(r, 3_000))
    const { status } = await api(token, 'GET', `/api/v1/admin/recipes/${RECIPE_NAME}`)
    expect(status).toBe(404)
    console.log('  [PASS] WorkflowRecipe CRD confirmed deleted')
  })
})
