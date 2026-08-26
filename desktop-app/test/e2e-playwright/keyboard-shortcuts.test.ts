import { expect, test } from './fixtures.js'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('Desktop keyboard commands route through the packaged Electron app', async ({ appPage }) => {
  await appPage.keyboard.press(`${mod}+k`)
  const palette = appPage.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('textbox', { name: 'Search commands' })).toBeFocused()

  const viewport = appPage.viewportSize()
  const paletteBox = await palette.boundingBox()
  expect(viewport).not.toBeNull()
  expect(paletteBox).not.toBeNull()
  expect(Math.abs(paletteBox!.x + paletteBox!.width / 2 - viewport!.width / 2)).toBeLessThan(8)

  await palette.getByRole('textbox', { name: 'Search commands' }).fill('keyboard shortcuts')
  await appPage.keyboard.press('Enter')
  await expect(appPage.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(appPage.getByRole('table', { name: 'Keyboard shortcuts' })).toBeVisible()

  await appPage.keyboard.press(`${mod}+f`)
  await expect(appPage.getByRole('textbox', { name: 'Search' })).toBeFocused()

  await appPage.keyboard.press(`${mod}+t`)
  const chatTabs = appPage.getByRole('toolbar', { name: 'Chat tabs' })
  await expect(chatTabs).toBeVisible()
  await expect(chatTabs.locator('.chat-view-tab')).toHaveCount(2)

  await appPage.keyboard.press(`${mod}+w`)
  await expect(chatTabs.locator('.chat-view-tab')).toHaveCount(1)
})
