/**
 * GKE Workflow E2E — Playwright tests for all workflow templates on production GKE.
 *
 * Uses "The Blog leak about the new frontier model called Mythos" as the research
 * topic across all workflows, adapted per template type:
 *   1. Agentic Workflow (PDF) — research + summarize + generate PDF
 *   2. Competitive Intel (PDF) — competitor analysis of Mythos vs other frontier models
 *   3. Market Data Dashboard (XLSX) — economic impact analysis of Mythos
 *   4. Due Diligence Package (PDF+XLSX) — full DD on Anthropic re: Mythos
 *
 * Prerequisites:
 *   - GKE cluster with all Clerum services running v0.9.5+
 *   - Port-forwards: control-ui :3000, control-api :8090
 *   - Admin credentials: admin / changeme123!
 *   - clerum-model-secret-mapping + LLM API keys configured
 *   - web-search MCP image available: ghcr.io/aas-ee/open-web-search:latest
 *
 * Run:
 *   cd control-ui && npx playwright test e2e/gke-workflow-mythos.spec.ts
 */
import { type Download, type Page, expect, test } from '@playwright/test'

// ── Config ───────────────────────────────────────────────────────────────
// 12 min max per workflow. Rationale: per-step `timeoutSeconds` sum to 600s
// (300+180+120) for the agentic pipeline — the old 8-min budget was below
// worst-case and only passed on minikube because local LLM+DuckDuckGo
// round-trips are faster than from GCP-dev. Set to 720s (10-min worst case
// + 2-min buffer for WRC reconciliation + UI polling cadence).
const WORKFLOW_TIMEOUT = 720_000
const STEP_RENDER_WAIT = 5_000
const ADMIN_USER = 'admin'
const ADMIN_PASS = 'changeme123!'
const RECIPE_NS = 'sandbox-recipes'
const WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS = [{ egressClass: 'public-web' }]

// ── Helpers ──────────────────────────────────────────────────────────────

async function login(page: Page): Promise<void> {
  await page.goto('/')
  // Login form uses htmlFor/id (app/page.tsx:520-554) — no placeholder attribute.
  await page.waitForSelector('#cu-login-user', { timeout: 10_000 })
  await page.fill('#cu-login-user', ADMIN_USER)
  await page.fill('#cu-login-pass', ADMIN_PASS)
  await page.click('button[type="submit"]')
  await page.waitForSelector('text=Marketplace', { timeout: 15_000 })
}

async function navigateToRecipes(page: Page): Promise<void> {
  await page.click('text=Workflow Recipes')
  await page.waitForTimeout(1000)
}

async function installRecipe(page: Page, recipeJson: Record<string, unknown>): Promise<void> {
  await page.click('button:has-text("Install Recipe")')
  await page.waitForSelector('textarea', { timeout: 5_000 })
  const textarea = page.locator('textarea').first()
  await textarea.fill(JSON.stringify(recipeJson, null, 2))
  await page.click('button:has-text("Review manifest")')
  await page.waitForSelector('text=Manifest review passed', { timeout: 10_000 })
  await page.click('button:has-text("Apply defaults")')
  await page.click('button:has-text("Continue to access")')
  await page.waitForSelector('button:has-text("Deploy plugin")', { timeout: 10_000 })
  await page.click('button:has-text("Deploy plugin")')
  await page.waitForTimeout(3_000)
}

async function waitForWorkflowCompletion(
  page: Page,
  recipeName: string,
  expectedSteps: number
): Promise<void> {
  // Find recipe row and click Status.
  // IMPORTANT: scope the locator to <tr> only. Previously 'tr, div' also
  // matched any ancestor <div> containing the recipe text (e.g. the wrapping
  // section that holds the whole table), producing Playwright strict-mode
  // violations when multiple Status buttons were reachable from that ancestor.
  const row = page.locator('tr').filter({ hasText: recipeName }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  const statusBtn = row.locator('button:has-text("Status")')
  await statusBtn.click()
  await page.waitForSelector('text=Recipe Status', { timeout: 10_000 })

  // Wait for workflow completion.
  // IMPORTANT: scope to the workflow-execution phase badge via data-testid.
  // Previously `text=completed` matched any element containing the word — on
  // GCP-dev the per-step phase badge ("completed") for step 1 fired in ~28s
  // while workflowExecution.phase was still "initializing", causing the test
  // to race past this wait and then fail the Progress assertion. Scoping the
  // wait to the *workflow* phase badge (not step badges) is the canonical fix.
  const wfPhaseBadge = page.locator('[data-testid="wf-execution-phase"]')
  await expect(wfPhaseBadge).toHaveText('completed', { timeout: WORKFLOW_TIMEOUT })

  // Verify step count
  await page.waitForTimeout(STEP_RENDER_WAIT)
  const progressText = page.locator(`text=Progress: ${expectedSteps}/${expectedSteps}`)
  await expect(progressText).toBeVisible({ timeout: 10_000 })
}

async function verifyAndDownloadArtifact(
  page: Page,
  filename: string,
  expectedBadge: string
): Promise<Download> {
  // IMPORTANT: every assertion in this helper is scoped to the artifacts panel
  // via data-testid. The filename and format strings ALSO appear in:
  //   1. the step-output <pre> (LLM prose describing the generated file)
  //   2. the Raw JSON <details> panel (CRD status dump)
  // Without scoping, `text=<filename>` matched 3 elements and Playwright's
  // strict mode threw before any visibility check. Scoping via
  // [data-testid="artifacts-panel"] guarantees we only inspect the table of
  // real downloadable artifacts and not any textual mention elsewhere.
  const panel = page.locator('[data-testid="artifacts-panel"]')
  await expect(panel).toBeVisible({ timeout: 10_000 })

  // The per-artifact <div> carries `data-artifact-name=<filename>` so we can
  // target exactly one row regardless of ordering or adjacent artifacts.
  const row = panel.locator(`[data-testid="artifact-row"][data-artifact-name="${filename}"]`)
  await expect(row).toHaveCount(1, { timeout: 10_000 })

  // Format badge (e.g. "PDF", "XLSX", "MD") — scoped to the row so it cannot
  // collide with the word inside Raw JSON or LLM-generated prose.
  await expect(row.locator('[data-testid="artifact-format"]')).toHaveText(expectedBadge)

  // Filename label — same scoping rationale.
  await expect(row.locator('[data-testid="artifact-name"]')).toHaveText(filename)

  // Trigger download through the row-local canonical action menu.
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await row.getByRole('button', { name: `Actions for artifact ${filename}` }).click()
  await page.getByRole('menuitem', { name: 'Download' }).click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toBe(filename)
  const filePath = await download.path()
  expect(filePath).toBeTruthy()

  return download
}

async function closeModal(page: Page): Promise<void> {
  await page.click('button:has-text("Close")')
  await page.waitForTimeout(500)
}

async function cleanupRecipe(recipeName: string): Promise<void> {
  const { execFileSync } = await import('child_process')
  // 1) Issue the delete (non-blocking). --ignore-not-found silences the noisy
  //    error path when a previous run already removed the recipe.
  //    execFileSync (no shell) avoids command-injection surface even though
  //    recipeName is a compile-time constant in the mythos spec.
  try {
    execFileSync(
      'kubectl',
      [
        'delete',
        'workflowrecipe',
        recipeName,
        '-n',
        RECIPE_NS,
        '--wait=false',
        '--ignore-not-found',
      ],
      { stdio: 'pipe' }
    )
  } catch {
    // Best-effort — transient kubectl/network failures fall through to the poll.
  }
  // 2) Poll until the resource is truly absent from the API server.
  //    Rationale: WRC's finalizer drives cascade cleanup (Deployments, Pods,
  //    ConfigMap, per-step Secrets) which can outlive `kubectl delete --timeout`
  //    on a busy shared dev cluster. Without this wait, the next `installRecipe`
  //    creates a new CR while the old one is still Terminating — leaving TWO
  //    rows with the same name in the UI and triggering Playwright strict-mode
  //    violations ("locator resolved to 2 elements") during the next test run.
  const deadlineMs = Date.now() + 180_000 // 3 min — matches WRC reconcile cadence
  while (Date.now() < deadlineMs) {
    try {
      execFileSync('kubectl', ['get', 'workflowrecipe', recipeName, '-n', RECIPE_NS], {
        stdio: 'pipe',
      })
      // Still present → wait and re-check.
      await new Promise(r => setTimeout(r, 2_000))
    } catch {
      // `kubectl get` exits non-zero on NotFound → cleanup succeeded.
      return
    }
  }
  throw new Error(
    `cleanupRecipe(${recipeName}): resource still present after 180s — aborting to prevent Terminating/Active race condition in subsequent tests`
  )
}

// ── Recipes (Mythos theme) ───────────────────────────────────────────────

const AGENTIC_RECIPE = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'e2e-mythos-agentic' },
  spec: {
    contextRef: 'context1',
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        topic: {
          type: 'string',
          default: 'The Blog leak about the new frontier model called Mythos',
        },
      },
    },
    steps: [
      {
        id: 'research',
        instruction:
          'Research the following topic thoroughly: {{inputs.topic}}. ' +
          'Use the search tool through DuckDuckGo to find relevant articles. ' +
          'Collect key facts, capabilities, and industry reactions. Max 300 words.',
        mcpServers: ['web-search'],
        allowedTools: { include: ['web-search__search'] },
        timeoutSeconds: 300,
      },
      {
        id: 'summarize',
        instruction:
          'Using the research results:\n\n{{research:output}}\n\n' +
          'Write a structured summary with: Executive Overview, Key Findings, ' +
          'Timeline of Events, and Recommended Next Steps. Use markdown headings.',
        dependsOn: ['research'],
        timeoutSeconds: 180,
      },
      {
        id: 'generate-report',
        instruction:
          'You MUST call the clerum__generate_pdf tool to create the report.\n\n' +
          'filename: "mythos-research-summary.pdf"\n' +
          'title: "Mythos Frontier Model — Research Summary"\n' +
          'body:\n{{summarize:output}}',
        allowedTools: { include: ['clerum__generate_pdf'] },
        dependsOn: ['summarize'],
        timeoutSeconds: 120,
      },
    ],
    output: { destination: 'pvc', name: 'mythos-agentic', format: 'pdf', storageSize: '64Mi' },
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

const COMPETITIVE_INTEL_RECIPE = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'e2e-mythos-competitive' },
  spec: {
    contextRef: 'context1',
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        industry: { type: 'string', default: 'frontier AI models' },
        competitors: { type: 'string', default: 'Claude Mythos, GPT-5, Gemini Ultra 2, Llama 4' },
        focus_areas: {
          type: 'string',
          default: 'capabilities, safety measures, pricing, availability',
        },
      },
    },
    mcpServers: [{ id: 'web-search' }],
    steps: [
      {
        id: 'research-competitors',
        instruction:
          'Research each competitor: {{inputs.competitors}}.\n' +
          'Industry: {{inputs.industry}}. Focus: {{inputs.focus_areas}}.\n\n' +
          'For each, use search to find: pricing, capabilities, release dates, ' +
          'safety measures, and developer reception. Max 400 words per competitor.',
        mcpServers: ['web-search'],
        allowedTools: { include: ['web-search__search'] },
        timeoutSeconds: 300,
      },
      {
        id: 'analyze-market',
        instruction:
          'Analyze the competitor research:\n\n{{research-competitors:output}}\n\n' +
          'Produce: Feature comparison table, pricing comparison, ' +
          'SWOT per competitor, and strategic recommendations. Use markdown tables.',
        dependsOn: ['research-competitors'],
        timeoutSeconds: 240,
      },
      {
        id: 'deslop',
        instruction:
          'Clean the analysis:\n\n{{analyze-market:output}}\n\n' +
          'Remove: filler text, unsupported claims, hedging language, AI slop patterns. ' +
          'Preserve: factual data, tables, concrete recommendations.',
        dependsOn: ['analyze-market'],
        timeoutSeconds: 180,
      },
      {
        id: 'generate-report',
        instruction:
          'You MUST call the clerum__generate_pdf tool.\n\n' +
          'filename: "mythos-competitive-intel.pdf"\n' +
          'title: "Competitive Intelligence: Frontier AI Models — Mythos vs Competition"\n' +
          'body:\n{{deslop:output}}',
        allowedTools: { include: ['clerum__generate_pdf'] },
        dependsOn: ['deslop'],
        timeoutSeconds: 120,
      },
    ],
    output: { destination: 'pvc', name: 'mythos-competitive', format: 'pdf', storageSize: '128Mi' },
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

const MARKET_DASHBOARD_RECIPE = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'e2e-mythos-market' },
  spec: {
    contextRef: 'context1',
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        topic: {
          type: 'string',
          default: 'Economic impact of Mythos frontier AI model on the US economy',
        },
        sectors: {
          type: 'string',
          default: 'Technology, Healthcare, Finance, Education, Manufacturing, Defense',
        },
      },
    },
    mcpServers: [{ id: 'web-search' }],
    steps: [
      {
        id: 'collect-data',
        instruction:
          'Research the economic impact of frontier AI models like Mythos on these sectors: {{inputs.sectors}}.\n' +
          'Topic: {{inputs.topic}}.\n\n' +
          'For each sector, find: current AI adoption rate, projected impact, GDP contribution, ' +
          'job displacement risk, and investment trends. Use concrete numbers where available.',
        mcpServers: ['web-search'],
        allowedTools: { include: ['web-search__search'] },
        timeoutSeconds: 300,
      },
      {
        id: 'analyze-impact',
        instruction:
          'Analyze the collected economic data:\n\n{{collect-data:output}}\n\n' +
          'Produce: sector ranking by impact, risk assessment per sector, ' +
          'projected GDP effect, and policy recommendations. Structure ALL data as tables.',
        dependsOn: ['collect-data'],
        timeoutSeconds: 180,
      },
      {
        id: 'generate-excel',
        instruction:
          'You MUST call the clerum__generate_xlsx tool.\n\n' +
          'filename: "mythos-economic-impact.xlsx"\n' +
          'Create sheets from this analysis:\n\n{{analyze-impact:output}}\n\n' +
          'Sheet 1 "Overview": All sectors with current metrics\n' +
          'Sheet 2 "GDP Impact": Sector, Current GDP %, Projected Change, Timeline\n' +
          'Sheet 3 "Risk Assessment": Sector, Risk Level, Job Impact, Mitigation\n' +
          'Sheet 4 "Investment Trends": Sector, 2025 Investment, 2026 Projected, Growth %\n' +
          'Sheet 5 "Policy Recommendations": Recommendation, Priority, Expected Outcome',
        allowedTools: { include: ['clerum__generate_xlsx'] },
        dependsOn: ['analyze-impact'],
        timeoutSeconds: 120,
      },
    ],
    output: { destination: 'pvc', name: 'mythos-market', format: 'xlsx', storageSize: '128Mi' },
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

const DUE_DILIGENCE_RECIPE = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'e2e-mythos-dd' },
  spec: {
    contextRef: 'context1',
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        target: { type: 'string', default: 'Anthropic (creator of Claude Mythos)' },
        scope: {
          type: 'string',
          default: 'Mythos model capabilities, safety posture, market position, risks',
        },
      },
    },
    mcpServers: [{ id: 'web-search' }],
    steps: [
      {
        id: 'research-company',
        instruction:
          'Research {{inputs.target}} focusing on: {{inputs.scope}}.\n\n' +
          'Use DuckDuckGo search to investigate: company overview, leadership, funding, ' +
          'Mythos model details, competitive position, and recent announcements.',
        mcpServers: ['web-search'],
        allowedTools: { include: ['web-search__search'] },
        timeoutSeconds: 300,
      },
      {
        id: 'research-risks',
        instruction:
          'Research risks related to {{inputs.target}} and the Mythos model:\n\n' +
          'Investigate: regulatory risks, cybersecurity concerns from the leak, ' +
          'competitive threats, reputation risks, and financial sustainability.',
        mcpServers: ['web-search'],
        allowedTools: { include: ['web-search__search'] },
        timeoutSeconds: 300,
      },
      {
        id: 'synthesize',
        instruction:
          'Synthesize a Due Diligence analysis:\n\n' +
          '=== COMPANY ===\n{{research-company:output}}\n\n' +
          '=== RISKS ===\n{{research-risks:output}}\n\n' +
          'Produce: Executive Summary, Scorecard (1-10), SWOT, Risk Matrix, ' +
          'Bull/Bear case, and Recommendation (Strong Buy/Buy/Hold/Avoid). Use tables.',
        dependsOn: ['research-company', 'research-risks'],
        timeoutSeconds: 240,
      },
      {
        id: 'generate-pdf',
        instruction:
          'You MUST call the clerum__generate_pdf tool.\n\n' +
          'filename: "mythos-due-diligence.pdf"\n' +
          'title: "Due Diligence Report: Anthropic — Mythos Model"\n' +
          'body:\n{{synthesize:output}}',
        allowedTools: { include: ['clerum__generate_pdf'] },
        dependsOn: ['synthesize'],
        timeoutSeconds: 120,
      },
      {
        id: 'generate-excel',
        instruction:
          'You MUST call the clerum__generate_xlsx tool.\n\n' +
          'filename: "mythos-dd-data.xlsx"\n' +
          'Create from:\n{{synthesize:output}}\n\n' +
          'Sheet 1 "Scorecard": Category, Score (1-10), Notes\n' +
          'Sheet 2 "Risk Matrix": Risk, Severity, Likelihood, Mitigation\n' +
          'Sheet 3 "SWOT": Category (S/W/O/T), Item, Impact\n' +
          'Sheet 4 "Funding History": Round, Date, Amount, Key Investors\n' +
          'Sheet 5 "Competitor Comparison": Model, Provider, Capabilities, Pricing',
        allowedTools: { include: ['clerum__generate_xlsx'] },
        dependsOn: ['synthesize'],
        timeoutSeconds: 120,
      },
    ],
    output: { destination: 'pvc', name: 'mythos-dd', format: 'multi', storageSize: '256Mi' },
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

// ── Tests ────────────────────────────────────────────────────────────────

test.describe.serial('GKE Workflow E2E — Mythos Theme', () => {
  test.beforeAll(async () => {
    // Cleanup any leftover recipes from previous runs
    for (const name of [
      'e2e-mythos-agentic',
      'e2e-mythos-competitive',
      'e2e-mythos-market',
      'e2e-mythos-dd',
    ]) {
      await cleanupRecipe(name)
    }
  })

  test('1. Agentic Workflow → PDF report', async ({ page }) => {
    test.setTimeout(WORKFLOW_TIMEOUT + 60_000)
    await login(page)
    await navigateToRecipes(page)
    await installRecipe(page, AGENTIC_RECIPE)
    await waitForWorkflowCompletion(page, 'e2e-mythos-agentic', 3)
    await verifyAndDownloadArtifact(page, 'mythos-research-summary.pdf', 'PDF')
    await closeModal(page)
    console.log('✅ Agentic Workflow (PDF) — PASS')
  })

  test('2. Competitive Intel → PDF report', async ({ page }) => {
    test.setTimeout(WORKFLOW_TIMEOUT + 60_000)
    await login(page)
    await navigateToRecipes(page)
    await installRecipe(page, COMPETITIVE_INTEL_RECIPE)
    await waitForWorkflowCompletion(page, 'e2e-mythos-competitive', 4)
    await verifyAndDownloadArtifact(page, 'mythos-competitive-intel.pdf', 'PDF')
    await closeModal(page)
    console.log('✅ Competitive Intel (PDF) — PASS')
  })

  test('3. Market Dashboard → XLSX report', async ({ page }) => {
    test.setTimeout(WORKFLOW_TIMEOUT + 60_000)
    await login(page)
    await navigateToRecipes(page)
    await installRecipe(page, MARKET_DASHBOARD_RECIPE)
    await waitForWorkflowCompletion(page, 'e2e-mythos-market', 3)
    await verifyAndDownloadArtifact(page, 'mythos-economic-impact.xlsx', 'XLSX')
    await closeModal(page)
    console.log('✅ Market Dashboard (XLSX) — PASS')
  })

  test('4. Due Diligence → PDF + XLSX', async ({ page }) => {
    test.setTimeout(WORKFLOW_TIMEOUT + 60_000)
    await login(page)
    await navigateToRecipes(page)
    await installRecipe(page, DUE_DILIGENCE_RECIPE)
    await waitForWorkflowCompletion(page, 'e2e-mythos-dd', 5)
    await verifyAndDownloadArtifact(page, 'mythos-due-diligence.pdf', 'PDF')
    // Download XLSX too — scope to the artifacts panel via data-testid to
    // avoid strict-mode collisions with the filename appearing in step prose
    // or Raw JSON (same rationale as verifyAndDownloadArtifact above).
    await verifyAndDownloadArtifact(page, 'mythos-dd-data.xlsx', 'XLSX')
    await closeModal(page)
    console.log('✅ Due Diligence (PDF+XLSX) — PASS')
  })

  test.afterAll(async () => {
    // Cleanup all test recipes
    for (const name of [
      'e2e-mythos-agentic',
      'e2e-mythos-competitive',
      'e2e-mythos-market',
      'e2e-mythos-dd',
    ]) {
      await cleanupRecipe(name)
    }
  })
})
