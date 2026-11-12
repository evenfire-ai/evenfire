// Pass/fail verdict for a Playwright JSON report. A run passes only when it
// executed at least one test and none was unexpected, skipped or flaky, so a
// lane whose tests were all skipped or filtered out cannot report PASS.
//
// Usage: node scripts/e2e/playwright-report-gate.mjs <label> <report.json>
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const COUNTERS = ['expected', 'unexpected', 'skipped', 'flaky']

export function playwrightStatsPass(stats) {
  for (const key of COUNTERS) {
    if (!Number.isInteger(stats?.[key])) throw new Error(`report stats.${key} is not an integer`)
  }
  return stats.expected > 0 && stats.unexpected === 0 && stats.skipped === 0 && stats.flaky === 0
}

function main([label, reportPath]) {
  if (!label || !reportPath) throw new Error('usage: playwright-report-gate.mjs <label> <report.json>')
  const { stats } = JSON.parse(readFileSync(reportPath, 'utf8'))
  const pass = playwrightStatsPass(stats)
  console.log(`${label} ${COUNTERS.map(key => `${key}=${stats[key]}`).join(' ')}`)
  return pass ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
