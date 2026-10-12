// E2E_GUARDIAN_IPC_FLOW: standalone native browser/CDP privacy controls;
// the synthetic form has no application HTTP, account, auth or storage flow.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { enterLoginPassword } from '../../desktop-app/test/e2e-playwright/subscriptionPrivateUiInput.mjs'

const filename = fileURLToPath(import.meta.url)
const workspace = process.env.PR806_PRIVACY_CONTROL_WORKSPACE ?? path.resolve(path.dirname(filename), '../..')
const hash = value => createHash('sha256').update(value).digest('hex')
const mode = process.env.PR806_PRIVACY_CONTROL_MODE

if (mode) {
  test(`synthetic private input ${mode}`, { timeout: 20000 }, async () => {
    const require = createRequire(path.join(workspace, 'desktop-app/package.json'))
    const { chromium } = require('playwright')
    const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, timeout: 15000 })
    process.stdout.write('PRIVACY_BROWSER_METADATA:' + JSON.stringify({
      playwright: require('playwright/package.json').version,
      executablePath: fs.realpathSync(chromium.executablePath()), browserVersion: browser.version(),
    }) + '\n')
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(300)
      // Synthetic negative privacy guard entry, not an application terminal route.
      const readOnly = mode === 'old-fill-failure' ? 'readonly' : ''
      await page.goto('data:text/html,' + encodeURIComponent(`<form><label>Password<input id="password-input" type="password" ${readOnly} value="initial-control"></label><button type="button" onclick="document.getElementById('status').textContent='submitted'">Submit</button><output id="status"></output></form>`))
      const sentinel = process.env.PR806_PRIVACY_CONTROL_SENTINEL
      assert.ok(typeof sentinel === 'string' && sentinel.length > 16, 'synthetic control data required')
      if (mode === 'old-fill-failure') {
        // Expected failure: the real Playwright reporter must expose this test-only sentinel.
        await page.locator('#password-input').fill(sentinel)
      } else {
        if (mode === 'safe-insert-failure') {
          // Close the real page after the real Backspace, before native insertion.
          // This fault is confined to the negative synthetic control.
          const press = page.keyboard.press.bind(page.keyboard)
          page.keyboard.press = async key => {
            await press(key)
            if (key === 'Backspace') await page.close()
          }
        }
        await enterLoginPassword(page, sentinel)
        assert.equal(hash(await page.locator('#password-input').inputValue()), hash(sentinel))
        await page.getByRole('button', { name: 'Submit', exact: true }).click()
        assert.equal(await page.locator('#status').textContent(), 'submitted')
      }
    } finally { await browser.close() }
  })
} else {
  test('actual Chromium private input and failure reporter preserve credential privacy', { timeout: 80000 }, () => {
    assert.match(process.version, /^v24\./)
    const sentinel = 'synthetic-ui-privacy-' + randomBytes(16).toString('hex')
    const observations = []
    for (const current of ['old-fill-failure', 'safe-entry-success', 'safe-insert-failure']) {
      const env = Object.fromEntries(['PATH','HOME','TMPDIR','USER','LOGNAME'].filter(key => process.env[key] !== undefined).map(key => [key,process.env[key]]))
      Object.assign(env, { PR806_PRIVACY_CONTROL_WORKSPACE: workspace, PR806_PRIVACY_CONTROL_MODE: current,
        PR806_PRIVACY_CONTROL_SENTINEL: sentinel, NO_COLOR: '1', FORCE_COLOR: '0' })
      const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', filename], {
        env, encoding: 'utf8', timeout: 25000, maxBuffer: 256 * 1024,
      })
      const output = (child.stdout ?? '') + (child.stderr ?? '')
      assert.equal(child.signal, null, 'synthetic browser control must finish without a signal')
      assert.equal(child.status, current === 'safe-entry-success' ? 0 : 1, 'expected control outcome')
      const containsSentinel = output.includes(sentinel)
      assert.equal(containsSentinel, current === 'old-fill-failure', 'reporter plaintext boundary')
      if (current !== 'safe-entry-success') assert.match(output, /not ok 1 - synthetic private input/)
      if (current === 'safe-insert-failure') assert.match(output, /keyboard\.insertText/)
      const metadata = /PRIVACY_BROWSER_METADATA:(\{[^\n]+\})/.exec(output)
      assert.ok(metadata, 'actual browser metadata required')
      const browser = JSON.parse(metadata[1])
      assert.equal(browser.playwright, '1.58.2')
      observations.push({ mode: current, producerExit: child.status, signal: child.signal,
        reporterContainsSyntheticSentinel: containsSentinel, reporterSha256: hash(output), browser })
    }
    if (process.env.PR806_PRIVACY_CONTROL_RECEIPT) {
      fs.writeFileSync(process.env.PR806_PRIVACY_CONTROL_RECEIPT, JSON.stringify({
        kind: 'pr806-private-ui-input-browser-controls.v1', node: process.version,
        control: 'actual-existing-Chromium-with-real-Playwright-reporter', tracing: 'off',
        actualAuthentication: 'NOT_RUN', observations,
      }, null, 2), { mode: 0o600, flag: 'wx' })
    }
  })
}
