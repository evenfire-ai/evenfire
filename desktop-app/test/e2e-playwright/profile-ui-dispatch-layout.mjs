import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '../..')
const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot) throw new Error('CODEX_SCRATCH_ROOT is required for isolated Electron data')

const taskScratch = path.join(scratchRoot, 'evenfire/pr-1463-r2-m1-r48-20261115')
fs.mkdirSync(taskScratch, { recursive: true })
const fixtureApp = fs.mkdtempSync(path.join(taskScratch, 'electron-layout-app-'))
const userDataDir = path.join(fixtureApp, 'user-data')
fs.mkdirSync(userDataDir)
fs.writeFileSync(
  path.join(fixtureApp, 'package.json'),
  JSON.stringify({ name: 'profile-ui-layout-fixture', version: '1.0.0', main: 'main.cjs' })
)
fs.writeFileSync(
  path.join(fixtureApp, 'main.cjs'),
  "const { app, BrowserWindow } = require('electron'); app.whenReady().then(() => { const window = new BrowserWindow({ width: 1280, height: 800 }); window.loadURL('about:blank') })"
)
const electronApp = await electron.launch({
  args: [`--user-data-dir=${userDataDir}`, fixtureApp],
})

try {
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('load')
  const tokens = fs.readFileSync(path.join(appRoot, 'ui/src/styles/tokens.css'), 'utf8')
  const styles = fs.readFileSync(path.join(appRoot, 'ui/src/styles.css'), 'utf8')
  await page.setContent(`
    <style>${tokens}\n${styles}</style>
    <div class="app-frame">
      <header class="window-titlebar"></header>
      <main class="app-root">
        <div class="app-profile-ui-dispatch-error" role="alert">
          <div class="status-banner tone-error">Profile UI could not be opened in your browser.</div>
        </div>
        <div class="app-shell">
          <aside class="left-nav"></aside>
          <section class="content-panel"><div class="page">Workspace controls remain visible.</div></section>
        </div>
      </main>
    </div>
  `)

  const layout = await page.evaluate(() => {
    const banner = document.querySelector('.app-profile-ui-dispatch-error')
    const panel = document.querySelector('.content-panel')
    if (!banner || !panel) throw new Error('dispatch status or workspace is missing')
    return {
      bannerPosition: getComputedStyle(banner).position,
      panelBottom: panel.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
    }
  })

  assert.ok(layout.panelBottom <= layout.viewportHeight + 1, JSON.stringify(layout))
  assert.ok(layout.documentHeight <= layout.viewportHeight + 1, JSON.stringify(layout))
  assert.ok(layout.bodyHeight <= layout.viewportHeight + 1, JSON.stringify(layout))
  assert.equal(layout.bannerPosition, 'fixed', 'dispatch status must not consume workspace layout')
  process.stdout.write(
    `PASS profile UI dispatch status preserves viewport layout: ${JSON.stringify(layout)}\n`
  )
} finally {
  await electronApp.close()
  fs.rmSync(fixtureApp, { recursive: true })
}
