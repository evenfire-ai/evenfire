import { type Page, expect, test } from '@playwright/test'
import {
  attachOrAnnotate,
  filterDesktopDiagnostics,
  formatDiagnosticsAttachment,
  redactAriaSnapshot,
} from './desktop-diagnostics.mjs'
import { desktopMainLogLines } from './launch-desktop'

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
 * Attaches the window state a failure needs, before the lane tears the app down:
 *
 * - a screenshot of the window as the failure left it;
 * - an aria snapshot of the window, with every password textbox value replaced
 *   by `[redacted]` (F-SECRET: run16's report carried the fixture password in
 *   clear, because the comment here claimed an aria snapshot hides it);
 * - the Desktop main output filtered to the closed retry-layer pattern set
 *   (MS-1), so a refused Retry names the layer that refused it.
 *
 * Each attachment is guarded on its own: a window that cannot be screenshotted
 * still yields the aria snapshot and the filtered output, and none of them can
 * replace the journey's own error (MS-1 item 4).
 */
async function attachDesktopCapture(desktop: Page): Promise<void> {
  const info = test.info()
  const annotate = (type: string, description: string) => {
    test.info().annotations.push({ type, description })
  }
  await attachOrAnnotate(
    async () => {
      await info.attach('desktop-before-teardown.png', {
        body: await desktop.screenshot(),
        contentType: 'image/png',
      })
    },
    annotate,
    'desktop-before-teardown.png'
  )
  await attachOrAnnotate(
    async () => {
      await info.attach('desktop-before-teardown.aria.yml', {
        body: redactAriaSnapshot(await desktop.locator('body').ariaSnapshot()).yaml,
        contentType: 'text/yaml',
      })
    },
    annotate,
    'desktop-before-teardown.aria.yml'
  )
  await attachOrAnnotate(
    async () => {
      await info.attach('desktop-main-diagnostics.txt', {
        body: formatDiagnosticsAttachment(filterDesktopDiagnostics(desktopMainLogLines())),
        contentType: 'text/plain',
      })
    },
    annotate,
    'desktop-main-diagnostics.txt'
  )
}

export async function attachDesktopBeforeTeardown(desktop: Page): Promise<void> {
  await attachDesktopCapture(desktop)
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
