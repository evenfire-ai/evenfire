import {
  GFS_RESOURCE_DEEP_LINK_HOST,
  SANDBOX_UI_DEEP_LINK_HOST,
  SANDBOX_UI_DEEP_LINK_PROTOCOL,
  buildGfsResourceDeepLink,
  buildSandboxUiDeepLink,
  normalizeGfsResourceUri,
  parseGfsResourceDeepLink,
} from '@clerum/desktop-app-links'
import type { DesktopEnvironmentResponse } from '@/app/types/api'

const SCRIPT_NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/

export function isDesktopEnvironmentHandoffEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED === 'true'
}

export function buildDesktopEnvironmentLink(
  environment: DesktopEnvironmentResponse | null | undefined
): string | null {
  if (!isDesktopEnvironmentHandoffEnabled() || !environment?.externalRestApiBaseUrl) return null
  const params = new URLSearchParams({
    externalRestApiBaseUrl: environment.externalRestApiBaseUrl,
    tenantName: environment.appName || 'Evenfire',
  })
  return `evenfire://desktop-environment?${params.toString()}`
}

export function navigateToDesktopApp(
  href: string,
  location: Pick<Location, 'href'> = window.location
): void {
  location.href = href
}

export function buildEvenfireDesktopAppLink(parts: {
  recipeNs: string
  recipeName: string
  path?: string
  teamId?: string
}): string | null {
  try {
    return buildSandboxUiDeepLink(parts)
  } catch {
    return null
  }
}

export function buildEvenfireDesktopGfsResourceLink(uri: string): string | null {
  const canonicalUri = normalizeGfsResourceUri(uri)
  if (!canonicalUri) return null
  try {
    return buildGfsResourceDeepLink(canonicalUri)
  } catch {
    return null
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeScriptNonce(scriptNonce: string): string {
  const nonce = String(scriptNonce || '').trim()
  if (!nonce || nonce.length > 128 || !SCRIPT_NONCE_PATTERN.test(nonce)) {
    throw new Error('Cannot build a desktop app redirect with an invalid script nonce')
  }
  return nonce
}

export function buildEvenfireDesktopAppContentSecurityPolicy(scriptNonce: string): string {
  const nonce = normalizeScriptNonce(scriptNonce)
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  )
}

export function buildEvenfireDesktopAppRedirectDocument(
  deepLink: string,
  scriptNonce: string
): string {
  const parsed = new URL(deepLink)
  if (
    parsed.protocol !== SANDBOX_UI_DEEP_LINK_PROTOCOL ||
    parsed.hostname !== SANDBOX_UI_DEEP_LINK_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Cannot redirect to an invalid desktop app link')
  }

  return buildDesktopHandoffDocument(deepLink, scriptNonce, {
    title: 'Open app in Evenfire',
    description:
      'Evenfire should open this app automatically. Use the button if your browser asks for confirmation.',
  })
}

export function buildEvenfireDesktopGfsResourceRedirectDocument(
  uri: string,
  scriptNonce: string
): string {
  const deepLink = buildEvenfireDesktopGfsResourceLink(uri)
  if (!deepLink || !parseGfsResourceDeepLink(deepLink)) {
    throw new Error('Cannot redirect to an invalid EvenDrive resource link')
  }
  return buildDesktopHandoffDocument(deepLink, scriptNonce, {
    title: 'Open resource in Evenfire',
    description:
      'Evenfire should open this EvenDrive resource automatically. Use the button if your browser asks for confirmation.',
  })
}

function buildDesktopHandoffDocument(
  deepLink: string,
  scriptNonce: string,
  copy: { title: string; description: string }
): string {
  const parsed = new URL(deepLink)
  const isValidAppLink =
    parsed.protocol === SANDBOX_UI_DEEP_LINK_PROTOCOL &&
    parsed.hostname === SANDBOX_UI_DEEP_LINK_HOST &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password
  const isValidResourceLink =
    parsed.protocol === SANDBOX_UI_DEEP_LINK_PROTOCOL &&
    parsed.hostname === GFS_RESOURCE_DEEP_LINK_HOST &&
    Boolean(parseGfsResourceDeepLink(deepLink))
  if (!isValidAppLink && !isValidResourceLink) {
    throw new Error('Cannot redirect to an invalid desktop app link')
  }

  const nonce = normalizeScriptNonce(scriptNonce)
  const escapedLink = escapeHtml(deepLink)
  const scriptLink = JSON.stringify(deepLink).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(copy.title)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      background:
        radial-gradient(980px 520px at 16% 0%, rgba(67, 119, 250, 0.13), transparent 58%),
        radial-gradient(860px 540px at 100% 0%, rgba(195, 212, 253, 0.08), transparent 52%),
        #0e0f10;
      color: #f2f2ef;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .center-page {
      display: grid;
      min-height: 100vh;
      place-items: center;
      padding: 2rem 1rem;
    }
    .page-card {
      display: grid;
      width: min(42rem, 100%);
      gap: 0.95rem;
      padding: 1.25rem 1.35rem;
      border: 1px solid #303338;
      border-radius: 12px;
      background: #141518;
      box-shadow: 0 8px 24px rgba(5, 8, 12, 0.32);
    }
    .stack-tight { display: grid; gap: 0.35rem; }
    .eyebrow {
      margin: 0;
      color: #c6c8cc;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: 2rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .body-copy {
      margin: 0;
      color: #c6c8cc;
      line-height: 1.55;
    }
    .open-button {
      display: inline-flex;
      min-height: 2.35rem;
      width: fit-content;
      align-items: center;
      justify-content: center;
      padding: 0.55rem 1rem;
      border: 1px solid rgba(67, 119, 250, 0.3);
      border-radius: 8px;
      background: linear-gradient(180deg, #6a94ff 0%, #4377fa 100%);
      color: #fff;
      font-size: 0.875rem;
      font-weight: 500;
      text-decoration: none;
      transition: background 0.15s, border-color 0.15s;
    }
    .open-button:hover {
      border-color: rgba(67, 119, 250, 0.44);
      background: linear-gradient(180deg, #4377fa 0%, #6a94ff 100%);
    }
    .open-button:focus-visible {
      outline: 2px solid rgba(67, 119, 250, 0.8);
      outline-offset: 2px;
    }
    @media (max-width: 640px) {
      .center-page { padding: 1rem; }
      h1 { font-size: 1.75rem; }
    }
  </style>
</head>
<body>
  <main class="center-page">
    <section class="page-card">
      <div class="stack-tight">
        <p class="eyebrow">Evenfire Desktop</p>
        <h1>${escapeHtml(copy.title)}</h1>
        <p class="body-copy">${escapeHtml(copy.description)}</p>
      </div>
      <a class="open-button" href="${escapedLink}">Open in Evenfire</a>
      <p class="body-copy">
        If nothing happens, install or update to the latest Evenfire Desktop, then try again.
      </p>
    </section>
  </main>
  <script nonce="${nonce}">window.location.replace(${scriptLink})</script>
</body>
</html>`
}
