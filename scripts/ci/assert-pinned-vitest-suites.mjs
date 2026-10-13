#!/usr/bin/env node
// Asserts that every pinned test file ran for real in a Vitest JSON report
// (`--reporter=json --outputFile=<report>`): the file is in the report exactly
// once, at least one of its tests passed, and none failed, was skipped, is
// pending or is a todo. A grep of the console output cannot tell these apart:
// a file whose describes are all skipped is still printed by name, and Vitest
// 4.1 even gives that file the status "passed", so the per-test statuses are
// the only signal.
//
// Usage:
//   node scripts/ci/assert-pinned-vitest-suites.mjs <report.json> <file name>...
//   node scripts/ci/assert-pinned-vitest-suites.mjs --cases <report.json> <manifest.json>
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

function caseManifestPins(manifest) {
  const violations = []
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return { pins: [], violations: ['the case manifest is empty or not an array'] }
  }

  const pins = []
  const seen = new Set()
  for (const [index, entry] of manifest.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      violations.push(`case ${index}: entry must be an object`)
      continue
    }
    const suite = entry.suite
    const fullName = entry.fullName
    if (typeof suite !== 'string' || suite.length === 0) {
      violations.push(`case ${index}: suite must be a non-empty string`)
      continue
    }
    if (typeof fullName !== 'string' || fullName.length === 0) {
      violations.push(`case ${index}: fullName must be a non-empty string`)
      continue
    }
    const identity = `${suite}\0${fullName}`
    if (seen.has(identity)) {
      violations.push(`case ${index}: duplicate pin ${suite} :: ${fullName}`)
      continue
    }
    seen.add(identity)
    pins.push({ suite, fullName })
  }
  return { pins, violations }
}

/** Returns one message per violation; an empty array means every pinned case ran. */
export function pinnedCaseViolations(report, manifest) {
  const { pins, violations } = caseManifestPins(manifest)
  if (pins.length === 0) return violations
  if (!Array.isArray(report?.testResults))
    return [...violations, 'the report has no testResults array']

  const suites = [...new Set(pins.map(pin => pin.suite))]
  const suiteViolations = pinnedSuiteViolations(report, suites)
  if (suiteViolations.length > 0) {
    return [...violations, ...suiteViolations.map(violation => `${violation} [pinned cases]`)]
  }

  for (const pin of pins) {
    const [file] = report.testResults.filter(
      file => typeof file.name === 'string' && file.name.endsWith(`/${pin.suite}`)
    )
    const assertions = (file.assertionResults ?? []).filter(test => test.fullName === pin.fullName)
    if (assertions.length !== 1) {
      violations.push(
        `${pin.suite} :: ${pin.fullName}: expected exactly 1 matching case, found ${assertions.length}`
      )
    }
  }
  return violations
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arguments_ = process.argv.slice(2)
  const caseMode = arguments_[0] === '--cases'
  const [reportPath, ...pinned] = caseMode ? arguments_.slice(1) : arguments_
  if (!reportPath) {
    console.error(
      'usage: assert-pinned-vitest-suites.mjs [--cases] <report.json> <file name... | manifest.json>'
    )
    process.exit(2)
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (caseMode && pinned.length !== 1) {
    console.error('case mode requires exactly one manifest path')
    process.exit(2)
  }
  const violations = caseMode
    ? pinnedCaseViolations(report, JSON.parse(readFileSync(pinned[0], 'utf8')))
    : pinnedSuiteViolations(report, pinned)
  const label = caseMode ? 'pinned case check' : 'pinned suite check'
  for (const violation of violations) console.error(`${label}: ${violation}`)
  if (violations.length > 0) process.exit(1)
  console.log(
    caseMode
      ? `pinned case check: ${pinned[0]} ran and passed`
      : `pinned suite check: ${pinned.join(', ')} ran and passed`
  )
}
