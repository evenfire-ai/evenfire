// Deterministic E2E plugin workload for the Plugin Workload SDK.
//
// Reads the recipe-injected env (PLUGIN_WORKLOAD_SDK_ENDPOINT +
// PLUGIN_WORKLOAD_SDK_TOKEN), exercises promptBridge and clientNotifications,
// then validates idempotency replay and quota enforcement.
// Prints structured RESULT lines the E2E gate greps for, then stays alive
// so the gate can inspect the pod. Node 24 provides a global fetch — this
// image has zero npm dependencies on purpose (reproducible).
//
// Markers the gate asserts on:
//   E2E_SDK_PROMPT_BRIDGE_OK=<invocationId>
//   E2E_SDK_PROMPT_BRIDGE_FAIL=<code>
//   E2E_SDK_CLIENT_NOTIFICATION_OK=<notificationId>
//   E2E_SDK_CLIENT_NOTIFICATION_FAIL=<code>
//   E2E_SDK_IDEMPOTENCY_REPLAY_GUARDED          (replay is rejected without a second provider call)
//   E2E_SDK_EXPLICIT_TARGET_OK=<invocationId>   (approved targetRef was served)
//   E2E_SDK_IDEMPOTENCY_FAIL=<reason>
//   E2E_SDK_QUOTA_EXCEEDED_OK                    (N+1 call correctly rejected)
//   E2E_SDK_QUOTA_EXCEEDED_FAIL=<reason>
//   E2E_SDK_DONE

const http = require('node:http')

const ENDPOINT = process.env.PLUGIN_WORKLOAD_SDK_ENDPOINT || ''
const TOKEN = process.env.PLUGIN_WORKLOAD_SDK_TOKEN || ''
const CALLER_REF = process.env.E2E_SDK_CALLER_REF || 'sdk-caller'
const EVENT_TYPE = process.env.E2E_SDK_EVENT_TYPE || 'e2e.test.notification'
const USER_REF = process.env.E2E_SDK_USER_REF || 'e2e-test-user'
const RUN_ID = process.env.E2E_SDK_RUN_ID || String(Date.now())
const QUOTA_LIMIT = parseInt(process.env.E2E_SDK_QUOTA_LIMIT || '4', 10)
const EXPLICIT_TARGET_REF = process.env.E2E_SDK_EXPLICIT_TARGET_REF || ''
// Every SDK request must fail closed if the server stops responding.  The
// outer shell gate also has bounded polling, but fetch itself otherwise has no
// implicit deadline and could keep a fixture alive indefinitely.
const SDK_REQUEST_TIMEOUT_MS = 15_000

/** Tracks the invocationId from the first promptBridge call for idempotency check. */
let firstPromptBridgeId = null

function log(line) {
  process.stdout.write(`${line}\n`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function callSdk(path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'x-clerum-caller-ref': CALLER_REF,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SDK_REQUEST_TIMEOUT_MS),
  })
  let parsed = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

async function exercisePromptBridge() {
  // Two distinct cold-start races are retryable here, and a real plugin workload
  // would survive both rather than fail on a cold start:
  //   1. provider_unavailable — the SDK server (:8099) answers, but the WRC has
  //      not yet brokered the provider into the eager mcp-host on its
  //      (level-triggered) reconcile loop, which may land a few seconds later.
  //   2. transport exception (e.g. "fetch failed") — the SDK listener itself, or
  //      its Service endpoints right after the caller pod is recreated, is not
  //      yet accepting connections. fetch() throws before any HTTP status.
  // The eager mcp-host is brokered the provider only after it boots AND becomes
  // Ready AND the WRC's level-triggered reconcile fires the eager /configure —
  // ~60-90s from recipe apply on a cold cluster, not "a few seconds". Retry wide
  // enough to outlast that window; a real plugin workload would do the same.
  const MAX_ATTEMPTS = 30
  const RETRY_DELAY_MS = 3000
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { status, body } = await callSdk('/v1/prompt-bridge', {
        purpose: 'summarization',
        idempotencyKey: `e2e-prompt-${RUN_ID}`,
        messages: [{ role: 'user', content: 'Summarize: the quick brown fox.' }],
      })
      if (status === 200 && body && body.invocationId) {
        firstPromptBridgeId = body.invocationId
        log(`E2E_SDK_PROMPT_BRIDGE_OK=${body.invocationId}`)
        return
      }
      const code = (body && (body.error || body.code)) || `http_${status}`
      if (code === 'provider_unavailable' && attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      log(`E2E_SDK_PROMPT_BRIDGE_FAIL=${code}`)
      return
    } catch (err) {
      // Transport-level cold start: retry through the same window as case (1).
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      log(`E2E_SDK_PROMPT_BRIDGE_FAIL=exception:${err && err.message ? err.message : err}`)
      return
    }
  }
}

async function exerciseClientNotification() {
  // Same transport cold-start tolerance as promptBridge: a recreated caller pod
  // can race the SDK listener / Service endpoints. Retry the connection-level
  // failure rather than declaring a hard FAIL on the first refused connection.
  const MAX_ATTEMPTS = 10
  const RETRY_DELAY_MS = 3000
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { status, body } = await callSdk('/v1/client-notifications', {
        eventType: EVENT_TYPE,
        userRef: USER_REF,
        idempotencyKey: `e2e-notify-${RUN_ID}`,
        notification: {
          title: 'E2E notification',
          body: 'Sent by the plugin workload SDK E2E fixture.',
        },
      })
      if (status === 200 && body && body.notificationId) {
        log(`E2E_SDK_CLIENT_NOTIFICATION_OK=${body.notificationId}`)
      } else {
        const code = (body && (body.error || body.code)) || `http_${status}`
        log(`E2E_SDK_CLIENT_NOTIFICATION_FAIL=${code}`)
      }
      return
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      log(`E2E_SDK_CLIENT_NOTIFICATION_FAIL=exception:${err && err.message ? err.message : err}`)
      return
    }
  }
}

/**
 * The mounted Sandbox UI fixture uses the same production SDK client-notification
 * route as the background workload. Keeping this in the fixture image lets the
 * Desktop E2E establish its notification from the app it actually mounts.
 */
async function emitSandboxUiNotification() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const { status, body } = await callSdk('/v1/client-notifications', {
        eventType: EVENT_TYPE,
        userRef: USER_REF,
        idempotencyKey: `e2e-sandbox-ui-notify-${RUN_ID}`,
        notification: {
          title: 'E2E Sandbox UI notification',
          body: 'Sent by the mounted Plugin Workload SDK Sandbox UI fixture.',
        },
      })
      if (status === 200 && body && body.notificationId) {
        log(`E2E_SDK_SANDBOX_UI_NOTIFICATION_OK=${body.notificationId}`)
        return body.notificationId
      }
      const code = (body && (body.error || body.code)) || `http_${status}`
      if (attempt === 10) throw new Error(`client notification failed: ${code}`)
    } catch (err) {
      if (attempt === 10) throw err
    }
    await sleep(3000)
  }
  throw new Error('sandbox-ui notification retry loop exhausted')
}

function startSandboxUiFixture() {
  let notification = null
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    notification ??= emitSandboxUiNotification()
    try {
      const notificationId = await notification
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><title>E2E Layout Notification App</title><main><h1>E2E Layout Notification App</h1><p data-notification-id="${notificationId}">Notification sent.</p></main>`
      )
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(
        `Could not emit Sandbox UI notification: ${error instanceof Error ? error.message : error}`
      )
    }
  })
  server.listen(Number(process.env.PORT || '8080'), '0.0.0.0', () => {
    log('E2E_SDK_SANDBOX_UI_READY')
  })
}

// Explicit selector: the backend can request one target from the operator's
// ordered policy. The targetRef is injected as non-secret recipe configuration;
// the workload never receives a provider key or credential slot value.
async function exerciseExplicitTarget() {
  if (!EXPLICIT_TARGET_REF) {
    log('E2E_SDK_EXPLICIT_TARGET_FAIL=missing_target_ref')
    return
  }
  try {
    const { status, body } = await callSdk('/v1/prompt-bridge', {
      purpose: 'generation',
      targetRef: EXPLICIT_TARGET_REF,
      idempotencyKey: `e2e-explicit-${RUN_ID}`,
      messages: [{ role: 'user', content: 'Reply with the word approved.' }],
    })
    if (
      status === 200 &&
      body &&
      body.invocationId &&
      typeof body.content === 'string' &&
      body.content.trim() &&
      body.servedTarget &&
      body.servedTarget.targetRef === EXPLICIT_TARGET_REF
    ) {
      log(`E2E_SDK_EXPLICIT_TARGET_OK=${body.invocationId}`)
    } else {
      const code = (body && (body.error || body.code)) || `http_${status}`
      log(`E2E_SDK_EXPLICIT_TARGET_FAIL=${code}`)
    }
  } catch (err) {
    log(`E2E_SDK_EXPLICIT_TARGET_FAIL=exception:${err && err.message ? err.message : err}`)
  }
}

// Idempotency: replay the same idempotencyKey must never invoke the provider or
// consume another quota slot. The public mcp-host route deliberately returns
// idempotency_conflict for a completed prompt because the audit record does not
// persist completion content to replay. The authorization record still keeps
// the original invocation identity; callers must use a fresh key when they
// need a new completion.
async function exerciseIdempotency() {
  try {
    const { status, body } = await callSdk('/v1/prompt-bridge', {
      purpose: 'summarization',
      idempotencyKey: `e2e-prompt-${RUN_ID}`, // SAME key as first call
      messages: [{ role: 'user', content: 'Summarize: the quick brown fox.' }],
    })
    const code = (body && (body.error || body.code)) || `http_${status}`
    if (status === 422 && code === 'idempotency_conflict') {
      log('E2E_SDK_IDEMPOTENCY_REPLAY_GUARDED')
    } else if (status === 200 && body && body.invocationId === firstPromptBridgeId) {
      // Keep accepting the richer replay response if the SDK later adds
      // durable completion replay without changing the no-double-charge
      // invariant.
      log('E2E_SDK_IDEMPOTENCY_REPLAY_GUARDED')
    } else if (status === 200 && body && body.invocationId !== firstPromptBridgeId) {
      log(`E2E_SDK_IDEMPOTENCY_FAIL=different_invocation_id:${body.invocationId}`)
    } else {
      log(`E2E_SDK_IDEMPOTENCY_FAIL=${code}`)
    }
  } catch (err) {
    log(`E2E_SDK_IDEMPOTENCY_FAIL=exception:${err && err.message ? err.message : err}`)
  }
}

// Quota enforcement: fill remaining quota slots then verify N+1 is rejected.
// The default and explicit-target prompt calls consumed 2 slots; the
// idempotency replay does NOT consume a slot. Fill the remaining slots, then
// attempt one beyond.
async function exerciseQuotaEnforcement() {
  try {
    const remaining = QUOTA_LIMIT - 2
    for (let i = 0; i < remaining; i++) {
      const { status, body } = await callSdk('/v1/prompt-bridge', {
        purpose: 'classification',
        idempotencyKey: `e2e-quota-fill-${i}-${RUN_ID}`,
        messages: [{ role: 'user', content: `Classify: test item ${i}.` }],
      })
      if (status !== 200) {
        const code = (body && (body.error || body.code)) || `http_${status}`
        log(`E2E_SDK_QUOTA_EXCEEDED_FAIL=fill_call_failed:${code}`)
        return
      }
    }

    // Quota should now be exhausted. The next call must be rejected.
    const { status, body } = await callSdk('/v1/prompt-bridge', {
      purpose: 'classification',
      idempotencyKey: `e2e-quota-exceed-${RUN_ID}`,
      messages: [{ role: 'user', content: 'This should be rejected by quota.' }],
    })
    if (status !== 200) {
      const code = (body && (body.error || body.code)) || `http_${status}`
      if (code.includes('quota') || status === 429) {
        log('E2E_SDK_QUOTA_EXCEEDED_OK')
      } else {
        log(`E2E_SDK_QUOTA_EXCEEDED_FAIL=wrong_error:${code}`)
      }
    } else {
      log('E2E_SDK_QUOTA_EXCEEDED_FAIL=call_accepted_after_quota_exhausted')
    }
  } catch (err) {
    log(`E2E_SDK_QUOTA_EXCEEDED_FAIL=exception:${err && err.message ? err.message : err}`)
  }
}

async function main() {
  if (process.env.E2E_SDK_MODE === 'sandbox-ui') {
    if (!ENDPOINT || !TOKEN) {
      log('E2E_SDK_SANDBOX_UI_FAIL=missing_endpoint_or_token')
      return
    }
    startSandboxUiFixture()
    return
  }
  if (!ENDPOINT || !TOKEN) {
    log('E2E_SDK_PROMPT_BRIDGE_FAIL=missing_endpoint_or_token')
    log('E2E_SDK_CLIENT_NOTIFICATION_FAIL=missing_endpoint_or_token')
  } else {
    // Phase 1: Happy path — one promptBridge + one clientNotification.
    await exercisePromptBridge()
    await exerciseClientNotification()

    // Phase 1b: explicit approved target selection.
    if (firstPromptBridgeId) {
      await exerciseExplicitTarget()
    }

    // Phase 2: Idempotency — same key returns same invocationId.
    if (firstPromptBridgeId) {
      await exerciseIdempotency()
    }

    // Phase 3: Quota enforcement — fill quota then verify rejection.
    if (firstPromptBridgeId) {
      await exerciseQuotaEnforcement()
    }
  }
  log('E2E_SDK_DONE')
  // Stay alive so the E2E gate can read logs and inspect the pod env.
  setInterval(() => {}, 1 << 30)
}

void main()
