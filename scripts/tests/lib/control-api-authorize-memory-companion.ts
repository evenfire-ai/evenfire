/** Test-only in-pod driver. Production signing, HTTP, PostgreSQL and terminal lifecycle remain real. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { connectInspector, parseCgroup } from './control-api-authorize-memory-inspector.mjs'

type Frame = { callId: string; kind: string; requestId?: string; length?: number; options?: Record<string, unknown> }
export async function runCompanion(): Promise<void> {
  const output = process.stdout.write.bind(process.stdout)
  // Only allowlisted envelopes use the saved writer; dependency/bootstrap logs
  // and secret-bearing response bodies cannot reach the controller.
  process.stdout.write = () => true; process.stderr.write = () => true
  const emit = (value: unknown) => output(JSON.stringify(value) + '\n')
  const sockets = new Map<string, any>(), created = new Map<string, any>()
  const cookieName = 'control_ui_admin_session'
  const knownErrors = new Set(['authorize_capacity_exceeded', 'payload_too_large', 'invalid_request', 'request_timeout', 'authorize_timeout', 'unauthorized', 'Unauthorized', 'disabled', 'insufficient_scope', 'no_grant', 'model_not_allowed', 'unassigned_connection', 'connection_unavailable', 'budget_denied', 'host_binding_mismatch', 'provider_unavailable', 'stale_generation', 'idempotency_conflict'])
  let options: any, inspector: any, prod: any, lockClient: any
  const require = createRequire(path.join(process.cwd(), 'package.json'))
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const cgroup = () => parseCgroup({ current: fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'), peak: fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'), limit: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8'), events: fs.readFileSync('/sys/fs/cgroup/memory.events', 'utf8') })
  function ordinary(method: string, route: string, body?: unknown, cookie = options.cookie): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: prod.config.port, method, path: route,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `${cookieName}=${cookie}` } : {}) } }, response => {
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(new Error('bounded response exceeded')); else chunks.push(chunk) })
        response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, body: bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null }) } catch { reject(new Error('invalid bounded response')) } })
      })
      request.on('error', reject); request.setTimeout(15000, () => request.destroy(new Error('ordinary request deadline')))
      if (body) request.write(JSON.stringify(body)); request.end()
    })
  }
  async function counts() {
    const rows = await prod.db.pool.query(`SELECT COUNT(DISTINCT a.id)::int AS total,
      COUNT(DISTINCT a.id) FILTER (WHERE a.status <> 'finalized')::int AS active,
      COUNT(DISTINCT t.jti) FILTER (WHERE t.status <> 'finalized' AND t.expires_at > NOW())::int AS active_tickets,
      COUNT(DISTINCT r.id)::int AS reservations FROM llm_provider_attempts a
      LEFT JOIN llm_provider_attempt_tickets t ON t.provider_attempt_id = a.id
      LEFT JOIN budget_pending_reservations r ON r.id::text = a.budget_reservation_id OR r.task_ref = a.budget_reservation_id
      WHERE a.invocation_id LIKE $1 AND a.host_ref = ANY($2::text[]) AND a.provider = 'grok-subscription'`, [`${options.runId}-%`, options.bindings.map((binding: any) => binding.hostRef)])
    const value = rows.rows[0]
    return { total: value.total, active: value.active, activeTickets: value.active_tickets, reservations: value.reservations }
  }
  async function hello(input: any) {
    options = input
    if (!/^pr806-memory-[a-f0-9]{12}$/.test(options.runId) || !Array.isArray(options.bindings) || options.bindings.length !== 2) throw new Error('invalid run binding')
    process.env.LOG_LEVEL = 'silent'
    prod = { config: require('./dist/config.js').config, db: require('./dist/db.js'), jwt: require('./dist/utils/auth/mcpHostJwtToken.js'),
      connections: require('./dist/services/grokSubscriptionConnection.js'),
      policy: require('./dist/middleware/llmProviderAttemptAdmissionLimits.js').LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY,
      grok: require('@clerum/grok-provider-attempt-contract'), finalize: require('./dist/services/grokProviderAttemptFinalization.js').finalizeGrokProviderAttempt,
      opaque: require('./dist/services/llmProviderAttemptRedemption.js').opaqueAttemptReceipt }
    if (!prod.config.grokSubscriptionEnabled || !prod.config.codexSubscriptionEnabled) throw new Error('both actual provider validators must be enabled')
    inspector = await connectInspector(options.inspectorPort)
    const server = await inspector.snapshot()
    const flags = [...server.execArgv, ...server.nodeOptions.split(/\s+/).filter(Boolean)]
    if (server.cwd !== process.cwd() || !server.argv[1]?.endsWith('/dist/main.js') ||
        !flags.includes(`--max-old-space-size=${options.candidate.heapSizeMiB}`) || !flags.includes(`--inspect=127.0.0.1:${options.inspectorPort}`) ||
        flags.some(flag => !/^--(?:max-old-space-size=\d+|inspect=127\.0\.0\.1:\d+|enable-source-maps)$/.test(flag))) throw new Error('actual server source/argv mismatch')
    const expected = { maxInFlight: options.candidate.concurrency, readDeadlineMs: options.candidate.readDeadlineMs, workDeadlineMs: options.candidate.workDeadlineMs, closeGraceMs: options.candidate.closeGraceMs }
    if (JSON.stringify(prod.policy) !== JSON.stringify(expected)) throw new Error('actual compiled admission policy differs from candidate')
    if (!options.cookie) {
      if (!options.operatorPassword || !options.operatorUser) throw new Error('operator material unavailable')
      const login = await ordinary('POST', '/api/v1/admin/auth/login', { username: options.operatorUser, password: options.operatorPassword }, '')
      const raw = (login.headers['set-cookie'] ?? []).find((value: string) => value.startsWith(`${cookieName}=`))
      if (login.status !== 200 || !raw) throw new Error('operator login refused')
      options.cookie = raw.split(';')[0].slice(cookieName.length + 1); options.operatorPassword = undefined
    }
    const me = await ordinary('GET', '/api/v1/admin/auth/me')
    if (me.status !== 200 || me.body?.me?.username !== options.operatorUser) throw new Error('operator identity mismatch')
    const parent = await ordinary('GET', `/api/v1/gfs/proxy/v1/resources/${options.gfsParentRid}`)
    if (parent.status !== 200 || parent.body?.ok !== true || parent.body.data.kind !== 'directory' || !parent.body.data.name.includes(options.fixtureRunId)) throw new Error('GFS parent ownership unproved')
    options.gfsParentResourceId = parent.body.data.resourceId
    const bindings = []
    for (const binding of options.bindings) {
      if (!binding.connectionKey.includes(options.fixtureRunId)) throw new Error('connection is not fixture-owned')
      const connection = await prod.connections.getSafeGrokSubscriptionConnection(prod.db.pool, binding.connectionKey)
      if (!connection || connection.status !== 'connected' || connection.catalogStatus !== 'ready') throw new Error('actual connection unavailable')
      const model = await prod.db.pool.query('SELECT enabled, stale FROM grok_catalog_models WHERE connection_id = $1 AND model = $2', [connection.id, 'grok-4.6'])
      if (model.rows.length !== 1 || !model.rows[0].enabled || model.rows[0].stale) throw new Error('actual model not admitted')
      const budget = await prod.db.pool.query('SELECT name FROM token_budgets WHERE id = $1', [binding.budgetId])
      if (budget.rows.length !== 1 || !budget.rows[0].name.includes(options.fixtureRunId)) throw new Error('budget not fixture-owned')
      const policyHash = prod.grok.computeGrokPolicyHash({ model: 'grok-4.6', catalogRevision: connection.catalogRevision, credentialRevision: connection.credentialRevision, connectionKey: binding.connectionKey })
      bindings.push({ ...binding, connectionId: connection.id, policyRevision: connection.catalogRevision, policyHash })
    }
    options.bindings = bindings
    if ((await counts()).total !== 0) throw new Error('run id is not fresh')
    return { bindings, policy: prod.policy, compiledPolicySha256: hash(fs.readFileSync('./dist/middleware/llmProviderAttemptAdmissionLimits.js')),
      server: { ...server, nodeOptions: undefined }, cgroup: cgroup(), operatorSessionValidated: true, gfsParentResourceId: options.gfsParentResourceId,
      auxiliary: { pid: process.pid, memory: process.memoryUsage(), inputHighWaterMark: process.stdin.readableHighWaterMark } }
  }
  async function unlock() {
    if (lockClient) { const client = lockClient; lockClient = undefined; try { await client.query('ROLLBACK') } finally { client.release() } }
    return { released: true }
  }
  function open(input: any) {
    if (sockets.size >= 8 || sockets.has(input.requestId) || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > 36 * 1024 * 1024) throw new Error('invalid bounded request')
    let route: string; const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(input.length) }
    if (input.route === 'authorize') {
      const binding = options.bindings.find((value: any) => value.hostRef === input.hostRef)
      if (!binding) throw new Error('Host not owned')
      const issued = prod.jwt.issueMcpHostAccessJwt(prod.config.hostsNamespace, 'standalone', [binding.hostRef], { workflowControlScopes: ['llm:grok:execute', 'llm:codex:execute'], hccCredential: { hostUid: binding.hostUid } })
      headers.authorization = `Bearer ${issued.token}`; route = '/api/v1/mcp-host/llm/provider-attempts/authorize'
    } else if (input.route === 'gfs') {
      if (!input.name?.startsWith(`${options.runId}-`)) throw new Error('GFS filename not owned')
      headers.cookie = `${cookieName}=${options.cookie}`; route = `/api/v1/gfs/proxy/v1/resources/${options.gfsParentRid}/children`
    } else throw new Error('invalid route')
    const state: any = { input, acceptedWriteBytes: 0, maxWritableBytes: 0, closedByClient: false }
    const request = http.request({ hostname: '127.0.0.1', port: prod.config.port, method: 'POST', path: route, headers }, response => {
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(new Error('response bound')); else chunks.push(chunk) })
      response.on('end', () => {
        try {
          const body = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null
          let data: any = { status: response.statusCode, acceptedWriteBytes: state.acceptedWriteBytes, maxWritableBytes: state.maxWritableBytes, closedByClient: state.closedByClient, error: knownErrors.has(body?.error) ? body.error : undefined }
          if (input.route === 'authorize' && response.statusCode === 200) data = { ...data, providerAttemptId: body.providerAttemptId, requestHash: body.requestHash }
          if (input.route === 'gfs' && response.statusCode === 201 && body?.ok === true) {
            const value = body.data
            if (value.name !== input.name || value.parentResourceId !== options.gfsParentResourceId || value.bytes !== input.decodedBytes || value.kind !== 'file') throw new Error('GFS receipt mismatch')
            created.set(value.rid, { rid: value.rid, resourceId: value.resourceId, name: value.name, bytes: value.bytes, parentResourceId: value.parentResourceId }); data.resource = created.get(value.rid)
          }
          emit({ event: 'response', requestId: input.requestId, data }); sockets.delete(input.requestId)
        } catch { emit({ event: 'response', requestId: input.requestId, data: { failed: true, code: 'INVALID_BUSINESS_RESPONSE' } }); sockets.delete(input.requestId) }
      })
    })
    state.request = request; sockets.set(input.requestId, state)
    request.on('error', () => { sockets.delete(input.requestId); emit({ event: 'response', requestId: input.requestId, data: { transportClosed: true, acceptedWriteBytes: state.acceptedWriteBytes, closedByClient: state.closedByClient } }) })
    request.setTimeout(options.candidate.workDeadlineMs + options.candidate.readDeadlineMs + 5000, () => request.destroy(new Error('HTTP deadline')))
    request.flushHeaders(); return { opened: true }
  }
  async function download(rid: string) {
    const owned = created.get(rid); if (!owned) throw new Error('download not owned')
    return new Promise((resolve, reject) => {
      const digest = createHash('sha256'); let bytes = 0
      const request = http.get({ hostname: '127.0.0.1', port: prod.config.port, path: `/api/v1/gfs/proxy/v1/resources/${rid}/content`, headers: { cookie: `${cookieName}=${options.cookie}` } }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error('GFS read refused')); return }
        response.on('data', chunk => { bytes += chunk.length; digest.update(chunk); if (bytes > owned.bytes) request.destroy(new Error('GFS overflow')) })
        response.on('end', () => bytes === owned.bytes ? resolve({ rid, bytes, sha256: digest.digest('hex') }) : reject(new Error('GFS incomplete')))
      }); request.on('error', reject); request.setTimeout(15000, () => request.destroy(new Error('GFS deadline')))
    })
  }
  async function cleanup() {
    for (const state of sockets.values()) { state.closedByClient = true; state.request.destroy() }
    await unlock()
    const rows = await prod.db.pool.query(`SELECT a.id, a.request_hash, a.connection_id, t.jti::text FROM llm_provider_attempts a JOIN llm_provider_attempt_tickets t ON t.provider_attempt_id = a.id WHERE a.invocation_id LIKE $1 AND a.host_ref = ANY($2::text[]) AND a.provider = 'grok-subscription'`, [`${options.runId}-%`, options.bindings.map((value: any) => value.hostRef)])
    for (const row of rows.rows) {
      if (!options.bindings.some((value: any) => value.connectionId === row.connection_id)) throw new Error('attempt owner changed')
      const opaque = prod.opaque({ jti: row.jti, providerAttemptId: row.id, requestHash: row.request_hash })
      await prod.finalize({ attemptReceipt: opaque, receipt: { schemaVersion: 'grok-attempt-receipt.v1', providerAttemptId: row.id, requestHash: row.request_hash, outcome: 'canceled' } })
    }
    for (const [rid, expected] of created) {
      const current = await ordinary('GET', `/api/v1/gfs/proxy/v1/resources/${rid}`)
      if (current.status !== 200 || current.body?.data?.resourceId !== expected.resourceId || current.body.data.name !== expected.name || current.body.data.parentResourceId !== expected.parentResourceId) throw new Error('GFS owner changed')
      const deleted = await ordinary('DELETE', `/api/v1/gfs/proxy/v1/resources/${rid}`)
      if (deleted.status !== 200 || deleted.body?.data?.deleted !== true) throw new Error('GFS cleanup failed')
      created.delete(rid)
    }
    const after = await counts()
    if (after.active || after.activeTickets || after.reservations) throw new Error('terminal lifetime incomplete')
    return { ...after, ownedGfsRemaining: created.size, retainedFinalizedAuditRows: rows.rows.length }
  }
  async function command(input: any): Promise<unknown> {
    if (input.kind === 'hello') return hello(input.options)
    if (!prod) throw new Error('runtime admission required')
    if (input.kind === 'open') return open(input)
    if (input.kind === 'end') { sockets.get(input.requestId)?.request.end(); return { ended: true } }
    if (input.kind === 'close') { const state = sockets.get(input.requestId); if (state) { state.closedByClient = true; state.request.destroy() }; return { clientClosed: true } }
    if (input.kind === 'counts') return counts()
    if (input.kind === 'lock') {
      if (lockClient) throw new Error('lock already held')
      lockClient = await prod.db.pool.connect(); await lockClient.query('BEGIN'); await lockClient.query('SET LOCAL statement_timeout = 60000')
      await lockClient.query('SELECT id FROM token_budgets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [options.bindings.map((value: any) => value.budgetId)])
      return { locked: true }
    }
    if (input.kind === 'unlock') return unlock()
    if (input.kind === 'waiting') {
      if (!lockClient) return { count: 0 }
      const pid = (await lockClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      return (await prod.db.pool.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND usename = current_user", [pid])).rows[0]
    }
    if (input.kind === 'sample') return { server: await inspector.snapshot(), cgroup: cgroup() }
    if (input.kind === 'gc') return { gc: await inspector.forceGc(), cgroup: cgroup() }
    if (input.kind === 'coverage-start') { await inspector.startCoverage(); return { started: true } }
    if (input.kind === 'coverage') return inspector.coverage()
    if (input.kind === 'coverage-stop') { await inspector.stopCoverage(); return { stopped: true } }
    if (input.kind === 'download') return download(input.rid)
    if (input.kind === 'health') return { status: (await ordinary('GET', '/health', undefined, '')).status }
    if (input.kind === 'cleanup') return cleanup()
    throw new Error('unknown command')
  }
  let header = Buffer.alloc(0), frame: Frame, remaining = 0
  try {
    for await (const chunk of process.stdin) {
      let offset = 0
      while (offset < chunk.length) {
        if (remaining) {
          const length = Math.min(remaining, chunk.length - offset), state = sockets.get(frame.requestId!)
          if (!state) throw new Error('request closed before streaming completed')
          state.acceptedWriteBytes += length
          const writable = state.request.write(chunk.subarray(offset, offset + length))
          state.maxWritableBytes = Math.max(state.maxWritableBytes, state.request.writableLength)
          if (!writable) await once(state.request, 'drain')
          offset += length; remaining -= length
          if (!remaining) emit({ callId: frame.callId, data: { streamedBytes: frame.length } })
        } else {
          const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline
          header = Buffer.concat([header, chunk.subarray(offset, end)])
          if (header.length > 32768) throw new Error('header bound exceeded')
          offset = newline < 0 ? end : end + 1
          if (newline < 0) continue
          frame = JSON.parse(header.toString()); header = Buffer.alloc(0)
          if (frame.kind === 'write') {
            if (!Number.isSafeInteger(frame.length) || frame.length! < 1 || frame.length! > 65536) throw new Error('body frame bound exceeded')
            remaining = frame.length!
          } else { try { emit({ callId: frame.callId, data: await command(frame) }) } catch { emit({ callId: frame.callId, failed: true, code: 'REAL_RUNTIME_COMMAND_FAILED' }) } }
        }
      }
    }
    if (remaining || header.length) throw new Error('incomplete frame')
  } catch { emit({ fatal: true, code: 'COMPANION_PROTOCOL_FAILED' }); process.exitCode = 1 }
  finally { for (const state of sockets.values()) state.request.destroy(); await unlock().catch(() => {}); inspector?.close(); if (prod) await prod.db.pool.end().catch(() => {}) }
}
