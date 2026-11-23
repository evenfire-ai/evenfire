import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const controlUiStyles = readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8')
const alignmentTolerancePx = 0.5

const identityMarkup = `
  <body class="cu-body">
    <main class="cu-agent-detail-scroll">
      <section class="cu-identity-panel" aria-label="Admin-managed identity files">
        <p class="cu-identity-panel__intro">
          Admin-managed identity files are readable by the agent but blocked from agent writes.
        </p>
        <nav class="cu-tabs cu-tabs--compact cu-identity-tabs"
          aria-label="Identity file sections" role="tablist">
          <button type="button" class="cu-tab" role="tab" data-active="true"
            aria-selected="true">Identity</button>
          <button type="button" class="cu-tab" role="tab" data-active="false"
            aria-selected="false">Soul</button>
          <button type="button" class="cu-tab" role="tab" data-active="false"
            aria-selected="false">Agent instructions</button>
          <button type="button" class="cu-tab" role="tab" data-active="false"
            aria-selected="false">User context</button>
        </nav>
        <div class="cu-identity-section">
          <h3 class="cu-identity-section__title">IDENTITY.md</h3>
          <article class="cu-identity-preview"><h2>Mission</h2><p>Protect identity.</p></article>
        </div>
      </section>
    </main>
  </body>
`

test('Identity notice aligns with the first tab and keeps its spacing', async ({ page }) => {
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page
      .locator('html')
      .evaluate((html, value) => html.setAttribute('data-theme', value), theme)
    const desktopLayout = await readIdentityLayout(page)
    expect(
      Math.abs(desktopLayout.noticeTextLeft - desktopLayout.firstTabTextLeft)
    ).toBeLessThanOrEqual(alignmentTolerancePx)
    expect(Math.abs(desktopLayout.bannerTop - 16)).toBeLessThanOrEqual(alignmentTolerancePx)
    expect(Math.abs(desktopLayout.gap - 24)).toBeLessThanOrEqual(alignmentTolerancePx)

    await page.setViewportSize({ width: 375, height: 812 })
    const mobileLayout = await readIdentityLayout(page)
    expect(
      Math.abs(mobileLayout.noticeTextLeft - mobileLayout.firstTabTextLeft)
    ).toBeLessThanOrEqual(alignmentTolerancePx)
    expect(Math.abs(mobileLayout.bannerTop - 16)).toBeLessThanOrEqual(alignmentTolerancePx)
    expect(Math.abs(mobileLayout.gap - 24)).toBeLessThanOrEqual(alignmentTolerancePx)
    expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.keyboard.press('Tab')
  await expect(tabs.getByRole('tab', { name: 'Identity' })).toBeFocused()
  await expect(tabs.getByRole('tab', { name: 'Identity' })).toHaveCSS('outline-style', 'solid')
})

async function readIdentityLayout(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const notice = document.querySelector('.cu-identity-panel__intro')!
    const nav = document.querySelector('.cu-identity-tabs')!
    const firstTab = nav.querySelector('[role="tab"]')!
    const textLeft = (element: Element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect().left
    }
    const noticeRect = notice.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    return {
      noticeTextLeft: textLeft(notice),
      firstTabTextLeft: textLeft(firstTab),
      bannerTop: noticeRect.top,
      gap: navRect.top - noticeRect.bottom,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
  })
}
