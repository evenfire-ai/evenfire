/**
 * Static HTML pages served by the sandbox-ui `view/*` reverse proxy when
 * the registry returns a non-success outcome. Renders inside the desktop
 * app's WebContentsView (Chromium); the desktop app picker normally hides
 * recipes that aren't ready, but a stale picker / direct deep-link can land
 * the user here, so we want the message to be self-explanatory.
 *
 * - 410 — recipe gone. Sent when the registry returned `not_found`.
 *   Recipe was deleted, renamed, or never had a `ui:` block.
 * - 503 — recipe updating. Sent when the registry returned `not_ready`
 *   (status.phase != active). The desktop app retries on a visibility-tick;
 *   the page also auto-refreshes every 5 s as a safety net for users who
 *   left the tab open during a rolling deploy.
 *
 * No external assets — pages are fully inlined so they render even when
 * the upstream Service is gone (which is exactly when they fire).
 */

const BASE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #fafafa;
  color: #1f2329;
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  body { background: #1c1f24; color: #e7e9ec; }
}
.card {
  max-width: 28rem;
  padding: 2rem 2.25rem;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.04);
  text-align: center;
}
@media (prefers-color-scheme: dark) {
  .card { background: #262a31; box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 4px 12px rgba(0,0,0,.3); }
}
.glyph { font-size: 2rem; line-height: 1; margin-bottom: 1rem; }
h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
p { margin: .25rem 0; }
.muted { color: #6b7280; font-size: .875rem; }
@media (prefers-color-scheme: dark) {
  .muted { color: #9aa3af; }
}
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: .85em; }
`.trim()

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function shell(title: string, body: string, autoRefreshSec?: number): string {
  const refresh = autoRefreshSec ? `<meta http-equiv="refresh" content="${autoRefreshSec}">` : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${refresh}
  <style>${BASE_STYLE}</style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
</body>
</html>`
}

export function recipeGoneHtml(recipeNs: string, recipeName: string): string {
  const ref = `${recipeNs}/${recipeName}`
  return shell(
    'App removed',
    `
    <div class="glyph" aria-hidden="true">⚠️</div>
    <h1>This app is no longer available</h1>
    <p>The recipe <code>${escapeHtml(ref)}</code> has been removed or no longer
       exposes a sandbox UI.</p>
    <p class="muted">Ask your admin if you expected to find it here.</p>
    `
  )
}

export function recipeUpdatingHtml(recipeNs: string, recipeName: string, reason: string): string {
  const ref = `${recipeNs}/${recipeName}`
  return shell(
    'App updating',
    `
    <div class="glyph" aria-hidden="true">⏳</div>
    <h1>${escapeHtml(ref)} is updating</h1>
    <p>The app's pods are still rolling out. This page will retry shortly.</p>
    <p class="muted">${escapeHtml(reason)}</p>
    `,
    5
  )
}
