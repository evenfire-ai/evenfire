#!/usr/bin/env node
// Exercise the issue-628 command tracker with a real Playwright timeout.
// All writes and the simulated lease remain inside this temporary directory.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

async function waitFor(file, probe) {
  const expires = Date.now() + 30_000
  while (!existsSync(file)) {
    if (probe?.finished) throw new Error(`Playwright exited before ${path.basename(file)}\n${probe.output}`)
    if (Date.now() >= expires) throw new Error(`Timed out waiting for ${path.basename(file)}`)
    await delay(20)
  }
}

function startProbe(env) {
  const child = spawn(process.execPath, [cli, 'test', '--config', path.join(scratch, 'playwright.config.cjs')], {
    cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000,
  })
  const probe = { finished: false, output: '', result: undefined }
  child.stdout.on('data', data => { probe.output += data })
  child.stderr.on('data', data => { probe.output += data })
  probe.result = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status, signal) => {
      probe.finished = true
      resolve({ status, signal })
    })
  })
  // waitFor observes early runner exit; retain spawn rejection for the await.
  probe.result.catch(() => {})
  return probe
}

try {
  writeFileSync(path.join(scratch, 'playwright.config.cjs'),
    'module.exports = {testDir: __dirname, timeout: 45000, workers: 1, retries: 0, reporter: "line"}\n')
  writeFileSync(path.join(scratch, 'child.sh'), `#!/bin/bash
set -eu
"$NODE_BINARY" "$COORDINATED_CHILD_FILE"
# A command after Node keeps Bash alive to wait for its child.
printf 'waited\\n' >"$BASH_DONE_FILE"
`)
  writeFileSync(path.join(scratch, 'child.mjs'), `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const expires = Date.now() + 20_000
if (!existsSync(process.env.LEASE_FILE)) throw new Error('Test lease is missing before child readiness')
appendFileSync(process.env.WRITES_FILE, 'held\\n')
writeFileSync(process.env.READY_FILE, 'ready')
while (!existsSync(process.env.FINISH_FILE) && Date.now() < expires) {
  const state = existsSync(process.env.LEASE_FILE) ? 'held' : 'released'
  appendFileSync(process.env.WRITES_FILE, state + '\\n')
  if (state === 'released') writeFileSync(process.env.RELEASED_FILE, 'released')
  await delay(20)
}
writeFileSync(process.env.DONE_FILE, existsSync(process.env.FINISH_FILE) ? 'finished' : 'expired')
`)
  writeFileSync(path.join(scratch, 'probe.spec.ts'), `
import { test } from ${JSON.stringify(playwright)}
import { CommandDrain } from ${JSON.stringify(tracker)}
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const commands = new CommandDrain()
async function operation() {
  const inner = [${JSON.stringify(deadline)}, '--timeout-seconds', '25', '--label', 'inner', '--', '/bin/bash', process.env.CHILD_FILE!]
  const args = process.env.NESTED === 'true'
    ? [${JSON.stringify(deadline)}, '--timeout-seconds', '30', '--label', 'outer', '--', process.execPath, ...inner]
    : [process.env.CHILD_FILE!]
  const binary = process.env.NESTED === 'true' ? process.execPath : '/bin/bash'
  const command = commands.run(() => execute(binary, args, { env: process.env, timeout: 35_000 }))
  command.catch(() => {})
  // The driver controls completion; startup speed does not determine whether
  // the timeout happens while a command is actually running.
  const expires = Date.now() + 15_000
  while (!existsSync(process.env.READY_FILE!)) {
    if (Date.now() >= expires) throw new Error('Child did not become ready')
    await delay(20)
  }
  test.setTimeout(1)
  await command
}
test.beforeEach(async () => {
  commands.open()
  if (process.env.TIMEOUT_IN_SETUP === 'true') {
    await operation()
  }
})
test.afterEach(async () => {
  if (process.env.DRAIN !== 'true') {
    writeFileSync(process.env.TEARDOWN_FILE!, 'not-drained')
    return
  }
  const closing = commands.close()
  let settled = false
  closing.then(() => { settled = true })
  let blocked = false
  try {
    await commands.run(async () => { writeFileSync(process.env.EXTRA_FILE!, 'started') })
  } catch (error) {
    blocked = error instanceof Error && error.message === 'Profile command admission is closed'
  }
  if (!blocked) throw new Error('Command admission remained open during teardown')
  writeFileSync(process.env.BLOCKED_FILE!, 'blocked')
  if (settled) throw new Error('Drain completed before the active command finished')
  writeFileSync(process.env.TEARDOWN_FILE!, 'draining')
  await closing
  writeFileSync(process.env.DRAINED_FILE!, 'drained')
})
test('bounded command', async () => {
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
    const probe = startProbe({
      PATH: '/usr/bin:/bin',
      LEASE_FILE: file('lease'), WRITES_FILE: file('writes'), DONE_FILE: file('done'),
      BLOCKED_FILE: file('blocked'), EXTRA_FILE: file('extra'),
      READY_FILE: file('ready'), FINISH_FILE: file('finish'), RELEASED_FILE: file('released'),
      TEARDOWN_FILE: file('teardown'), DRAINED_FILE: file('drained'),
      CHILD_FILE: path.join(scratch, 'child.sh'),
      NODE_BINARY: process.execPath, COORDINATED_CHILD_FILE: path.join(scratch, 'child.mjs'),
      BASH_DONE_FILE: file('bash-done'),
      DRAIN: String(drain), NESTED: String(nested), TIMEOUT_IN_SETUP: String(setup),
    })
    try {
      await waitFor(file('teardown'), probe)
      assert.equal(readFileSync(file('teardown'), 'utf8'), drain ? 'draining' : 'not-drained', `${name}: unexpected teardown state`)
      if (drain) {
        assert.ok(existsSync(file('blocked')), `${name}: command admission was not checked in teardown`)
        assert.ok(!existsSync(file('extra')), `${name}: a new command started during teardown`)
        assert.ok(!existsSync(file('drained')), `${name}: close did not wait for the active command`)
        assert.ok(!existsSync(file('bash-done')), `${name}: Bash did not wait for its child`)
        writeFileSync(file('finish'), 'finish')
      }
      const result = await probe.result
      assert.equal(result.status, 1, `${name}: expected Playwright failure\n${probe.output}`)
      assert.match(probe.output, /Test timeout of 1ms exceeded/, `${name}: expected a genuine Playwright timeout`)
      rmSync(file('lease'))
      if (!drain) {
        // Keep the child running until the broken path has demonstrably
        // written after lease release; no elapsed-time assumption is needed.
        await waitFor(file('released'))
        writeFileSync(file('finish'), 'finish')
      }
      await waitFor(file('done'))
      await waitFor(file('bash-done'))
      assert.equal(readFileSync(file('done'), 'utf8'), 'finished', `${name}: child reached its safety deadline`)
      const released = readFileSync(file('writes'), 'utf8').split('\n').filter(line => line === 'released').length
      if (drain) {
        assert.equal(released, 0, `${name}: command wrote after lease release`)
        assert.ok(existsSync(file('drained')), `${name}: teardown did not finish draining`)
      } else {
        assert.ok(released > 0, `${name}: negative control did not reproduce a write after lease release`)
      }
      process.stdout.write(`PASS: ${name} released-writes=${released}\n`)
    } finally {
      // Even a failed assertion lets the owned finite child finish before
      // removing its files. The runner itself also has a finite deadline.
      writeFileSync(file('finish'), 'finish')
      await probe.result
      if (existsSync(file('ready'))) {
        await waitFor(file('done'))
        await waitFor(file('bash-done'))
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
