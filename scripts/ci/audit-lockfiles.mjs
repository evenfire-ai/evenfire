#!/usr/bin/env node
// Dependency advisory gate for every committed npm lockfile.
//
// Runs `npm audit --package-lock-only --omit=dev` per lockfile (no install) and
// fails on any high/critical advisory affecting production dependencies that is
// not recorded in the reviewed baseline. The baseline only shrinks:
//   - a finding missing from the baseline fails (new advisory or new lockfile);
//   - a baseline entry past its `expires` date fails while it still matches;
//   - a baseline entry that no longer matches fails, so it gets removed.
// See docs/testing/dependency-scanning.md. Lockfile scanners cannot see the
// React copy bundled inside next; check-next-bundled-react.mjs covers that.
//
// Usage:
//   audit-lockfiles.mjs [--baseline <file>] [--lockfile <dir>]... [--today YYYY-MM-DD]
//   audit-lockfiles.mjs --update-baseline --tracking <url> --expires YYYY-MM-DD
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_BASELINE = join(REPO_ROOT, 'scripts', 'ci', 'dependency-audit-baseline.json')
const GATED_SEVERITIES = new Set(['high', 'critical'])
const CONCURRENCY = 6
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i

export function entryKey({ lockfile, advisory, package: pkg }) {
  return `${lockfile}\u0000${advisory}\u0000${pkg}`
}

// Reduce one `npm audit --json` report to gated advisories. Only the advisory
// objects in `via` are findings; string entries there are transitive links to
// another vulnerable package and are reported under that package instead.
export function collectFindings(lockfile, report) {
  if (!report || typeof report !== 'object') throw new Error(`${lockfile}: no audit report`)
  if (report.error) {
    const summary = report.error.summary ?? report.error.code ?? 'unknown error'
    throw new Error(`${lockfile}: npm audit failed: ${summary}`)
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    throw new Error(`${lockfile}: unexpected npm audit report shape`)
  }
  const findings = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || !GATED_SEVERITIES.has(via.severity)) continue
      const advisory = GHSA_RE.exec(via.url ?? '')?.[0] ?? `npm-${via.source}`
      const finding = {
        lockfile,
        advisory,
        package: via.name,
        severity: via.severity,
        title: via.title ?? '',
        url: via.url ?? '',
      }
      findings.set(entryKey(finding), finding)
    }
  }
  return [...findings.values()]
}

export function validateBaseline(baseline) {
  const errors = []
  if (!baseline || !Array.isArray(baseline.entries)) return ['baseline has no "entries" array']
  const seen = new Set()
  for (const [index, entry] of baseline.entries.entries()) {
    const where = `baseline entry ${index} (${entry.lockfile} ${entry.advisory} ${entry.package})`
    for (const field of ['lockfile', 'advisory', 'package', 'severity', 'tracking', 'expires']) {
      if (typeof entry[field] !== 'string' || entry[field] === '')
        errors.push(`${where}: missing ${field}`)
    }
    if (typeof entry.expires === 'string' && !DATE_RE.test(entry.expires)) {
      errors.push(`${where}: expires must be YYYY-MM-DD`)
    }
    const key = entryKey(entry)
    if (seen.has(key)) errors.push(`${where}: duplicate entry`)
    seen.add(key)
  }
  return errors
}

export function evaluate(findings, baseline, today) {
  const accepted = new Map(baseline.entries.map(entry => [entryKey(entry), entry]))
  const found = new Set(findings.map(entryKey))
  const result = { unbaselined: [], expired: [], stale: [], accepted: [] }
  for (const finding of findings) {
    const entry = accepted.get(entryKey(finding))
    if (!entry) result.unbaselined.push(finding)
    else if (entry.expires < today) result.expired.push({ ...finding, ...entry })
    else result.accepted.push({ ...finding, ...entry })
  }
  for (const entry of baseline.entries) {
    if (!found.has(entryKey(entry))) result.stale.push(entry)
  }
  return result
}

// Rewrite the baseline to the current findings, keeping the reviewed metadata
// of entries that still match and stamping new ones with tracking/expires.
export function updatedBaseline(findings, baseline, { tracking, expires }) {
  const previous = new Map((baseline?.entries ?? []).map(entry => [entryKey(entry), entry]))
  const entries = findings.map(finding => {
    const kept = previous.get(entryKey(finding))
    if (!kept && (!tracking || !expires)) {
      throw new Error(
        `new finding ${finding.lockfile} ${finding.advisory} ${finding.package}: --tracking and --expires are required`
      )
    }
    return {
      lockfile: finding.lockfile,
      advisory: finding.advisory,
      package: finding.package,
      severity: finding.severity,
      tracking: kept?.tracking ?? tracking,
      expires: kept?.expires ?? expires,
    }
  })
  entries.sort(
    (a, b) =>
      a.lockfile.localeCompare(b.lockfile) ||
      a.package.localeCompare(b.package) ||
      a.advisory.localeCompare(b.advisory)
  )
  return { ...baseline, entries }
}

export function discoverLockfiles(root = REPO_ROOT) {
  return execFileSync('git', ['ls-files', '--', '*package-lock.json'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(path => path === 'package-lock.json' || path.endsWith('/package-lock.json'))
    .map(path => dirname(path))
    .sort()
}

function auditLockfile(lockfile) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'npm',
      ['audit', '--package-lock-only', '--omit=dev', '--json', '--no-fund', '--no-update-notifier'],
      { cwd: join(REPO_ROOT, lockfile), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      // npm audit exits 1 when it finds anything, so the exit code alone does
      // not separate findings from failures; the JSON body does.
      try {
        resolvePromise(JSON.parse(stdout))
      } catch {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ')
        reject(new Error(`${lockfile}: npm audit exited ${code} without a JSON report: ${tail}`))
      }
    })
  })
}

async function auditAll(lockfiles, audit = auditLockfile) {
  const findings = []
  const errors = []
  const queue = [...lockfiles]
  async function worker() {
    while (queue.length > 0) {
      const lockfile = queue.shift()
      try {
        findings.push(...collectFindings(lockfile, await audit(lockfile)))
      } catch (error) {
        errors.push(error.message)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lockfiles.length) }, worker))
  findings.sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
  return { findings, errors }
}

function row(item, extra = '') {
  return `| \`${item.lockfile}\` | ${item.package} | [${item.advisory}](${item.url || `https://github.com/advisories/${item.advisory}`}) | ${item.severity} | ${extra} |`
}

export function renderSummary(result, { lockfiles, errors, today }) {
  const lines = [
    '## Dependency audit (npm audit, production dependencies, high/critical)',
    '',
    `${lockfiles} lockfiles scanned on ${today}: ${result.unbaselined.length} new, ${result.expired.length} expired, ${result.stale.length} stale baseline entries, ${result.accepted.length} accepted, ${errors.length} audit errors.`,
  ]
  const section = (title, items, extra) => {
    if (items.length === 0) return
    lines.push(
      '',
      `### ${title}`,
      '',
      '| Lockfile | Package | Advisory | Severity | Note |',
      '|---|---|---|---|---|'
    )
    for (const item of items) lines.push(row(item, extra(item)))
  }
  section(
    'New findings (fix, or add a baseline entry with a tracking issue)',
    result.unbaselined,
    i => i.title
  )
  section('Expired baseline entries', result.expired, i => `expired ${i.expires}, ${i.tracking}`)
  section(
    'Stale baseline entries (fixed, remove from the baseline)',
    result.stale,
    () => 'no longer reported'
  )
  if (errors.length > 0) lines.push('', '### Audit errors', '', ...errors.map(e => `- ${e}`))
  section('Accepted (baselined)', result.accepted, i => `until ${i.expires}, ${i.tracking}`)
  return `${lines.join('\n')}\n`
}

function parseArgs(argv) {
  const options = { baseline: DEFAULT_BASELINE, lockfiles: [], today: null, update: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--baseline') options.baseline = resolve(value())
    else if (arg === '--lockfile')
      options.lockfiles.push(value().replace(/\/?package-lock\.json$/, '') || '.')
    else if (arg === '--today') options.today = value()
    else if (arg === '--update-baseline') options.update = true
    else if (arg === '--tracking') options.tracking = value()
    else if (arg === '--expires') options.expires = value()
    else throw new Error(`unknown argument ${arg}`)
  }
  for (const date of [options.today, options.expires]) {
    if (date && !DATE_RE.test(date)) throw new Error(`invalid date ${date}, expected YYYY-MM-DD`)
  }
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`audit-lockfiles: ${error.message}`)
    process.exit(2)
  }
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const baseline = JSON.parse(readFileSync(options.baseline, 'utf8'))
  const baselineErrors = validateBaseline(baseline)
  if (baselineErrors.length > 0) {
    for (const error of baselineErrors) console.error(`audit-lockfiles: ${error}`)
    process.exit(1)
  }
  const lockfiles = options.lockfiles.length > 0 ? options.lockfiles : discoverLockfiles()
  const { findings, errors } = await auditAll(lockfiles)

  if (options.update) {
    if (errors.length > 0) {
      for (const error of errors) console.error(`audit-lockfiles: ${error}`)
      process.exit(1)
    }
    if (options.lockfiles.length > 0) {
      console.error('audit-lockfiles: --update-baseline must scan every lockfile; drop --lockfile')
      process.exit(2)
    }
    const next = updatedBaseline(findings, baseline, options)
    writeFileSync(options.baseline, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`audit-lockfiles: wrote ${next.entries.length} entries to ${options.baseline}`)
    return
  }

  // A partial scan (--lockfile) cannot judge entries for lockfiles it skipped.
  const scoped = new Set(lockfiles)
  const scopedBaseline = { entries: baseline.entries.filter(entry => scoped.has(entry.lockfile)) }
  const result = evaluate(findings, scopedBaseline, today)
  const summary = renderSummary(result, { lockfiles: lockfiles.length, errors, today })
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
  const failed =
    result.unbaselined.length + result.expired.length + result.stale.length + errors.length > 0
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`audit-lockfiles: ${error.stack ?? error.message}`)
    process.exit(1)
  })
}

export { auditAll }
