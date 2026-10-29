import { readFileSync, writeFileSync } from 'node:fs'

const [sourcePath] = process.argv.slice(2)
if (!sourcePath) throw new Error('Expected the exact-source ACL verifier path')

const allowedPhases = [
  'load-native-helper',
  'validate-request',
  'inspect-native-object',
  'validate-effective-access',
  'validate-user-data-ancestry',
  'validate-authority-tree',
  'validate-user-data-root',
  'provision-authority-directory',
  'validate-staged-authority',
  'publish-authority-directory-write-through',
  'validate-authority-directory',
  'validate-published-authority-identity',
  'revalidate-user-data-root',
]
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n')
const scriptAnchor = 'const SCRIPT = String.raw`\n'
if (!source.includes(scriptAnchor)) throw new Error('Missing ACL script anchor')

let result = source.replace(
  scriptAnchor,
  `${scriptAnchor}$script:diagnosticPhasePath = [Environment]::GetEnvironmentVariable('PR977_ACL_PHASE_FILE')
$script:diagnosticTimingPath = [Environment]::GetEnvironmentVariable('PR977_ACL_TIMING_FILE')
$script:allowedDiagnosticPhases = @(${allowedPhases.map(value => `'${value}'`).join(', ')})
$script:diagnosticTimer = [Diagnostics.Stopwatch]::StartNew()
$script:lastDiagnosticPhaseMs = 0
function Write-DiagnosticPhase([string]$value) {
  if (-not $script:diagnosticPhasePath) { return }
  if ($value -notin $script:allowedDiagnosticPhases) { throw 'diagnostic-phase-not-allowlisted' }
  $now = $script:diagnosticTimer.ElapsedMilliseconds
  if ($script:diagnosticTimingPath) {
    $elapsed = $now - $script:lastDiagnosticPhaseMs
    [IO.File]::AppendAllText($script:diagnosticTimingPath, ('acl-phase=' + $value + ';elapsed-ms=' + $elapsed + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  }
  $script:lastDiagnosticPhaseMs = $now
  [IO.File]::AppendAllText($script:diagnosticPhasePath, $value + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
`
)

for (const phase of allowedPhases) {
  const assignment = `$script:phase = '${phase}'`
  const escaped = assignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^[ \\t]*)${escaped}([ \\t]*$)`, 'gm')
  const matches = result.match(pattern) ?? []
  if (matches.length === 0) throw new Error(`Missing ACL phase assignment: ${phase}`)
  result = result.replace(
    pattern,
    (_match, indent) => `${indent}${assignment}\n${indent}Write-DiagnosticPhase '${phase}'`
  )
}

const requestEnvAnchor = '[POWERSHELL_REQUEST]: payload,'
if (!result.includes(requestEnvAnchor)) throw new Error('Missing ACL request environment anchor')
result = result.replace(
  requestEnvAnchor,
  `${requestEnvAnchor}\n      PR977_ACL_PHASE_FILE: process.env.PR977_DIAGNOSTIC_PHASE_FILE ?? '',\n      PR977_ACL_TIMING_FILE: process.env.PR977_DIAGNOSTIC_TIMING_FILE ?? '',`
)
result = result.replace(
  "import path from 'node:path'\n",
  "import path from 'node:path'\nimport { appendFileSync } from 'node:fs'\n\nfunction recordAclDuration(value: string): void {\n  const file = process.env.PR977_DIAGNOSTIC_TIMING_FILE\n  if (file) appendFileSync(file, value + '\\n', 'utf8')\n}\n"
)
result = result.replace(
  'const result = spawnSync(powershell, [...POWERSHELL_ARGS], {',
  "const aclStarted = performance.now()\n  recordAclDuration('acl-operation-start')\n  const result = spawnSync(powershell, [...POWERSHELL_ARGS], {"
)
result = result.replace(
  '  })\n  if (result.error || result.status !== 0 || result.signal || !result.stdout) {',
  '  })\n  recordAclDuration(`acl-operation-ms=${Math.round(performance.now() - aclStarted)}`)\n  if (result.error || result.status !== 0 || result.signal || !result.stdout) {'
)
if (!result.includes('acl-operation-ms='))
  throw new Error('Missing ACL operation timing overlay anchor')
writeFileSync(sourcePath, result)
process.stdout.write('Instrumented allowlisted Windows ACL phase markers only.\n')
