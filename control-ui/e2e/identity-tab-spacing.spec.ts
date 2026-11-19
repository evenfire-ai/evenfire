import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const controlUiStyles = readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8')

const identityMarkup = `
  <body class="cu-body">
    <main class="cu-agent-detail-scroll">
      <section class="cu-identity-panel" aria-label="Admin-managed identity files">
        <p class="cu-identity-panel__intro">
          Admin-managed identity files are readable by the agent but blocked from agent writes.
        </p>
        <nav class="cu-tabs cu-tabs--compact cu-identity-tabs"
          aria-label="Identity file sections" role="tablist">
          <button class="cu-tab" role="tab" aria-selected="true">Identity</button>
          <button class="cu-tab" role="tab" aria-selected="false">Soul</button>
          <button class="cu-tab" role="tab" aria-selected="false">Agent instructions</button>
          <button class="cu-tab" role="tab" aria-selected="false">User context</button>
        </nav>
        <div class="cu-identity-section">
          <h3 class="cu-identity-section__title">IDENTITY.md</h3>
          <article class="cu-identity-preview"><h2>Mission</h2><p>Protect identity.</p></article>
        </div>
      </section>
    </main>
  </body>
`

test('Identity notice keeps space before tabs across themes and narrow viewports', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.setContent(`<style>${controlUiStyles}</style>${identityMarkup}`)

  const notice = page.getByText(
    'Admin-managed identity files are readable by the agent but blocked from agent writes.',
    { exact: true }
  )
  const tabs = page.getByRole('tablist', { name: 'Identity file sections' })
  await expect(notice).toBeVisible()
  await expect(tabs.getByRole('tab')).toHaveText([
    'Identity',
    'Soul',
    'Agent instructions',
    'User context',
  ])

  for (const theme of ['dark', 'light']) {
    await page
      .locator('html')
      .evaluate((html, value) => html.setAttribute('data-theme', value), theme)
    const desktopGap = await page.evaluate(() => {
      const banner = document.querySelector('.cu-identity-panel__intro')!.getBoundingClientRect()
      const nav = document.querySelector('.cu-identity-tabs')!.getBoundingClientRect()
      return { gap: nav.top - banner.bottom, bannerTop: banner.top }
    })
    expect(desktopGap.gap).toBeGreaterThanOrEqual(24)
    expect(desktopGap.bannerTop).toBe(16)
  }

  await page.setViewportSize({ width: 375, height: 812 })
  const mobileLayout = await page.evaluate(() => {
    const banner = document.querySelector('.cu-identity-panel__intro')!.getBoundingClientRect()
    const nav = document.querySelector('.cu-identity-tabs')!.getBoundingClientRect()
    return {
      documentWidth: document.documentElement.scrollWidth,
      gap: nav.top - banner.bottom,
      bannerTop: banner.top,
      viewportWidth: window.innerWidth,
    }
  })
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth)
  expect(mobileLayout.gap).toBeGreaterThanOrEqual(24)
  expect(mobileLayout.bannerTop).toBe(16)

  await page.keyboard.press('Tab')
  await expect(tabs.getByRole('tab', { name: 'Identity' })).toBeFocused()
  await expect(tabs.getByRole('tab', { name: 'Identity' })).toHaveCSS('outline-style', 'solid')
})
