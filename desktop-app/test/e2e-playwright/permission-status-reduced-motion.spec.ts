import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const rendererStyles = readFileSync(path.resolve(__dirname, '../../ui/src/styles.css'), 'utf8')

test('permission loading remains understandable without spinner motion', async ({ page }) => {
  await page.setContent(`
    <style>${rendererStyles}</style>
    <div class="da-permission-status-slot">
      <span class="da-permission-status-indicator" role="status"
            aria-label="Checking file permissions">
        <span class="da-permission-status-spinner" aria-hidden="true"></span>
      </span>
    </div>
  `)

  const status = page.getByRole('status', { name: 'Checking file permissions' })
  const spinner = page.locator('.da-permission-status-spinner')
  await expect(status).toBeVisible()
  await expect(spinner).toHaveCSS('animation-name', 'da-permission-status-spin')

  await page.emulateMedia({ reducedMotion: 'reduce' })

  await expect(status).toBeVisible()
  await expect(spinner).toHaveCSS('animation-name', 'none')
})
