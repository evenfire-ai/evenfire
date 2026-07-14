/**
 * LLM Provider Benchmark — E2E test suite.
 *
 * Sends identical prompts at 3 difficulty levels to each configured LLM provider,
 * measuring response quality, latency, and tool-use accuracy.
 *
 * The test swaps providers live via Host CRD patches (no pod restart) and collects
 * results as JSON for post-hoc analysis with report.ts.
 *
 * Prerequisites:
 *   1. Minikube running with all services deployed
 *   2. All API keys in mcp-host-keys secret (openai, claude, zai, bailian)
 *   3. Mock MCP server deployed (for MCP tool tests)
 *   4. Run setup: bash tests/e2e/benchmark/setup/configure-benchmark.sh
 *   5. Port-forward: kubectl port-forward -n mcp-host svc/chatllm 8080:8080
 *
 * Run:
 *   cd tests/e2e && npx vitest run benchmark/benchmark.test.ts
 *
 * Filter providers via env:
 *   BENCHMARK_PROVIDERS=openai,claude npx vitest run benchmark/benchmark.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { healthCheck, waitForIdle } from '../helpers.js'
import {
  type BenchmarkResult,
  cleanWorkspace,
  getActiveProviders,
  printSummaryTable,
  runBenchmarkPrompt,
  saveResults,
  switchProvider,
} from './helpers.js'
import { ALL_PROMPTS, type Category } from './prompts.js'
import { scoreAll } from './scoring.js'

// ---------------------------------------------------------------------------
// Configuration — timeouts vary by category complexity
// ---------------------------------------------------------------------------

const CATEGORY_TIMEOUTS: Record<Category, number> = {
  reasoning: 120_000, // 2 min — pure text, no tools
  instruction_following: 120_000, // 2 min — pure text
  tool_single: 300_000, // 5 min — single tool call + rate limit retries
  tool_chain: 420_000, // 7 min — multi-step chains
  mcp_tool: 300_000, // 5 min — MCP tool calls
}

const TIMEOUT_PROVIDER_SWITCH = 30_000

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const allResults: BenchmarkResult[] = []
const providers = getActiveProviders()

// ---------------------------------------------------------------------------
// Pre-flight check
// ---------------------------------------------------------------------------

describe('LLM Provider Benchmark', () => {
  beforeAll(async () => {
    const healthy = await healthCheck()
    if (!healthy) {
      throw new Error(
        'mcp-host is not reachable at http://localhost:8080. ' +
          'Ensure port-forward is active: kubectl port-forward -n mcp-host svc/chatllm 8080:8080'
      )
    }
    await waitForIdle(10_000)
    console.log(
      `\n[Benchmark] Starting benchmark with ${providers.length} providers, ${ALL_PROMPTS.length} prompts each`
    )
    console.log(`[Benchmark] Providers: ${providers.map(p => p.label).join(', ')}`)
    console.log(`[Benchmark] Total test runs: ${providers.length * ALL_PROMPTS.length}\n`)
  }, 30_000)

  // -------------------------------------------------------------------------
  // Per-provider test blocks
  // -------------------------------------------------------------------------

  for (const provider of providers) {
    describe(`Provider: ${provider.label} (${provider.provider}/${provider.model})`, () => {
      beforeAll(async () => {
        await switchProvider(provider)
        cleanWorkspace()
        await waitForIdle(5_000).catch(() => {})
      }, TIMEOUT_PROVIDER_SWITCH)

      for (const category of [
        'reasoning',
        'tool_single',
        'tool_chain',
        'mcp_tool',
        'instruction_following',
      ] as const) {
        const categoryPrompts = ALL_PROMPTS.filter(p => p.category === category)
        const catTimeout = CATEGORY_TIMEOUTS[category]

        describe(`Category: ${category}`, () => {
          for (const prompt of categoryPrompts) {
            it(
              `[${prompt.id}] ${prompt.difficulty}: ${prompt.label}`,
              async () => {
                const result = await runBenchmarkPrompt({
                  prompt: prompt.prompt,
                  testId: prompt.id,
                  category: prompt.category,
                  difficulty: prompt.difficulty,
                  label: prompt.label,
                  provider,
                  timeoutMs: catTimeout - 15_000, // leave buffer for vitest
                })

                allResults.push(result)

                if (result.error) {
                  console.warn(`  [${prompt.id}] Error: ${result.error}`)
                }

                // Record the result regardless, but assert we got a response.
                // Failed assertions still record the result in allResults (push above).
                expect(
                  result.response,
                  `${provider.label} should return a response for ${prompt.id}`
                ).toBeTruthy()
              },
              catTimeout
            )
          }
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Scoring & reporting — runs even if some tests failed
  // -------------------------------------------------------------------------

  afterAll(() => {
    if (allResults.length === 0) {
      console.log('[Benchmark] No results collected')
      return
    }

    // Score all results
    scoreAll(allResults)

    // Save to disk
    const filepath = saveResults(allResults)

    // Print console summary
    printSummaryTable(allResults)

    console.log(`\nGenerate full report with: npx tsx benchmark/report.ts ${filepath}`)
  })
})
