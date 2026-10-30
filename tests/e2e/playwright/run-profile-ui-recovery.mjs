import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const config = path.join(scriptDirectory, 'profile-ui-recovery.config.ts')
const playwrightCli = path.join(scriptDirectory, 'node_modules/@playwright/test/cli.js')
const requiredResetErrorCodes = [
  'invalid_password',
  'invalid_invitation',
  'forbidden',
  'expired',
  'not_pending',
  'rate_limited',
  'authority_unavailable',
  'recovery_outcome_unknown',
  'internal_error',
  'unknown_500',
]
const requiredTestTitles = [
  'member accepts the prepared invitation and establishes its own password',
  'accepted admin desktop invitation uses the token fallback without a prior session',
  'reset-only producer rejects an ordinary invitation without creating a session',
  'retries session hydration after committed reset without resubmitting the reset proof',
  'trimmed-too-short password gets password guidance without dispatching a reset',
  ...requiredResetErrorCodes.map(
    errorCode => `real reset route response ${errorCode} reaches Profile UI apiSend`
  ),
]

function assertRequiredCases(output, phase) {
  const missing = requiredTestTitles.filter(title => !output.includes(`› ${title}`))
  if (missing.length > 0) {
    throw new Error(`Profile UI recovery runner ${phase} required cases: ${missing.join('; ')}`)
  }
}

function runPlaywright(args) {
  return spawnSync(process.execPath, [playwrightCli, 'test', '--config', config, ...args], {
    cwd: scriptDirectory,
    encoding: 'utf8',
    env: process.env,
  })
}

const listing = runPlaywright(['--list', '--reporter=line'])
const listingOutput = `${listing.stdout || ''}${listing.stderr || ''}`
process.stdout.write(listingOutput)
if (listing.error) throw listing.error
if (listing.status !== 0) process.exit(listing.status || 1)
if (!listingOutput.includes('reset-session-hydration.spec.ts')) {
  throw new Error('Profile UI recovery runner did not collect the recovery spec')
}
if (!listingOutput.includes('ordinary-invitation-onboarding.spec.ts')) {
  throw new Error('Profile UI recovery runner did not collect ordinary invitation onboarding')
}
assertRequiredCases(listingOutput, 'did not collect')

const run = runPlaywright(['--reporter=line'])
const runOutput = `${run.stdout || ''}${run.stderr || ''}`
process.stdout.write(runOutput)
if (run.error) throw run.error
if (run.status !== 0) process.exit(run.status || 1)
if (!/[1-9]\d* passed/.test(runOutput)) {
  throw new Error('Profile UI recovery runner did not report a passing test')
}
for (const requiredSuite of [
  'reset-session-hydration.spec.ts',
  'ordinary-invitation-onboarding.spec.ts',
]) {
  if (!runOutput.includes(requiredSuite)) {
    throw new Error(`Profile UI recovery runner did not execute ${requiredSuite}`)
  }
}
assertRequiredCases(runOutput, 'did not execute')
if (/\b[1-9]\d* skipped\b/.test(runOutput)) {
  throw new Error('Profile UI recovery runner skipped a required test')
}
