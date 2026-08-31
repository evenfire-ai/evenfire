import { formatDesktopAppVersionTooltip, useDesktopAppInfo } from '@hooks/useDesktopAppInfo'

/**
 * The brand lockup for pre-authentication cards (sign-in and onboarding).
 *
 * Uses the logotype SVG — one asset carrying the mark and the wordmark
 * together — rather than the square mark beside hand-typed text, matching
 * Control UI's login card and this app's own SidebarNav. Both themes ship as
 * separate files and are toggled by CSS, not by reading the theme in JS, so
 * the correct one is painted on the first frame with no flash.
 *
 * Only the dark variant carries alt text; the light one is aria-hidden, so
 * assistive tech announces "Evenfire" exactly once no matter which is visible.
 */
export function AuthBrand() {
  const desktopAppInfo = useDesktopAppInfo()
  const desktopVersionTooltip = formatDesktopAppVersionTooltip(desktopAppInfo)

  return (
    <div className="auth-brand" title={desktopVersionTooltip}>
      <img
        className="brand-lockup brand-lockup--light"
        src="./logotype-light.svg"
        alt=""
        aria-hidden="true"
      />
      <img className="brand-lockup brand-lockup--dark" src="./logotype-dark.svg" alt="Evenfire" />
    </div>
  )
}
