import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  auditAll,
  collectFindings,
  evaluate,
  renderSummary,
  updatedBaseline,
  validateBaseline,
} from './audit-lockfiles.mjs'

const BASELINE = fileURLToPath(new URL('./dependency-audit-baseline.json', import.meta.url))
const TRACKING = 'https://example.invalid/issues/1'

function advisory(name, ghsa, severity) {
  return {
    source: 1,
    name,
    dependency: name,
    title: `${name} issue`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: '<9.9.9',
  }
}

const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    'proxy-addr': {
      name: 'proxy-addr',
      severity: 'critical',
      via: [advisory('proxy-addr', 'GHSA-jqcg-44mw-7w3h', 'critical')],
    },
    express: {
      name: 'express',
      severity: 'critical',
      // A transitive link, not an advisory of its own.
      via: ['proxy-addr', 'body-parser'],
    },
    'body-parser': {
      name: 'body-parser',
      severity: 'high',
      via: [
        advisory('body-parser', 'GHSA-27r3-jxmh-p828', 'high'),
        advisory('body-parser', 'GHSA-aaaa-bbbb-cccc', 'moderate'),
      ],
    },
  },
  metadata: {},
}

function entry(lockfile, ghsa, pkg, expires = '2027-02-28') {
  return { lockfile, advisory: ghsa, package: pkg, severity: 'high', tracking: TRACKING, expires }
}

test('collects only high/critical advisory objects, not transitive links', () => {
  const findings = collectFindings('svc', REPORT)
  assert.deepEqual(findings.map(f => [f.package, f.advisory, f.severity]).sort(), [
    ['body-parser', 'GHSA-27r3-jxmh-p828', 'high'],
    ['proxy-addr', 'GHSA-jqcg-44mw-7w3h', 'critical'],
  ])
  assert.ok(findings.every(f => f.lockfile === 'svc'))
})

test('treats npm audit errors and odd reports as failures, not as clean', () => {
  assert.throws(
    () => collectFindings('svc', { error: { code: 'ENOAUDIT', summary: 'boom' } }),
    /boom/
  )
  assert.throws(() => collectFindings('svc', {}), /unexpected/)
  assert.throws(() => collectFindings('svc', null), /no audit report/)
  assert.deepEqual(collectFindings('svc', { vulnerabilities: {} }), [])
})

test('splits findings into accepted, unbaselined, expired and stale', () => {
  const findings = collectFindings('svc', REPORT)
  const baseline = {
    entries: [
      entry('svc', 'GHSA-27r3-jxmh-p828', 'body-parser'),
      entry('svc', 'GHSA-jqcg-44mw-7w3h', 'proxy-addr', '2026-01-01'),
      entry('svc', 'GHSA-gone-gone-gone', 'fixed-pkg'),
    ],
  }
  const result = evaluate(findings, baseline, '2026-11-11')
  assert.deepEqual(
    result.accepted.map(f => f.package),
    ['body-parser']
  )
  assert.deepEqual(
    result.expired.map(f => f.package),
    ['proxy-addr']
  )
  assert.deepEqual(
    result.stale.map(f => f.package),
    ['fixed-pkg']
  )
  assert.deepEqual(result.unbaselined, [])

  const other = evaluate(collectFindings('other-svc', REPORT), baseline, '2026-11-11')
  assert.equal(other.unbaselined.length, 2, 'a baseline entry is scoped to its lockfile')
})

test('an entry stays valid through its expiry day', () => {
  const findings = collectFindings('svc', {
    vulnerabilities: { 'body-parser': REPORT.vulnerabilities['body-parser'] },
  })
  const baseline = { entries: [entry('svc', 'GHSA-27r3-jxmh-p828', 'body-parser', '2026-11-11')] }
  assert.equal(evaluate(findings, baseline, '2026-11-11').accepted.length, 1)
  assert.equal(evaluate(findings, baseline, '2026-11-12').expired.length, 1)
})

test('rejects malformed baselines', () => {
  assert.deepEqual(validateBaseline({}), ['baseline has no "entries" array'])
  const bad = {
    entries: [
      entry('svc', 'GHSA-1', 'a', '28/02/2027'),
      { ...entry('svc', 'GHSA-2', 'b'), tracking: '' },
      entry('svc', 'GHSA-3', 'c'),
      entry('svc', 'GHSA-3', 'c'),
    ],
  }
  const errors = validateBaseline(bad)
  assert.equal(errors.length, 3)
  assert.match(errors.join('\n'), /expires must be YYYY-MM-DD/)
  assert.match(errors.join('\n'), /missing tracking/)
  assert.match(errors.join('\n'), /duplicate/)
})

test('updating the baseline keeps reviewed metadata and requires it for new entries', () => {
  const findings = collectFindings('svc', REPORT)
  const previous = {
    $comment: 'kept',
    entries: [{ ...entry('svc', 'GHSA-27r3-jxmh-p828', 'body-parser'), tracking: 'reviewed' }],
  }
  assert.throws(() => updatedBaseline(findings, previous, {}), /--tracking and --expires/)
  const next = updatedBaseline(findings, previous, { tracking: TRACKING, expires: '2027-01-31' })
  assert.equal(next.$comment, 'kept')
  assert.deepEqual(
    next.entries.map(e => [e.package, e.tracking, e.expires]),
    [
      ['body-parser', 'reviewed', '2027-02-28'],
      ['proxy-addr', TRACKING, '2027-01-31'],
    ]
  )
})

test('auditAll keeps scanning after one lockfile fails and reports the failure', async () => {
  const reports = { a: REPORT, b: { vulnerabilities: {} } }
  const { findings, errors } = await auditAll(['a', 'b', 'c'], async lockfile => {
    if (!(lockfile in reports))
      throw new Error(`${lockfile}: npm audit exited 1 without a JSON report`)
    return reports[lockfile]
  })
  assert.equal(findings.length, 2)
  assert.deepEqual(errors, ['c: npm audit exited 1 without a JSON report'])
})

test('the summary lists what blocks the gate', () => {
  const findings = collectFindings('svc', REPORT)
  const result = evaluate(findings, { entries: [] }, '2026-11-11')
  const summary = renderSummary(result, {
    lockfiles: 1,
    errors: ['x: failed'],
    today: '2026-11-11',
  })
  assert.match(summary, /2 new/)
  assert.match(summary, /GHSA-jqcg-44mw-7w3h/)
  assert.match(summary, /### Audit errors/)
})

test('the committed baseline is valid and every entry is tracked', () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  assert.deepEqual(validateBaseline(baseline), [])
  for (const item of baseline.entries) {
    assert.ok(['high', 'critical'].includes(item.severity), `${item.package} severity`)
    assert.match(item.tracking, /^https:\/\//)
  }
})
