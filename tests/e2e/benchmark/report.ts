#!/usr/bin/env npx tsx
/**
 * Benchmark Report Generator — reads results JSON and produces markdown tables.
 *
 * Usage:
 *   npx tsx tests/e2e/benchmark/report.ts [results-file.json]
 *
 * If no file is provided, reads the most recent file from results/.
 */
import { readFileSync, readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { BenchmarkResult, BenchmarkSummary } from './helpers.js'
import { aggregateByCategory, aggregateByProvider } from './scoring.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = resolve(__dirname, 'results')

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

function loadResults(filepath?: string): BenchmarkSummary {
  if (filepath) {
    return JSON.parse(readFileSync(filepath, 'utf-8'))
  }

  const files = readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith('benchmark-') && f.endsWith('.json'))
    .sort()
    .reverse()

  if (files.length === 0) {
    throw new Error(`No benchmark results found in ${RESULTS_DIR}`)
  }

  const latest = resolve(RESULTS_DIR, files[0])
  console.log(`Loading: ${latest}\n`)
  return JSON.parse(readFileSync(latest, 'utf-8'))
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function generateMarkdown(summary: BenchmarkSummary): string {
  const { results, timestamp, providers } = summary
  const lines: string[] = []

  lines.push('# LLM Provider Benchmark Report')
  lines.push('')
  lines.push(`**Date:** ${timestamp}`)
  lines.push(`**Providers:** ${providers.map(p => `${p.label} (${p.model})`).join(', ')}`)
  lines.push(`**Total tests:** ${results.length}`)
  lines.push('')

  // ---- Overall Summary ----
  lines.push('## Overall Summary')
  lines.push('')

  const provAgg = aggregateByProvider(results)
  lines.push('| Provider | Model | Avg Score | Avg Latency | Pass Rate | Tests |')
  lines.push('|----------|-------|-----------|-------------|-----------|-------|')
  for (const [key, stats] of provAgg) {
    const [prov, model] = key.split('/')
    lines.push(
      `| ${prov} | ${model} | ${stats.avgScore.toFixed(1)} | ${(stats.avgLatency / 1000).toFixed(1)}s | ${(stats.passRate * 100).toFixed(0)}% | ${stats.count} |`
    )
  }
  lines.push('')

  // ---- Category Breakdown ----
  lines.push('## By Category')
  lines.push('')

  const catAgg = aggregateByCategory(results)
  for (const [cat, provMap] of catAgg) {
    lines.push(`### ${formatCategory(cat)}`)
    lines.push('')
    lines.push('| Provider | Avg Score | Avg Latency | Tests |')
    lines.push('|----------|-----------|-------------|-------|')
    for (const [prov, stats] of provMap) {
      lines.push(
        `| ${prov} | ${stats.avgScore.toFixed(1)} | ${(stats.avgLatency / 1000).toFixed(1)}s | ${stats.count} |`
      )
    }
    lines.push('')
  }

  // ---- Detailed Results ----
  lines.push('## Detailed Results')
  lines.push('')

  const providerKeys = [...provAgg.keys()]
  const header =
    '| Test ID | Difficulty | ' +
    providerKeys.map(k => `${k} Score`).join(' | ') +
    ' | ' +
    providerKeys.map(k => `${k} Latency`).join(' | ') +
    ' |'
  const sep =
    '|---------|------------|' +
    providerKeys.map(() => '----------').join('|') +
    '|' +
    providerKeys.map(() => '----------').join('|') +
    '|'

  lines.push(header)
  lines.push(sep)

  const testIds = [...new Set(results.map(r => r.testId))]
  for (const testId of testIds) {
    const first = results.find(r => r.testId === testId)!
    let row = `| ${testId} | ${first.difficulty} |`
    for (const key of providerKeys) {
      const r = results.find(res => res.testId === testId && `${res.provider}/${res.model}` === key)
      row += ` ${r ? (r.success ? r.score.toString() : 'FAIL') : '--'} |`
    }
    for (const key of providerKeys) {
      const r = results.find(res => res.testId === testId && `${res.provider}/${res.model}` === key)
      row += ` ${r ? `${(r.latencyMs / 1000).toFixed(1)}s` : '--'} |`
    }
    lines.push(row)
  }
  lines.push('')

  // ---- Best Provider per Category ----
  lines.push('## Best Provider by Category')
  lines.push('')
  lines.push('| Category | Best Provider | Avg Score |')
  lines.push('|----------|---------------|-----------|')
  for (const [cat, provMap] of catAgg) {
    let best = ''
    let bestScore = 0
    for (const [prov, stats] of provMap) {
      if (stats.avgScore > bestScore) {
        bestScore = stats.avgScore
        best = prov
      }
    }
    lines.push(`| ${formatCategory(cat)} | ${best || 'N/A'} | ${bestScore.toFixed(1)} |`)
  }
  lines.push('')

  return lines.join('\n')
}

function formatCategory(cat: string): string {
  return cat
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const arg = process.argv[2]
const summary = loadResults(arg)
const markdown = generateMarkdown(summary)
console.log(markdown)
