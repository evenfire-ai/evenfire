/*
 * Reference guardrail hook — a real `/v1` LLM-lane hook for end-to-end testing
 * of the MCP Host guardrail engine (spec §8.1). Zero-dependency (node:http) so
 * the image builds without npm.
 *
 * It implements every LLM-lane lifecycle point. Routing is path-suffix based:
 * the engine calls `{endpoint}{path}/v1/{point}`, so a single container can back
 * several LlmHook CRs on distinct `spec.path`s (digest-dedup co-location).
 *
 *   POST .../v1/pre_call   -> reject obvious jailbreak / prompt-injection (needs may_deny)
 *   POST .../v1/moderate   -> HTTP 422 on disallowed content, else 200 (needs may_deny)
 *   POST .../v1/post_call  -> redact PII in the model output (needs may_substitute_result)
 *   POST .../v1/on_error   -> supply a text-only fallback (needs may_substitute_result)
 *
 * The wire contract mirrors mcp-host/src/core/guardrails/hooks/remoteLlmHook.ts.
 */
const http = require('node:http')

const PORT = Number(process.env.PORT || 8080)

// --- content rules -------------------------------------------------------

const JAILBREAK = [
  /ignore\s+(all\s+|your\s+)?(previous\s+|prior\s+)?(instructions|rules)/i,
  /disregard\s+(the\s+)?(above|previous|prior)/i,
  /you\s+are\s+(now\s+)?dan\b/i,
  /\bjailbreak\b/i,
  /reveal\s+(your\s+)?(full\s+)?system\s+prompt/i,
  /print\s+(your\s+)?system\s+prompt/i,
  /no\s+(more\s+)?rules\b/i,
]

const DISALLOWED = [
  /\bpipe\s*bomb\b/i,
  /\bbomb\b/i,
  /\bexplosive/i,
  /\bphishing\b/i,
  /\bmalware\b/i,
  /how\s+to\s+(make|build|create|synthesize)\s+.*(bomb|weapon|explosive|meth|nerve\s*agent)/i,
  /impersonat\w*\s+.*bank/i,
]

// PII redactors applied to post_call output content.
const REDACTORS = [
  { re: /\b(?:\d[ -]?){13,16}\b/g, to: '[REDACTED_CARD]' }, // card-ish digit runs
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, to: '[REDACTED_SSN]' },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: '[REDACTED_EMAIL]' },
]

// --- helpers -------------------------------------------------------------

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m && m.role === 'user') {
      return typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    }
  }
  // Fall back to any last message content so moderation still sees something.
  const last = msgs[msgs.length - 1]
  return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : ''
}

function pointFromUrl(url) {
  const path = (url || '').split('?')[0]
  const m = path.match(/\/v1\/([a-z_]+)\/?$/)
  return m ? m[1] : null
}

function send(res, status, obj) {
  const payload = obj === undefined ? '' : JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function log(point, decision, extra) {
  console.log(
    JSON.stringify({ hook: 'reference-guardrail-hook', point, decision, ...(extra || {}) })
  )
}

// --- handlers ------------------------------------------------------------

function handlePreCall(body, res) {
  const text = lastUserText(body)
  const hit = JAILBREAK.find(re => re.test(text))
  if (hit) {
    log('pre_call', 'reject', { pattern: String(hit) })
    return send(res, 200, {
      action: 'reject',
      code: 'jailbreak_blocked',
      message: 'Prompt-injection / jailbreak attempt blocked by the pre_call guardrail.',
    })
  }
  log('pre_call', 'continue')
  return send(res, 200, { action: 'continue' })
}

function handleModerate(body, res) {
  const text = lastUserText(body)
  const hit = DISALLOWED.find(re => re.test(text))
  if (hit) {
    log('moderate', 'block', { pattern: String(hit) })
    // 4xx => the engine maps to a deny (needs may_deny).
    return send(res, 422, {
      code: 'moderation_blocked',
      message: 'Content blocked by the moderation guardrail (illicit / harmful request).',
    })
  }
  log('moderate', 'pass')
  return send(res, 200, {}) // 2xx => pass
}

function handlePostCall(body, res) {
  const original = typeof body?.response?.content === 'string' ? body.response.content : ''
  let redacted = original
  let changed = false
  for (const { re, to } of REDACTORS) {
    if (re.test(redacted)) {
      changed = true
      redacted = redacted.replace(re, to)
    }
  }
  log('post_call', changed ? 'redacted' : 'unchanged')
  // Return the (possibly redacted) content; engine substitutes when may_substitute_result.
  return send(res, 200, { response: { content: redacted } })
}

function handleOnError(_body, res) {
  log('on_error', 'recover')
  return send(res, 200, {
    action: 'recover',
    response: {
      content:
        '⚠️ The model call failed; this fallback response was supplied by the on_error guardrail.',
    },
  })
}

const HANDLERS = {
  pre_call: handlePreCall,
  moderate: handleModerate,
  post_call: handlePostCall,
  on_error: handleOnError,
}

// --- server --------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    // Liveness / readiness.
    return send(res, 200, { ok: true })
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })

  const point = pointFromUrl(req.url)
  const handler = point && HANDLERS[point]
  if (!handler) return send(res, 404, { error: 'unknown_lifecycle_point', url: req.url })

  let raw = ''
  let tooBig = false
  req.on('data', chunk => {
    raw += chunk
    if (raw.length > 5_000_000) {
      tooBig = true
      req.destroy()
    }
  })
  req.on('end', () => {
    if (tooBig) return
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return send(res, 400, { error: 'invalid_json' })
    }
    try {
      handler(body, res)
    } catch (e) {
      console.error('handler_error', e)
      send(res, 500, { error: 'handler_error' })
    }
  })
})

server.listen(PORT, () => {
  console.log(`[reference-guardrail-hook] listening on :${PORT}`)
})
