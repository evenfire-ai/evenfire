'use strict'

// State persistence: every `out()`/`append()`/`verdict()` writes to
// sessionStorage so the verdict wall survives in-embed navigations
// (clicking #4/#5 sends the page to landing.html and the user comes back
// via a link — without persistence, all prior verdicts and pre-blocks vanish).
// Scope is per-tab: closing/reopening the embed creates a fresh partition
// and clears the storage.

const STORE_PREFIX_OUT = 'out-'
const STORE_PREFIX_VERDICT = 'verdict-'
const STORE_PREFIX_SCROLL = 'scroll-'

function storeOut(name, text) {
  try {
    sessionStorage.setItem(STORE_PREFIX_OUT + name, text)
  } catch {
    // Quota or disabled — best-effort, not load-bearing.
  }
}

function storeVerdict(name, status, label) {
  try {
    sessionStorage.setItem(
      STORE_PREFIX_VERDICT + name,
      JSON.stringify({ status, label: label ?? null })
    )
  } catch {
    // ignore
  }
}

// Helper: write a result line into the card's <pre data-out="...">.
function out(name, value) {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2)
          } catch {
            return String(value)
          }
        })()
  storeOut(name, text)
  applyOut(name, text)
}

// Helper: append rather than replace (so a card with multiple steps shows them all).
function append(name, line) {
  const prev = sessionStorage.getItem(STORE_PREFIX_OUT + name) || ''
  const next = prev ? prev + '\n' + line : line
  storeOut(name, next)
  applyOut(name, next)
}

function applyOut(name, text) {
  const el = document.querySelector(`[data-out="${name}"]`)
  if (!el) return
  el.textContent = text
}

// Stamp the card containing this test with a verdict. `ok` paints green,
// `bad` paints red — the visual signal a person can scan a wall of cards for.
// `manual` clears the verdict (used by tests we can't auto-decide).
function verdict(name, status, label) {
  storeVerdict(name, status, label)
  applyVerdict(name, status, label)
}

function applyVerdict(name, status, label) {
  const card = cardFor(name)
  if (!card) return
  if (status === 'manual') {
    delete card.dataset.status
  } else {
    card.dataset.status = status === 'ok' ? 'ok' : 'bad'
  }
  let chip = card.querySelector('.card-verdict')
  if (!chip) {
    chip = document.createElement('span')
    chip.className = 'card-verdict'
    card.insertBefore(chip, card.firstChild)
  }
  chip.textContent = label ?? (status === 'ok' ? 'PASS' : status === 'bad' ? 'FAIL' : 'MANUAL')
}

function cardFor(name) {
  const out = document.querySelector(`[data-out="${name}"]`)
  if (out) return out.closest('.card')
  const btn = document.querySelector(`button[data-test="${name}"]`)
  return btn ? btn.closest('.card') : null
}

const tests = {
  // ─── ALLOWED ────────────────────────────────────────────────
  async ping() {
    try {
      const r = await fetch('api/ping')
      const body = await r.json()
      out('ping', { status: r.status, body })
      verdict('ping', r.status === 200 ? 'ok' : 'bad')
    } catch (e) {
      out('ping', `Threw: ${e.message}`)
      verdict('ping', 'bad')
    }
  },

  async whoami() {
    try {
      const r = await fetch('api/whoami')
      const body = await r.json()
      // Keep just the headers — full body has `headers`, `method`, `url`.
      out('whoami', body.headers)
      const h = body.headers || {}
      // Expected: rpc-proxy injected both identity headers.
      const ok = Boolean(h['x-clerum-user']) && Boolean(h['x-clerum-recipe'])
      verdict('whoami', ok ? 'ok' : 'bad')
    } catch (e) {
      out('whoami', `Threw: ${e.message}`)
      verdict('whoami', 'bad')
    }
  },

  cookie() {
    const c = document.cookie
    out('cookie', c ? c : '(empty — cookie is HttpOnly)')
    // Expected: the session cookie is HttpOnly so JS can't see it.
    verdict('cookie', !c.includes('clerum_sandbox_ui_session') ? 'ok' : 'bad')
  },

  navInternal() {
    // Navigation will pull the page out from under us; record the
    // intent so the landing-page replay can mark it green.
    sessionStorage.setItem('pending-verdict', 'navInternal')
    location.assign('landing.html')
  },

  redirectInternal() {
    sessionStorage.setItem('pending-verdict', 'redirectInternal')
    location.assign('redirect-internal')
  },

  // ─── EXTERNAL ───────────────────────────────────────────────
  windowOpenSelf() {
    window.open('landing.html', '_blank', 'noopener')
    verdict('windowOpenSelf', 'manual', 'CHECK BROWSER')
  },

  windowOpenExternal() {
    window.open('https://example.com/', '_blank', 'noopener')
    verdict('windowOpenSelf', 'manual', 'CHECK BROWSER')
  },

  async redirectExternal() {
    try {
      // redirect:'manual' would let us see the 302 directly, but the
      // proxy already rewrites to 200. Using default 'follow' to let
      // any same-origin redirect chain finish.
      const r = await fetch('redirect-external', { redirect: 'follow' })
      const location = r.headers.get('location')
      out('redirectExternal', {
        finalStatus: r.status,
        finalUrl: r.url,
        location,
      })
      // Expected: proxy stripped the off-origin Location and coerced to 200.
      verdict('redirectExternal', r.status === 200 && !location ? 'ok' : 'bad')
    } catch (e) {
      out('redirectExternal', `Threw: ${e.message}`)
      verdict('redirectExternal', 'bad')
    }
  },

  // ─── BLOCKED ────────────────────────────────────────────────
  async fetchExternal() {
    try {
      const r = await fetch('https://example.com/api')
      out('fetchExternal', `UNEXPECTED ALLOW — status=${r.status}`)
      verdict('fetchExternal', 'bad')
    } catch (e) {
      out('fetchExternal', `BLOCKED — ${e.message}`)
      verdict('fetchExternal', 'ok')
    }
  },

  remoteImage() {
    const slot = document.querySelector('[data-out="remoteImage"]')
    if (!slot) return
    slot.textContent = ''
    const img = document.createElement('img')
    img.alt = 'remote'
    img.style.maxHeight = '40px'
    img.onerror = () => {
      // out() writes textContent (replacing the img) AND persists.
      out('remoteImage', 'BLOCKED — img onerror fired (CSP img-src violation)')
      verdict('remoteImage', 'ok')
    }
    img.onload = () => {
      out('remoteImage', 'UNEXPECTED ALLOW — image loaded')
      verdict('remoteImage', 'bad')
    }
    img.src = 'https://example.com/x.png'
    slot.appendChild(img)
  },

  cspEval() {
    try {
      // String-arg setTimeout is also blocked by 'self' (no unsafe-eval).
      // Direct eval is the cleanest single-call signal.
      // eslint-disable-next-line no-eval
      const result = (0, eval)('1 + 1')
      out('cspEval', `UNEXPECTED ALLOW — eval returned ${result}`)
      verdict('cspEval', 'bad')
    } catch (e) {
      out('cspEval', `BLOCKED — ${e.message}`)
      verdict('cspEval', 'ok')
    }
  },

  iframeExternal() {
    const slot = document.querySelector('[data-out="iframeExternal"]')
    if (!slot) return
    slot.textContent = ''
    const ifr = document.createElement('iframe')
    ifr.src = 'https://example.com/'
    ifr.style.width = '100%'
    ifr.style.height = '120px'
    ifr.onload = () => {
      // CSP-blocked iframes still fire onload but with about:blank.
      try {
        const inner = ifr.contentDocument
        const blocked = !inner || inner.location.href === 'about:blank'
        // Use out() (replaces textContent + persists) instead of appending
        // — the iframe element itself can't be persisted, but the verdict
        // text is what matters for the test wall.
        out(
          'iframeExternal',
          blocked
            ? 'BLOCKED — iframe stayed on about:blank (CSP frame-src violation)'
            : `UNEXPECTED ALLOW — ${inner.location.href}`
        )
        verdict('iframeExternal', blocked ? 'ok' : 'bad')
      } catch (e) {
        out('iframeExternal', `BLOCKED — cross-origin iframe access denied: ${e.message}`)
        verdict('iframeExternal', 'ok')
      }
    }
    slot.appendChild(ifr)
  },

  async permCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      stream.getTracks().forEach(t => t.stop())
      out('permCamera', 'UNEXPECTED ALLOW — camera stream obtained')
      verdict('permCamera', 'bad')
    } catch (e) {
      out('permCamera', `BLOCKED — ${e.name}: ${e.message}`)
      verdict('permCamera', 'ok')
    }
  },

  permGeo() {
    if (!navigator.geolocation) {
      out('permGeo', 'BLOCKED — navigator.geolocation undefined')
      verdict('permGeo', 'ok')
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        out('permGeo', `UNEXPECTED ALLOW — ${pos.coords.latitude},${pos.coords.longitude}`)
        verdict('permGeo', 'bad')
      },
      err => {
        out('permGeo', `BLOCKED — code=${err.code} ${err.message}`)
        verdict('permGeo', 'ok')
      },
      { timeout: 3000 }
    )
  },

  async permNotify() {
    try {
      const result = await Notification.requestPermission()
      out('permNotify', `Resolved: "${result}"`)
      verdict('permNotify', result === 'denied' ? 'ok' : 'bad')
    } catch (e) {
      out('permNotify', `Threw: ${e.message}`)
      verdict('permNotify', 'bad')
    }
  },

  async pathTraversal() {
    try {
      const r = await fetch('../../../etc/passwd')
      const text = await r.text()
      out('pathTraversal', { status: r.status, snippet: text.slice(0, 120) })
      // The WHATWG URL parser canonicalizes `..` segments before the
      // fetch leaves Chromium, so by the time the request hits rpc-proxy
      // there is no `..` left for normalizeViewPath to reject. The
      // canonicalized URL falls outside the recipe's view/* route and
      // rpc-proxy returns 404 (or upstream returns non-2xx if it ever
      // gets there). Pass criterion is therefore "no 2xx leak" — any
      // non-2xx confirms the boundary held. The proxy-layer rejection
      // path is tested separately by #17 with double-encoding.
      verdict('pathTraversal', !r.ok ? 'ok' : 'bad')
    } catch (e) {
      // A throw is also acceptable — the request was rejected before reaching upstream.
      out('pathTraversal', `Threw: ${e.message}`)
      verdict('pathTraversal', 'ok')
    }
  },

  async pathEncoded() {
    try {
      // DOUBLE-encoded `%252e%252e`. Single-encoded `%2e%2e` would be
      // pre-normalized to `..` by the WHATWG URL parser before the
      // request even leaves Chromium, so the proxy never sees it.
      // Double-encoding ships verbatim; rpc-proxy decodes once to the
      // literal `%2e%2e` and must reject per spec §9.4.
      const target = location.pathname.replace(/[^/]*$/, '%252e%252e/secret')
      const r = await fetch(target)
      out('pathEncoded', { status: r.status })
      verdict('pathEncoded', r.status === 400 ? 'ok' : 'bad')
    } catch (e) {
      out('pathEncoded', `Threw: ${e.message}`)
      verdict('pathEncoded', 'ok')
    }
  },

  websocket() {
    const url = location.origin.replace(/^http/, 'ws') + location.pathname.replace(/[^/]*$/, 'ws')
    let ws
    try {
      ws = new WebSocket(url)
    } catch (e) {
      out('websocket', `Threw on construction: ${e.message}`)
      verdict('websocket', 'ok')
      return
    }
    out('websocket', 'connecting...')
    let settled = false
    ws.onopen = () => {
      append('websocket', 'UNEXPECTED — onopen fired')
      if (!settled) {
        settled = true
        verdict('websocket', 'bad')
      }
    }
    ws.onerror = () => {
      append('websocket', `BLOCKED — onerror fired (proxy 426)`)
      if (!settled) {
        settled = true
        verdict('websocket', 'ok')
      }
    }
    ws.onclose = ev => append('websocket', `closed code=${ev.code} clean=${ev.wasClean}`)
  },

  async download() {
    try {
      const blob = new Blob(['payload'], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'sandbox-ui-test.txt'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      out(
        'download',
        'Click triggered. Check: no save dialog, no file in Downloads. (will-download → preventDefault)'
      )
      // Cannot verify Electron's will-download from inside the embed.
      verdict('download', 'manual', 'CHECK DISK')
    } catch (e) {
      out('download', `Threw: ${e.message}`)
      verdict('download', 'bad')
    }
  },

  async headerSpoof() {
    try {
      const r = await fetch('api/whoami', {
        headers: {
          'X-Clerum-User': 'admin',
          'X-Clerum-Spoof': 'oh-no',
        },
      })
      const body = await r.json()
      const echoed = {}
      for (const k of Object.keys(body.headers || {})) {
        if (k.toLowerCase().startsWith('x-clerum-')) echoed[k] = body.headers[k]
      }
      out('headerSpoof', echoed)
      // Expected: spoof header gone, x-clerum-user is NOT 'admin'.
      const spoofPresent = Object.keys(echoed).some(k => k.toLowerCase() === 'x-clerum-spoof')
      const userIsAdmin = echoed['x-clerum-user'] === 'admin'
      verdict('headerSpoof', !spoofPresent && !userIsAdmin ? 'ok' : 'bad')
    } catch (e) {
      out('headerSpoof', `Threw: ${e.message}`)
      verdict('headerSpoof', 'bad')
    }
  },
}

document.addEventListener('click', e => {
  // Reset-all button — wipe persisted state and reload.
  if (e.target.closest('button[data-action="reset-tests"]')) {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (
        key &&
        (key.startsWith(STORE_PREFIX_OUT) ||
          key.startsWith(STORE_PREFIX_VERDICT) ||
          key.startsWith(STORE_PREFIX_SCROLL))
      ) {
        sessionStorage.removeItem(key)
      }
    }
    sessionStorage.removeItem('pending-verdict')
    location.reload()
    return
  }
  const button = e.target.closest('button[data-test]')
  if (!button) return
  const name = button.getAttribute('data-test')
  const fn = tests[name]
  if (!fn) {
    console.warn('unknown test:', name)
    return
  }
  Promise.resolve(fn()).catch(err => {
    console.error('[test]', name, err)
    verdict(name, 'bad')
  })
})

// Replay persisted state on every page load — including landing.html, so
// arriving there records the in-flight nav verdict that the harness will
// pick up when the user clicks back.
;(function rehydrate() {
  // 1. Land-on-landing-page promotion: clicking #4/#5 stores `pending-verdict`
  //    before navigating. Whichever page that lands on (via in-embed
  //    redirect or direct nav) marks the test green and clears the flag.
  const pending = sessionStorage.getItem('pending-verdict')
  const onLanding = /\/landing\.html$/.test(location.pathname)
  if (pending && onLanding) {
    storeVerdict(pending, 'ok')
    sessionStorage.removeItem('pending-verdict')
  }

  // 2. Apply every persisted verdict and output to the DOM. cardFor() /
  //    [data-out] selectors no-op gracefully on landing.html where the
  //    cards don't exist.
  const apply = () => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (!key) continue
      if (key.startsWith(STORE_PREFIX_OUT)) {
        const name = key.slice(STORE_PREFIX_OUT.length)
        const text = sessionStorage.getItem(key)
        if (text !== null) applyOut(name, text)
      } else if (key.startsWith(STORE_PREFIX_VERDICT)) {
        const name = key.slice(STORE_PREFIX_VERDICT.length)
        const raw = sessionStorage.getItem(key)
        if (!raw) continue
        try {
          const { status, label } = JSON.parse(raw)
          applyVerdict(name, status, label)
        } catch {
          // legacy / corrupt entry — ignore
        }
      }
    }
    // Restore scroll position for THIS path. Outputs were just rehydrated
    // above, so the page is at its final height; an immediate scrollTo
    // wouldn't help because layout still pending — wait for the next frame
    // (covers both DOMContentLoaded and already-loaded entry points).
    const scrollKey = STORE_PREFIX_SCROLL + location.pathname
    const stored = sessionStorage.getItem(scrollKey)
    if (stored !== null) {
      const y = Number(stored)
      if (Number.isFinite(y) && y > 0) {
        // Disable browser auto-scroll-on-reload so it doesn't fight us.
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
        requestAnimationFrame(() => window.scrollTo(0, y))
      }
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true })
  } else {
    apply()
  }

  // 3. Save scroll position continuously (rAF-throttled). Survives any
  //    in-embed navigation away from this path; restored above on the
  //    way back.
  let scrollRaf = 0
  window.addEventListener(
    'scroll',
    () => {
      if (scrollRaf) return
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0
        try {
          sessionStorage.setItem(STORE_PREFIX_SCROLL + location.pathname, String(window.scrollY))
        } catch {
          // ignore
        }
      })
    },
    { passive: true }
  )
})()
