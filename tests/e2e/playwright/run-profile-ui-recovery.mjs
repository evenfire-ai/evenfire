import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const config = path.join(scriptDirectory, 'profile-ui-recovery.config.ts')
const playwrightCli = path.join(scriptDirectory, 'node_modules/@playwright/test/cli.js')
const requiredTestTitles = [
  'J1 invitation onboarding ends in guided sign-in and a real login',
  'J2 recovery link clears the logout fence, revokes the prior session, and leads to login',
  'J3 logout returns to login and the previous session is rejected',
  'negative routes show an explicit error and never issue a session',
  'direct access to the authenticated home without login shows the login form',
]
const requiredSpecFiles = [
  'j1-invitation-onboarding.spec.ts',
  'j2-password-recovery.spec.ts',
  'j3-logout.spec.ts',
  'negative-routes.spec.ts',
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
for (const spec of requiredSpecFiles) {
  if (!listingOutput.includes(spec)) {
    throw new Error(`Profile UI recovery runner did not collect ${spec}`)
  }
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
for (const requiredSuite of requiredSpecFiles) {
  if (!runOutput.includes(requiredSuite)) {
    throw new Error(`Profile UI recovery runner did not execute ${requiredSuite}`)
  }
}
assertRequiredCases(runOutput, 'did not execute')
if (/\b[1-9]\d* skipped\b/.test(runOutput)) {
  throw new Error('Profile UI recovery runner skipped a required test')
}
