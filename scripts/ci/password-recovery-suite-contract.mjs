#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinnedSuiteViolations } from './assert-pinned-vitest-suites.mjs'

export function verifySuiteManifest(root, manifest) {
  const keys = ['version', 'publicPostgres', 'privatePostgres', 'composedContract', 'consumer']
  if (
    !manifest ||
    Object.keys(manifest).sort().join() !== keys.sort().join() ||
    manifest.version !== 1
  )
    throw new Error('Unknown recovery suite manifest schema')
  if (
    !manifest.privatePostgres ||
    Object.keys(manifest.privatePostgres).sort().join() !== 'configured,local'
  )
    throw new Error('Both exact private producer exclusions are required')
  const groups = [
    manifest.publicPostgres,
    Object.values(manifest.privatePostgres),
    manifest.composedContract,
    manifest.consumer,
  ]
  if (groups.some(group => !Array.isArray(group) || !group.length))
    throw new Error('Empty recovery suite lane')
  const entries = groups.flat()
  if (new Set(entries).size !== entries.length) throw new Error('Duplicate recovery suite')
  for (const entry of entries) {
    if (
      typeof entry !== 'string' ||
      !/^(control-api|external-rest-api)\/test\/[A-Za-z0-9./_-]+\.test\.ts$/.test(entry) ||
      entry.includes('..')
    )
      throw new Error('Invalid recovery suite path')
    const path = resolve(root, entry)
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      if (!fstatSync(descriptor).isFile() || !readFileSync(descriptor, 'utf8').trim())
        throw new Error(`Missing or empty recovery suite: ${entry}`)
    } finally {
      closeSync(descriptor)
    }
  }
  function collect(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory()
        ? collect(path)
        : entry.name.includes('realPostgres') && entry.name.endsWith('.test.ts')
          ? [relative(root, path)]
          : []
    })
  }
  const census = collect(resolve(root, 'control-api/test')).sort()
  const expected = [...manifest.publicPostgres, ...Object.values(manifest.privatePostgres)].sort()
  if (census.join('\n') !== expected.join('\n'))
    throw new Error('PostgreSQL suite census differs from exact manifest')
  if (manifest.publicPostgres.some(entry => !entry.includes('realPostgres')))
    throw new Error('Non-PostgreSQL public selection')
  return manifest
}

export function reportViolations(root, manifest, lane, report) {
  if (!['publicPostgres', 'composedContract', 'consumer'].includes(lane))
    return ['Unknown recovery report lane']
  const expected = manifest[lane]
  const violations = pinnedSuiteViolations(
    report,
    expected.map(entry => entry.split('/').slice(1).join('/'))
  )
  if (!report?.success || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0)
    violations.push('Incomplete or failed recovery report')
  if (lane === 'publicPostgres') {
    const actual = (report.testResults || []).map(file => relative(root, file.name)).sort()
    if (actual.join('\n') !== [...expected].sort().join('\n'))
      violations.push('Report physical selection differs from exact public PostgreSQL manifest')
    if (report.numPendingTests !== 0 || report.numTodoTests !== 0)
      violations.push('Required PostgreSQL report contains skipped/todo tests')
    const collected = (report.testResults || []).reduce(
      (sum, file) => sum + (file.assertionResults || []).length,
      0
    )
    if (!collected || report.numTotalTests !== collected || report.numPassedTests !== collected)
      violations.push('Recovery reporter totals are incomplete')
  }
  return violations
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  try {
    const manifest = verifySuiteManifest(
      root,
      JSON.parse(
        readFileSync(resolve(root, 'tests/contracts/password-recovery-suites.json'), 'utf8')
      )
    )
    const [command, lane, path] = process.argv.slice(2)
    if (command === 'verify' && !lane)
      console.log(
        `Recovery suite contract: ${manifest.publicPostgres.length} public PostgreSQL suites; 2 private exclusions`
      )
    else if (command === 'public' && !lane && !path)
      console.log(manifest.publicPostgres.join('\n'))
    else if (command === 'private' && ['local', 'configured', 'all'].includes(lane) && !path)
      console.log(
        (lane === 'all'
          ? Object.values(manifest.privatePostgres)
          : [manifest.privatePostgres[lane]]
        )
          .map(entry => entry.replace(/^control-api\//, ''))
          .join('\n')
      )
    else if (command === 'report' && path) {
      const errors = reportViolations(root, manifest, lane, JSON.parse(readFileSync(path, 'utf8')))
      if (errors.length) throw new Error(errors.join('\n'))
      console.log(`Recovery ${lane} report: complete and passing`)
    } else
      throw new Error(
        'Usage: password-recovery-suite-contract.mjs verify | public | private local/configured/all | report lane report.json'
      )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
