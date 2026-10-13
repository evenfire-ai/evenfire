import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const config = path.join(scriptDirectory, 'profile-ui-recovery.config.ts')
const playwrightCli = path.join(scriptDirectory, 'node_modules/@playwright/test/cli.js')

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
if (!/Total:\s*[1-9]\d* tests?\b/.test(listingOutput)) {
  throw new Error('Profile UI recovery runner collected zero tests')
}

const run = runPlaywright(['--reporter=line'])
const runOutput = `${run.stdout || ''}${run.stderr || ''}`
process.stdout.write(runOutput)
if (run.error) throw run.error
if (run.status !== 0) process.exit(run.status || 1)
if (!/[1-9]\d* passed/.test(runOutput)) {
  throw new Error('Profile UI recovery runner did not report a passing test')
}
