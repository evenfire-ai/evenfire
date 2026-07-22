const APP_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MAX_APP_SEGMENT_LENGTH = 253
const MAX_APP_ROUTE_LENGTH = 4096
const MAX_TEAM_ID_LENGTH = 255

export function buildEvenfireDesktopAppLink(parts: {
  recipeNs: string
  recipeName: string
  path: string
  teamId?: string
}): string | null {
  const recipeNs = String(parts.recipeNs || '').trim()
  const recipeName = String(parts.recipeName || '').trim()
  const path = String(parts.path || '').trim()
  const teamId = String(parts.teamId || '').trim()
  const validSegment = (value: string) =>
    value.length > 0 && value.length <= MAX_APP_SEGMENT_LENGTH && APP_SEGMENT_PATTERN.test(value)

  if (
    !validSegment(recipeNs) ||
    !validSegment(recipeName) ||
    !path ||
    path.length > MAX_APP_ROUTE_LENGTH ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    (teamId && (teamId.length > MAX_TEAM_ID_LENGTH || !TEAM_ID_PATTERN.test(teamId)))
  ) {
    return null
  }

  const url = new URL(
    `evenfire://app/${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}`
  )
  url.searchParams.set('path', path)
  if (teamId) url.searchParams.set('team', teamId)
  return url.toString()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function desktopAppDisplayName(parsed: URL): string {
  const encodedRecipeName = parsed.pathname.split('/').filter(Boolean)[1]
  if (!encodedRecipeName) return 'this app'

  try {
    const recipeName = decodeURIComponent(encodedRecipeName)
    return recipeName.length <= MAX_APP_SEGMENT_LENGTH && APP_SEGMENT_PATTERN.test(recipeName)
      ? recipeName
      : 'this app'
  } catch {
    return 'this app'
  }
}

export function buildEvenfireDesktopAppRedirectDocument(deepLink: string): string {
  const parsed = new URL(deepLink)
  if (parsed.protocol !== 'evenfire:' || parsed.hostname !== 'app') {
    throw new Error('Cannot redirect to an invalid desktop app link')
  }

  const escapedLink = escapeHtml(deepLink)
  const escapedAppName = escapeHtml(desktopAppDisplayName(parsed))
  const scriptLink = JSON.stringify(deepLink).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${escapedLink}">
  <title>Open ${escapedAppName} in Evenfire</title>
  <style>
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
        <h1>Open ${escapedAppName}</h1>
        <p class="body-copy">
          Evenfire should open this app automatically. Use the button if your browser asks for
          confirmation.
        </p>
      </div>
      <a class="open-button" href="${escapedLink}">Open in Evenfire</a>
      <p class="body-copy">
        If nothing happens, make sure the Evenfire desktop app is installed and try again.
      </p>
    </section>
  </main>
  <script>window.location.replace(${scriptLink})</script>
</body>
</html>`
}
