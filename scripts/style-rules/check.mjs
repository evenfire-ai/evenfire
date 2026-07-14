/**
 * Core style-rules checker. Reads a list of files, applies rules from
 * `rules.mjs`, and returns / prints violations.
 *
 * Used by:
 *   - run-on-staged.mjs  (pre-commit, only staged files)
 *   - run-all.mjs        (manual / CI, full project tree)
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rulesForFile } from './rules.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * @param {string[]} files - paths relative to repo root
 * @returns {{ errors: number, warnings: number, violations: Array }}
 */
export function checkFiles(files) {
  const violations = []
  let errors = 0
  let warnings = 0

  for (const file of files) {
    const absolute = join(repoRoot, file)
    if (!existsSync(absolute)) continue

    const applicable = rulesForFile(file)
    if (applicable.length === 0) continue

    let content
    try {
      content = readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)

    for (const rule of applicable) {
      const ruleViolations = rule.check({ file, content, lines })
      for (const v of ruleViolations) {
        const severity = v.severityOverride || rule.severity
        if (severity === 'error') errors += 1
        else warnings += 1
        violations.push({
          file,
          line: v.line,
          severity,
          ruleId: rule.id,
          message: v.message,
        })
      }
    }
  }

  return { errors, warnings, violations }
}

/**
 * Pretty-print a result and return the appropriate exit code.
 *
 * @param {ReturnType<typeof checkFiles>} result
 * @param {object} opts
 * @param {boolean} [opts.failOnWarn=false]  Make warnings fail the run.
 */
export function reportAndExitCode(result, opts = {}) {
  const { errors, warnings, violations } = result

  if (violations.length === 0) {
    return 0
  }

  // Sort: errors first, then by file/line.
  const sorted = [...violations].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })

  for (const v of sorted) {
    const tag = v.severity === 'error' ? 'error' : 'warn '
    process.stderr.write(`  [${tag}] ${v.file}:${v.line}  ${v.ruleId}\n`)
    process.stderr.write(`          ${v.message}\n`)
  }

  process.stderr.write(
    `\nstyle-rules: ${errors} error${errors === 1 ? '' : 's'}, ` +
      `${warnings} warning${warnings === 1 ? '' : 's'}\n`
  )

  if (errors > 0) return 1
  if (opts.failOnWarn && warnings > 0) return 1
  return 0
}
