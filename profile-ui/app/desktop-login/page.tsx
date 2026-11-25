import { DesktopLoginPanel } from '@components/DesktopLoginPanel'

/**
 * `PROFILE_ROUTES.desktopLogin`, which Evenfire Desktop opens as
 * `/desktop-login#challenge=…&state=…`. The values live only in the fragment, which the panel
 * reads in the browser, so this page reads no `searchParams`.
 */
export default function DesktopLoginPage() {
  return <DesktopLoginPanel />
}
