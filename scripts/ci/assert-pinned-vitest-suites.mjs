#!/usr/bin/env node
// Asserts that every pinned test file ran for real in a Vitest JSON report
// (`--reporter=json --outputFile=<report>`): the file is in the report exactly
// once, at least one of its tests passed, and none failed, was skipped, is
// pending or is a todo. A grep of the console output cannot tell these apart:
// a file whose describes are all skipped is still printed by name, and Vitest
// 4.1 even gives that file the status "passed", so the per-test statuses are
// the only signal.
//
// Usage: node scripts/ci/assert-pinned-vitest-suites.mjs <report.json> <file name>...
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Returns one message per violation; an empty array means every pinned file ran. */
export function pinnedSuiteViolations(report, pinned) {
  if (pinned.length === 0) return ['no pinned suites were given']
  if (!Array.isArray(report?.testResults)) return ['the report has no testResults array']
  const violations = []
  for (const suite of pinned) {
    const files = report.testResults.filter(
      file => typeof file.name === 'string' && file.name.endsWith(`/${suite}`)
    )
    if (files.length !== 1) {
      violations.push(`${suite}: expected exactly 1 file in the report, found ${files.length}`)
      continue
    }
    const [file] = files
    const statuses = (file.assertionResults ?? []).map(test => test.status)
    const passed = statuses.filter(status => status === 'passed').length
    const other = statuses.filter(status => status !== 'passed')
    if (file.status !== 'passed') violations.push(`${suite}: file status is ${file.status}`)
    if (passed === 0) violations.push(`${suite}: no test passed`)
    if (other.length > 0) {
      violations.push(
        `${suite}: ${other.length} test(s) did not pass (${[...new Set(other)].join(', ')})`
      )
    }
  }
  return violations
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, ...pinned] = process.argv.slice(2)
  if (!reportPath) {
    console.error('usage: assert-pinned-vitest-suites.mjs <report.json> <file name>...')
    process.exit(2)
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const violations = pinnedSuiteViolations(report, pinned)
  for (const violation of violations) console.error(`pinned suite check: ${violation}`)
  if (violations.length > 0) process.exit(1)
  console.log(`pinned suite check: ${pinned.join(', ')} ran and passed`)
}
