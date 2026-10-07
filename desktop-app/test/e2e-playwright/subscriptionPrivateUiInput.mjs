// @ts-check
// E2E_GUARDIAN_IPC_FLOW: enter credentials through the visible login field.
/**
 * Playwright fill() includes its value in progress errors, even with trace off.
 * Native keyboard insertion keeps that value out of the progress call log.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
export async function enterLoginPassword(page, value) {
  await page.locator('#password-input').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(value)
}
