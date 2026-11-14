#!/usr/bin/env node
// Exercise the issue-628 command tracker with a real Playwright timeout.
// All writes and the simulated lease remain inside this temporary directory.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const playwright = path.join(root, 'tests/e2e/playwright/node_modules/@playwright/test')
const cli = path.join(playwright, 'cli.js')
const tracker = path.join(root, 'tests/e2e/playwright/issue-628/command-drain.ts')
const deadline = path.join(root, 'scripts/minikube/run-with-deadline.mjs')
const scratch = mkdtempSync(path.join(tmpdir(), 'issue628-drain-'))

async function waitFor(file) {
  const expires = Date.now() + 10_000
  while (!existsSync(file) && Date.now() < expires) await delay(50)
  if (!existsSync(file)) throw new Error(`Timed out waiting for ${path.basename(file)}`)
}

try {
  writeFileSync(path.join(scratch, 'playwright.config.cjs'),
    'module.exports = {testDir: __dirname, timeout: 10000, workers: 1, retries: 0, reporter: "line"}\n')
  writeFileSync(path.join(scratch, 'child.sh'), `#!/bin/bash
set -eu
for ((i=0; i<100; i++)); do
  if [[ -e "$LEASE_FILE" ]]; then printf 'held\\n' >>"$WRITES_FILE"; else printf 'released\\n' >>"$WRITES_FILE"; fi
  sleep 0.04
done
printf 'done\\n' >"$DONE_FILE"
`)
  writeFileSync(path.join(scratch, 'probe.spec.ts'), `
import { test } from ${JSON.stringify(playwright)}
import { CommandDrain } from ${JSON.stringify(tracker)}
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const commands = new CommandDrain()
async function operation() {
  const inner = [${JSON.stringify(deadline)}, '--timeout-seconds', '15', '--label', 'inner', '--', '/bin/bash', process.env.CHILD_FILE!]
  const args = process.env.NESTED === 'true'
    ? [${JSON.stringify(deadline)}, '--timeout-seconds', '20', '--label', 'outer', '--', process.execPath, ...inner]
    : [process.env.CHILD_FILE!]
  const binary = process.env.NESTED === 'true' ? process.execPath : '/bin/bash'
  await commands.run(() => execute(binary, args, { env: process.env, timeout: 25_000 }))
  try {
    await commands.run(async () => { writeFileSync(process.env.EXTRA_FILE!, 'started') })
  } catch {
    writeFileSync(process.env.BLOCKED_FILE!, 'blocked')
  }
}
test.beforeEach(async () => {
  commands.open()
  if (process.env.TIMEOUT_IN_SETUP === 'true') {
    test.setTimeout(2000)
    await operation()
  }
})
test.afterEach(async () => {
  if (process.env.DRAIN === 'true') await commands.close()
})
test('bounded command', async () => {
  test.setTimeout(2000)
  await operation()
})
`)

  for (const [name, drain, nested, setup] of [
    ['negative-direct', false, false, false],
    ['direct', true, false, false],
    ['nested', true, true, false],
    ['before-each', true, false, true],
  ]) {
    const file = suffix => path.join(scratch, `${name}-${suffix}`)
    writeFileSync(file('lease'), 'held')
    const result = spawnSync(process.execPath, [cli, 'test', '--config', path.join(scratch, 'playwright.config.cjs')], {
      cwd: scratch,
      env: {
        PATH: '/usr/bin:/bin', HOME: scratch,
        LEASE_FILE: file('lease'), WRITES_FILE: file('writes'), DONE_FILE: file('done'),
        BLOCKED_FILE: file('blocked'), EXTRA_FILE: file('extra'),
        CHILD_FILE: path.join(scratch, 'child.sh'),
        DRAIN: String(drain), NESTED: String(nested), TIMEOUT_IN_SETUP: String(setup),
      },
      encoding: 'utf8', timeout: 20_000,
    })
    if (result.status !== 1 || !/Test timeout of 2000ms exceeded/.test(result.stdout + result.stderr)) {
      throw new Error(`${name}: expected Playwright timeout; status=${result.status}\n${result.stdout}\n${result.stderr}`)
    }
    rmSync(file('lease'))
    await waitFor(file('done'))
    const released = readFileSync(file('writes'), 'utf8').split('\n').filter(line => line === 'released').length
    if (drain) {
      if (released || !existsSync(file('blocked')) || existsSync(file('extra'))) {
        throw new Error(`${name}: command outlived lease or admission remained open`)
      }
    } else if (!released) {
      throw new Error(`${name}: negative control did not reproduce an operation after lease release`)
    }
    process.stdout.write(`PASS: ${name} released-writes=${released}\n`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
