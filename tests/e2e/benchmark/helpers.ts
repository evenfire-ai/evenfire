/**
 * Benchmark test helpers — provider switching, result collection, and utilities.
 *
 * Reuses shared helpers from the parent e2e directory and adds benchmark-specific
 * functionality for live provider swapping via Host CRD patches.
 */
import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import {
  MCP_HOST_URL,
  fetchJson,
  getPodLogs,
  getStatus,
  getTaskResult,
  kubectl,
  sendMessage,
  sleep,
  waitForIdle,
} from '../helpers.js'
import type { Category, Difficulty } from './prompts.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  provider: 'openai' | 'claude' | 'zai' | 'bailian'
  model: string
  label: string
}

export interface BenchmarkResult {
  provider: string
  model: string
  testId: string
  category: Category
  difficulty: Difficulty
  prompt: string
  label: string
  response: string | null
  latencyMs: number
  toolCallCount: number
  score: number
  success: boolean
  error?: string
}

export interface BenchmarkSummary {
  timestamp: string
  providers: ProviderConfig[]
  totalTests: number
  results: BenchmarkResult[]
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

export const PROVIDERS: ProviderConfig[] = [
  { provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' },
  {
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4',
  },
  { provider: 'zai', model: 'glm-5', label: 'GLM-5 (ZAI)' },
  {
    provider: 'bailian',
    model: 'qwen3-coder-plus',
    label: 'Qwen3 Coder+ (Bailian)',
  },
]

/** Allow filtering providers via env var (comma-separated). */
export function getActiveProviders(): ProviderConfig[] {
  const filter = process.env.BENCHMARK_PROVIDERS
  if (!filter) return PROVIDERS
  const names = filter.split(',').map(s => s.trim().toLowerCase())
  return PROVIDERS.filter(p => names.includes(p.provider))
}

// ---------------------------------------------------------------------------
// Host CRD: provider namespace
// ---------------------------------------------------------------------------

const HOST_CRD_NAME = 'chatllm'
const HOST_CRD_NAMESPACE = process.env.HOST_CRD_NAMESPACE || 'mcp-host'

// ---------------------------------------------------------------------------
// Provider switching
// ---------------------------------------------------------------------------

/**
 * Patch the Host CRD to switch LLM provider and model.
 * The mcp-host HostWatcher will detect the change and call initializeProvider.
 * We verify by checking logs for the provider initialization message.
 */
export async function switchProvider(cfg: ProviderConfig): Promise<void> {
  console.log(`\n[Benchmark] Switching to ${cfg.label} (${cfg.provider}/${cfg.model})...`)

  // Patch Host CRD
  kubectl(
    `patch host ${HOST_CRD_NAME} -n ${HOST_CRD_NAMESPACE} --type=merge ` +
      `-p '{"spec":{"model":{"provider":"${cfg.provider}","name":"${cfg.model}"}}}'`
  )

  // Wait for mcp-host to detect the change and reinitialize
  const maxWaitMs = 15_000
  const start = Date.now()
  let detected = false

  while (Date.now() - start < maxWaitMs) {
    await sleep(2000)
    try {
      const logs = getPodLogs('mcp-host', 'mcp-host', 20)
      if (
        logs.includes('Host configuration changed') ||
        logs.includes(`provider: ${cfg.provider}`) ||
        logs.includes(`Using ${cfg.provider}`)
      ) {
        detected = true
        break
      }
    } catch {
      // Pod logs might not be available immediately
    }
  }

  if (!detected) {
    console.warn(
      `[Benchmark] Warning: Could not confirm provider switch in logs (proceeding anyway)`
    )
  }

  // Verify health
  await waitForIdle(10_000).catch(() => {})
  console.log(`[Benchmark] Provider switched to ${cfg.label}`)
}

// ---------------------------------------------------------------------------
// Workspace cleanup
// ---------------------------------------------------------------------------

/**
 * Clean the /workspace/benchmark/ directory inside the mcp-host pod
 * to prevent file artifacts from previous tests affecting results.
 */
export function cleanWorkspace(): void {
  try {
    const pod = kubectl(
      "get pods -n mcp-host -l app=mcp-host -o jsonpath='{.items[0].metadata.name}'"
    )
    kubectl(
      `exec ${pod} -n mcp-host -- sh -c "rm -rf /workspace/benchmark/* 2>/dev/null; mkdir -p /workspace/benchmark"`
    )
    console.log('[Benchmark] Workspace cleaned')
  } catch (e) {
    console.warn('[Benchmark] Workspace cleanup failed:', e)
  }
}

// ---------------------------------------------------------------------------
// Run a single benchmark prompt
// ---------------------------------------------------------------------------

/** Auto-incrementing counter for unique userIds per benchmark call. */
let benchCounter = 0

/**
 * Delay between tests to avoid rate limiting (configurable via env).
 * Default: 8 seconds — enough for most providers' TPM limits.
 */
const INTER_TEST_DELAY_MS = parseInt(process.env.BENCHMARK_DELAY_MS ?? '8000', 10)

/**
 * Send a prompt to the agent, wait for completion, and return timing + result.
 *
 * Response retrieval strategy:
 *   1. If the /message response includes the response inline → use it
 *   2. Otherwise wait for idle, then poll /task/:id/result
 *   3. As fallback, check /status for last completed task info
 */
export async function runBenchmarkPrompt(opts: {
  prompt: string
  testId: string
  category: Category
  difficulty: Difficulty
  label: string
  provider: ProviderConfig
  timeoutMs?: number
}): Promise<BenchmarkResult> {
  benchCounter++
  const userId = `bench-${opts.provider.provider}-${opts.testId}-${benchCounter}`
  const timeout = opts.timeoutMs ?? 180_000

  // Rate-limit protection: wait between tests
  if (benchCounter > 1) {
    await sleep(INTER_TEST_DELAY_MS)
  }

  const startTime = Date.now()

  try {
    // Get initial tool call count
    const statusBefore = await getStatus()
    const toolsBefore = statusBefore.agent?.totalToolCalls ?? 0

    // Send message
    const res = await sendMessage(opts.prompt, { userId })

    let response: string | null = null
    const taskId: string | undefined = res.data?.taskId

    if (res.data.success && res.data.response) {
      // Agent completed within HTTP timeout — response is inline
      response = res.data.response
      await waitForIdle(10_000).catch(() => {})
    } else {
      // Wait for agent to finish processing
      await waitForIdle(timeout)

      // Strategy 1: poll /task/:id/result if we have a taskId
      if (taskId) {
        try {
          const taskRes = await getTaskResult(taskId, 15_000)
          response = taskRes.data?.response ?? null
        } catch {
          // Task result endpoint might not have the response
        }
      }

      // Strategy 2: if still no response, try fetching status for last result
      if (!response) {
        try {
          const statusNow = await getStatus()
          if (statusNow.lastTaskResult?.response) {
            response = statusNow.lastTaskResult.response
          }
        } catch {
          // Ignore
        }
      }
    }

    const endTime = Date.now()

    // Get tool call count after
    const statusAfter = await getStatus()
    const toolsAfter = statusAfter.agent?.totalToolCalls ?? 0
    const toolCallCount = toolsAfter - toolsBefore

    return {
      provider: opts.provider.provider,
      model: opts.provider.model,
      testId: opts.testId,
      category: opts.category,
      difficulty: opts.difficulty,
      prompt: opts.prompt,
      label: opts.label,
      response,
      latencyMs: endTime - startTime,
      toolCallCount: Math.max(0, toolCallCount),
      score: 0, // Scored later by scoring.ts
      success: !!response,
    }
  } catch (error) {
    const endTime = Date.now()
    return {
      provider: opts.provider.provider,
      model: opts.provider.model,
      testId: opts.testId,
      category: opts.category,
      difficulty: opts.difficulty,
      prompt: opts.prompt,
      label: opts.label,
      response: null,
      latencyMs: endTime - startTime,
      toolCallCount: 0,
      score: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ---------------------------------------------------------------------------
// Results persistence
// ---------------------------------------------------------------------------

const RESULTS_DIR = new URL('./results/', import.meta.url).pathname

/**
 * Save benchmark results to a timestamped JSON file.
 */
export function saveResults(results: BenchmarkResult[]): string {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true })
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `benchmark-${ts}.json`
  const filepath = `${RESULTS_DIR}${filename}`

  const summary: BenchmarkSummary = {
    timestamp: new Date().toISOString(),
    providers: getActiveProviders(),
    totalTests: results.length,
    results,
  }

  writeFileSync(filepath, JSON.stringify(summary, null, 2))
  console.log(`\n[Benchmark] Results saved to ${filepath}`)
  return filepath
}

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

/**
 * Print a summary table to the console.
 */
export function printSummaryTable(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(120))
  console.log('LLM PROVIDER BENCHMARK RESULTS')
  console.log('='.repeat(120))

  // Group by provider
  const byProvider = new Map<string, BenchmarkResult[]>()
  for (const r of results) {
    const key = `${r.provider}/${r.model}`
    if (!byProvider.has(key)) byProvider.set(key, [])
    byProvider.get(key)!.push(r)
  }

  // Header
  console.log(
    padRight('Test ID', 12) +
      padRight('Category', 22) +
      padRight('Difficulty', 12) +
      [...byProvider.keys()].map(k => padRight(k, 28)).join('')
  )
  console.log('-'.repeat(120))

  // Collect all test IDs
  const testIds = [...new Set(results.map(r => r.testId))]

  for (const testId of testIds) {
    const first = results.find(r => r.testId === testId)!
    let line = padRight(testId, 12) + padRight(first.category, 22) + padRight(first.difficulty, 12)

    for (const [, provResults] of byProvider) {
      const r = provResults.find(pr => pr.testId === testId)
      if (r) {
        const status = r.success ? `${r.score}/100` : 'FAIL'
        const latency = `${(r.latencyMs / 1000).toFixed(1)}s`
        line += padRight(`${status} (${latency}, ${r.toolCallCount}t)`, 28)
      } else {
        line += padRight('--', 28)
      }
    }
    console.log(line)
  }

  console.log('-'.repeat(120))

  // Provider averages
  console.log('\nProvider Averages:')
  for (const [key, provResults] of byProvider) {
    const scored = provResults.filter(r => r.success)
    const avgScore = scored.length > 0 ? scored.reduce((s, r) => s + r.score, 0) / scored.length : 0
    const avgLatency =
      scored.length > 0 ? scored.reduce((s, r) => s + r.latencyMs, 0) / scored.length / 1000 : 0
    const passRate =
      provResults.length > 0 ? ((scored.length / provResults.length) * 100).toFixed(0) : '0'
    console.log(
      `  ${key}: avg score=${avgScore.toFixed(1)}, avg latency=${avgLatency.toFixed(1)}s, pass rate=${passRate}%`
    )
  }

  // Category breakdown
  console.log('\nBest Provider by Category:')
  const categories = [...new Set(results.map(r => r.category))]
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat && r.success)
    const byProv = new Map<string, number[]>()
    for (const r of catResults) {
      const key = `${r.provider}/${r.model}`
      if (!byProv.has(key)) byProv.set(key, [])
      byProv.get(key)!.push(r.score)
    }
    let best = ''
    let bestAvg = 0
    for (const [key, scores] of byProv) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length
      if (avg > bestAvg) {
        bestAvg = avg
        best = key
      }
    }
    console.log(`  ${cat}: ${best || 'N/A'} (avg ${bestAvg.toFixed(1)})`)
  }

  console.log('='.repeat(120))
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}
