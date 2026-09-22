import { type Page, expect } from '@playwright/test'

// The Desktop session token lives in the macOS Keychain under the service
// `Evenfire` and the account `session-token::<envKey>`
// (`desktop-app/src/tokenStore.ts`), and `envKey` is derived from the REST and
// RPC origins alone (`desktop-app/src/config.ts:803-823`). Every launch in this
// lane uses the same origins, so every launch resolves the same account, while
// `launchDesktopApp` isolates only `--user-data-dir`, which the Keychain
// ignores. A window closed while signed in therefore hands its session to the
// next launch, and `restoreSavedSessionOnce`
// (`desktop-app/src/appService.ts:1369-1440`) starts that launch authenticated,
// so its login form never mounts. The leak also crosses runs, because the ports
// are stable.
export async function signOutDesktop(desktop: Page): Promise<void> {
  await desktop.getByTestId('nav-settings-menu').click()
  await desktop.getByTestId('logout-btn').click()
  // Logout clears the Keychain account (`desktop-app/src/appService.ts:1919`),
  // and the login form is the witness that it did: the renderer mounts
  // `AuthPage` only when no session remains.
  await expect(desktop.getByLabel('Email', { exact: true })).toBeVisible()
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
      'Desktop launched already signed in: an earlier Electron test left its session in the macOS ' +
        'Keychain (service Evenfire, account session-token::<envKey>) instead of signing out before ' +
        'closing its window.'
    )
  await expect(loginForm).toBeVisible()
}
