import { type Page, expect, test } from '@playwright/test'

// E2E_GUARDIAN_IPC_FLOW: the Desktop session lives in the main process, so
// sign-out and the pre-teardown capture are observed through Playwright's
// Electron page, never through a renderer HTTP response.
//
// `launchDesktopApp` starts every Desktop dev-isolated in a new run directory,
// so the session token is stored only inside that run's user-data directory
// (`desktop-app/src/tokenStore.ts`, isolated mode: no keytar) and is removed
// with it. A launch can therefore only start signed in if isolation failed.
export async function signOutDesktop(desktop: Page): Promise<void> {
  await desktop.getByTestId('nav-settings-menu').click()
  await desktop.getByTestId('logout-btn').click()
  // The login form is the witness that logout cleared the session: the renderer
  // mounts `AuthPage` only when no session remains.
  await expect(desktop.getByLabel('Email', { exact: true })).toBeVisible()
}

/**
 * Attaches a Desktop screenshot and an aria snapshot of the window to the
 * running test, before the lane tears the app down.
 *
 * A failure screenshot taken after sign-out shows only the login form, which is
 * why run14's model-step failures could not name the window state they found.
 * Password fields expose no value in an aria snapshot and the signed-in address
 * is a fixture one.
 */
export async function attachDesktopBeforeTeardown(desktop: Page): Promise<void> {
  const info = test.info()
  await info.attach('desktop-before-teardown.png', {
    body: await desktop.screenshot(),
    contentType: 'image/png',
  })
  await info.attach('desktop-before-teardown.aria.yml', {
    body: await desktop.locator('body').ariaSnapshot(),
    contentType: 'text/yaml',
  })
}

// A launch that inherits a session is a cleanup failure in an earlier test, not
// a condition to recover from. Signing out here would make the lane pass while
// hiding which test leaked, so this names the cause and fails.
export async function expectSignedOutLaunch(desktop: Page): Promise<void> {
  const loginForm = desktop.getByLabel('Email', { exact: true })
  const signedIn = desktop.getByTestId('nav-settings-menu')
  // Wait for whichever of the two mounts first. The non-retrying read below is
  // only sound once this retrying assertion has settled.
  await expect(loginForm.or(signedIn)).toBeVisible()
  if (await signedIn.isVisible())
    throw new Error(
      'Desktop launched already signed in: a new dev-isolated profile restored a session, so the ' +
        'launch is not isolated from an earlier one.'
    )
  await expect(loginForm).toBeVisible()
}
