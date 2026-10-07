/** Test-only in-pod driver. Signing, HTTP, PostgreSQL and issued-ticket expiry remain real. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { connectInspector, parseCgroup } from './control-api-authorize-memory-inspector.mjs'

type CleanupRow = { id: string; invocation_id: string; host_ref: string; request_hash: string; connection_id: string; status: string; ticket_status: string; ticket_expired: boolean; reservation_id: string | null; reservation_host_ref: string | null; budget_id: string | null }
type ConfirmedAttempt = { invocationId: string; hostRef: string; requestHash: string }

/** An issued ticket cannot be receipt-finalized. Only known, never-dispatched
 * authorizations with observed ticket expiry may release their own ephemeral reservation through the real
 * Host endpoint; the issued ticket and authorized audit row remain untouched.
 */
export function ownedIssuedCleanupPlan(rows: CleanupRow[], bindings: any[], confirmed: Map<string, ConfirmedAttempt>) {
  const attempts = new Set<string>(), reservations = new Map<string, { reservationId: string; hostRef: string }>()
  for (const row of rows) {
    const binding = bindings.find(value => value.hostRef === row.host_ref)
    const witness = confirmed.get(row.id)
    if (!binding || binding.connectionId !== row.connection_id || !witness || witness.invocationId !== row.invocation_id || witness.hostRef !== row.host_ref || witness.requestHash !== row.request_hash) throw new Error('unconfirmed or changed attempt ownership')
    if (row.status !== 'authorized' || row.ticket_status !== 'issued' || row.ticket_expired !== true) throw new Error('issued benchmark lifecycle changed')
    attempts.add(row.id)
    if (row.reservation_id !== null) {
      if (row.reservation_host_ref !== row.host_ref || row.budget_id !== binding.budgetId) throw new Error('reservation ownership changed')
      reservations.set(row.reservation_id, { reservationId: row.reservation_id, hostRef: row.host_ref })
    }
  }
  if (attempts.size !== confirmed.size) throw new Error('confirmed authorization audit is incomplete')
  return { retainedAuthorizedAuditRows: attempts.size, reservations: [...reservations.values()] }
}

type Frame = { callId: string; kind: string; requestId?: string; length?: number; options?: Record<string, unknown> }
export async function runCompanion(): Promise<void> {
  const output = process.stdout.write.bind(process.stdout)
  // Only allowlisted envelopes use the saved writer; dependency/bootstrap logs
  // and secret-bearing response bodies cannot reach the controller.
  process.stdout.write = () => true; process.stderr.write = () => true
  const emit = (value: unknown) => output(JSON.stringify(value) + '\n')
  const sockets = new Map<string, any>(), created = new Map<string, any>(), confirmed = new Map<string, ConfirmedAttempt>()
  let releasedReservationRows = 0
  const cookieName = 'control_ui_admin_session'
  const knownErrors = new Set(['authorize_capacity_exceeded', 'payload_too_large', 'invalid_request', 'request_timeout', 'authorize_timeout', 'unauthorized', 'Unauthorized', 'disabled', 'insufficient_scope', 'no_grant', 'model_not_allowed', 'unassigned_connection', 'connection_unavailable', 'budget_denied', 'host_binding_mismatch', 'provider_unavailable', 'stale_generation', 'idempotency_conflict'])
  let options: any, inspector: any, prod: any, lockClient: any
  const require = createRequire(path.join(process.cwd(), 'package.json'))
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const processCounts = (serverPid: number) => {
    const ids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); let applications = 0, nodes = 0
    for (const id of ids) {
      let args: string[]; try { args = fs.readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0') } catch (error: any) { if (error.code === 'ENOENT') continue; throw error }
      if (path.basename(args[0] || '') !== 'node') continue
      nodes++; if (args.includes('dist/main.js') || args.includes(path.join(process.cwd(), 'dist/main.js'))) { if (Number(id) !== serverPid) throw new Error('another application process is measured'); applications++ }
    }
    if (applications !== 1) throw new Error('application process count is unknown')
    return { applicationProcesses: applications, nodeProcessesIncludingAuxiliary: nodes }
  }
  const cgroup = () => parseCgroup({ current: fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'), peak: fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'), limit: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8'), events: fs.readFileSync('/sys/fs/cgroup/memory.events', 'utf8') })
  function ordinary(method: string, route: string, body?: unknown, cookie = options.cookie, extraHeaders: Record<string, string> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: prod.config.port, method, path: route,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `${cookieName}=${cookie}` } : {}), ...extraHeaders } }, response => {
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(new Error('bounded response exceeded')); else chunks.push(chunk) })
        response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, body: bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null }) } catch { reject(new Error('invalid bounded response')) } })
      })
      request.on('error', reject); request.setTimeout(15000, () => request.destroy(new Error('ordinary request deadline')))
      if (body) request.write(JSON.stringify(body)); request.end()
    })
  }
  const reservationJoin = `r.host_ref = a.host_ref AND (r.id::text = a.budget_reservation_id OR r.task_ref = a.invocation_id || ':' || a.attempt_generation::text || ':' || a.provider_attempt_index::text)`
  async function counts() {
    const rows = await prod.db.pool.query(`SELECT COUNT(DISTINCT a.id)::int AS total,
      COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'authorized')::int AS authorized_audit_rows,
      COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'redeemed')::int AS redeemed_audit_rows,
      COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'finalized')::int AS finalized_audit_rows,
      COUNT(DISTINCT t.jti)::int AS tickets,
      COUNT(DISTINCT t.jti) FILTER (WHERE t.status = 'issued' AND t.expires_at > NOW())::int AS live_issued_tickets,
      COUNT(DISTINCT t.jti) FILTER (WHERE t.status = 'issued' AND t.expires_at <= NOW())::int AS expired_issued_tickets,
      COUNT(DISTINCT t.jti) FILTER (WHERE t.status = 'redeemed')::int AS redeemed_tickets,
      COUNT(DISTINCT t.jti) FILTER (WHERE t.status = 'finalized')::int AS finalized_tickets,
      COUNT(DISTINCT r.id)::int AS reservation_rows,
      COUNT(DISTINCT r.id) FILTER (WHERE r.expires_at > NOW())::int AS active_reservations,
      COALESCE(GREATEST(0, CEIL(EXTRACT(EPOCH FROM (MAX(t.expires_at) FILTER (WHERE t.status = 'issued') - NOW())) * 1000)), 0)::int AS expiry_remaining_ms,
      NOW() AS observed_at
      FROM llm_provider_attempts a LEFT JOIN llm_provider_attempt_tickets t ON t.provider_attempt_id = a.id
      LEFT JOIN budget_pending_reservations r ON ${reservationJoin}
      WHERE a.invocation_id LIKE $1 AND a.host_ref = ANY($2::text[]) AND a.provider = 'grok-subscription'`, [`${options.runId}-%`, options.bindings.map((binding: any) => binding.hostRef)])
    const value = rows.rows[0]
    return { total: value.total, retainedAuthorizedAuditRows: value.authorized_audit_rows, redeemedAuditRows: value.redeemed_audit_rows, finalizedAuditRows: value.finalized_audit_rows,
      tickets: value.tickets, liveIssuedTickets: value.live_issued_tickets, expiredIssuedTickets: value.expired_issued_tickets, redeemedTickets: value.redeemed_tickets, finalizedTickets: value.finalized_tickets,
      reservationRows: value.reservation_rows, activeReservations: value.active_reservations, executionTicketExpiryRemainingMs: value.expiry_remaining_ms, observedAt: value.observed_at.toISOString() }
  }
  function hostHeaders(binding: any) {
    const issued = prod.jwt.issueMcpHostAccessJwt(prod.config.hostsNamespace, 'standalone', [binding.hostRef], { workflowControlScopes: ['llm:grok:execute', 'llm:codex:execute'], hccCredential: { hostUid: binding.hostUid } })
    return { authorization: `Bearer ${issued.token}` }
  }
  async function hello(input: any) {
    options = input
    if (!/^pr806-memory-[a-f0-9]{12}$/.test(options.runId) || !Array.isArray(options.bindings) || options.bindings.length !== 2) throw new Error('invalid run binding')
    process.env.LOG_LEVEL = 'silent'
    prod = { config: require('./dist/config.js').config, db: require('./dist/db.js'), jwt: require('./dist/utils/auth/mcpHostJwtToken.js'),
      connections: require('./dist/services/grokSubscriptionConnection.js'),
      policy: require('./dist/middleware/llmProviderAttemptAdmissionLimits.js').LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY,
      grok: require('@clerum/grok-provider-attempt-contract') }
    if (options.hostNamespace !== prod.config.hostsNamespace || !prod.config.grokSubscriptionEnabled || !prod.config.codexSubscriptionEnabled) throw new Error('both actual provider validators must be enabled')
    if (prod.config.subscriptionCatalogSyncCronEnabled !== false || prod.config.llmCatalogSyncCronEnabled !== false) throw new Error('actual vendor crons must be disabled')
    inspector = await connectInspector(options.inspectorPort)
    const server = await inspector.snapshot()
    const flags = [...server.execArgv, ...server.nodeOptions.split(/\s+/).filter(Boolean)]
    if (server.cwd !== process.cwd() || server.argv.length !== 2 || !server.argv[1]?.endsWith('/dist/main.js') ||
        flags.filter(flag => flag.startsWith('--max-old-space-size=')).length !== 1 || !flags.includes(`--max-old-space-size=${options.candidate.heapSizeMiB}`) || flags.filter(flag => flag.startsWith('--inspect=')).length !== 1 || !flags.includes(`--inspect=127.0.0.1:${options.inspectorPort}`) ||
        flags.some(flag => !/^--(?:max-old-space-size=\d+|inspect=127\.0\.0\.1:\d+|enable-source-maps)$/.test(flag))) throw new Error('actual server source/argv mismatch')
    const expected: Record<string, number> = { maxInFlight: options.candidate.concurrency, readDeadlineMs: options.candidate.readDeadlineMs, workDeadlineMs: options.candidate.workDeadlineMs, closeGraceMs: options.candidate.closeGraceMs }
    if (!Object.keys(expected).every(key => prod.policy[key] === expected[key]) || Object.keys(prod.policy).length !== 4) throw new Error('actual compiled admission policy differs from candidate')
    if (options.pressureOnly === true) {
      if (options.bindings.some((binding: any) => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.hostRef) || !/^[a-f0-9-]{36}$/.test(binding.hostUid))) throw new Error('pressure Host identity invalid')
      if ((await counts()).total !== 0) throw new Error('pressure run is not fresh')
      const owner = await inspector.owners()
      if (owner.pid !== server.pid || owner.inFlight !== 0) throw new Error('pressure baseline is not quiescent')
      return { pressureOnly: true, bindings: options.bindings.map((binding: any) => ({ hostRef: binding.hostRef, hostUid: binding.hostUid })), policy: prod.policy, serverPid: server.pid, owner, compiledPolicySha256: hash(fs.readFileSync('./dist/middleware/llmProviderAttemptAdmissionLimits.js')) }
    }
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
      const budget = await prod.db.pool.query('SELECT name, enabled, scope, unit, currency, enforcement, limit_amount, max_task_amount, min_start_amount, period, timezone FROM token_budgets WHERE id = $1', [binding.budgetId])
      const rule = budget.rows[0], scope = rule?.scope
      if (budget.rows.length !== 1 || !rule.name.includes(options.fixtureRunId) || rule.enabled !== true || rule.unit !== 'tokens' || rule.currency !== null || rule.enforcement !== 'block' || Number(rule.limit_amount) !== 100 || Number(rule.max_task_amount) !== 200 || Number(rule.min_start_amount) !== 1 || rule.period !== 'daily' || rule.timezone !== 'UTC' || !scope || Object.keys(scope).length !== 3 || scope.host_ref?.length !== 1 || scope.host_ref[0] !== binding.hostRef || scope.provider?.length !== 1 || scope.provider[0] !== 'grok-subscription' || scope.model?.length !== 1 || scope.model[0] !== 'grok-4.6') throw new Error('actual owned danger-zone budget mismatch')
      const policyHash = prod.grok.computeGrokPolicyHash({ model: 'grok-4.6', catalogRevision: connection.catalogRevision, credentialRevision: connection.credentialRevision, connectionKey: binding.connectionKey })
      bindings.push({ hostRef: binding.hostRef, hostUid: binding.hostUid, connectionKey: binding.connectionKey, budgetId: binding.budgetId, connectionId: connection.id, policyRevision: connection.catalogRevision, policyHash })
    }
    options.bindings = bindings
    if ((await counts()).total !== 0) throw new Error('run id is not fresh')
    return { bindings, policy: prod.policy, executionTicketTtlMs: prod.grok.LIMITS.executionTicketTtlMs, compiledPolicySha256: hash(fs.readFileSync('./dist/middleware/llmProviderAttemptAdmissionLimits.js')),
      server: { ...server, nodeOptions: undefined, ...processCounts(server.pid) }, cgroup: cgroup(), operatorSessionValidated: true, gfsParentResourceId: options.gfsParentResourceId,
      auxiliary: { pid: process.pid, memory: process.memoryUsage(), inputHighWaterMark: process.stdin.readableHighWaterMark } }
  }
  async function unlock() {
    if (lockClient) { const client = lockClient; lockClient = undefined; try { await client.query('ROLLBACK') } finally { client.release() } }
    return { released: true }
  }
  function open(input: any) {
    if (sockets.size >= 8 || sockets.has(input.requestId) || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > 36 * 1024 * 1024) throw new Error('invalid bounded request')
    if (options.pressureOnly === true && (input.route !== 'authorize' || input.length !== 35 * 1024 * 1024 - 4096 || !input.requestId?.startsWith(`${options.runId}-pressure-`) || sockets.size >= prod.policy.maxInFlight)) throw new Error('pressure must remain an owned incomplete authorize body')
    let route: string; const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(input.length) }
    if (input.route === 'authorize') {
      const binding = options.bindings.find((value: any) => value.hostRef === input.hostRef)
      if (!binding) throw new Error('Host not owned')
      Object.assign(headers, hostHeaders(binding)); route = '/api/v1/mcp-host/llm/provider-attempts/authorize'
    } else if (input.route === 'gfs') {
      if (!input.name?.startsWith(`${options.runId}-`)) throw new Error('GFS filename not owned')
      headers.cookie = `${cookieName}=${options.cookie}`; route = `/api/v1/gfs/proxy/v1/resources/${options.gfsParentRid}/children`
    } else throw new Error('invalid route')
    if (options.pressureOnly === true) { headers['x-evenfire-qa-pressure-id'] = input.requestId; headers.connection = 'close' }
    const state: any = { input, acceptedWriteBytes: 0, maxWritableBytes: 0, closedByClient: false }
    const request = http.request({ hostname: '127.0.0.1', port: prod.config.port, method: 'POST', path: route, headers, ...(options.pressureOnly === true ? { agent: false } : {}) }, response => {
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(new Error('response bound')); else chunks.push(chunk) })
      response.on('end', async () => {
        try {
          const body = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null
          let data: any = { status: response.statusCode, acceptedWriteBytes: state.acceptedWriteBytes, maxWritableBytes: state.maxWritableBytes, closedByClient: state.closedByClient, error: knownErrors.has(body?.error) ? body.error : undefined }
          if (input.route === 'authorize' && response.statusCode === 200) {
            const rows = await prod.db.pool.query(`SELECT a.id, a.invocation_id, a.host_ref, a.request_hash, a.status, r.id::text AS reservation_id, r.budget_id::text, r.host_ref AS reservation_host_ref, r.est_amount, r.expires_at > NOW() AS reservation_active, t.status AS ticket_status, t.expires_at FROM llm_provider_attempts a LEFT JOIN budget_pending_reservations r ON r.id::text = a.budget_reservation_id LEFT JOIN llm_provider_attempt_tickets t ON t.provider_attempt_id = a.id WHERE a.id = $1`, [body.providerAttemptId])
            if (rows.rows.length !== 1 || rows.rows[0].invocation_id !== input.requestId || rows.rows[0].host_ref !== input.hostRef || rows.rows[0].request_hash !== body.requestHash || rows.rows[0].status !== 'authorized') throw new Error('real durable authorize witness missing')
            const binding = options.bindings.find((value: any) => value.hostRef === input.hostRef), witness = rows.rows[0]
            if (!binding || witness.budget_id !== binding.budgetId || witness.reservation_host_ref !== input.hostRef || Number(witness.est_amount) !== 200 || witness.reservation_active !== true || witness.ticket_status !== 'issued') throw new Error('real danger-zone reservation witness missing')
            confirmed.set(body.providerAttemptId, { invocationId: input.requestId, hostRef: input.hostRef, requestHash: body.requestHash })
            data = { ...data, providerAttemptId: body.providerAttemptId, requestHash: body.requestHash, durableRowVerified: true, reservationVerified: true, reservationAmount: Number(witness.est_amount), ticketExpiresAt: witness.expires_at.toISOString() }
          }
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
    request.flushHeaders()
    if (options.pressureOnly === true) {
      const wireHeader = (request as unknown as { _header?: string })._header
      if (typeof wireHeader !== 'string') throw new Error('actual pressure header unavailable')
      state.headerBytes = Buffer.byteLength(wireHeader, 'latin1')
    }
    return { opened: true }
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
    const rows = await prod.db.pool.query(`SELECT a.id::text, a.invocation_id, a.host_ref, a.request_hash, a.connection_id::text, a.status, t.status AS ticket_status, t.expires_at <= NOW() AS ticket_expired,
      r.id::text AS reservation_id, r.host_ref AS reservation_host_ref, r.budget_id::text
      FROM llm_provider_attempts a LEFT JOIN llm_provider_attempt_tickets t ON t.provider_attempt_id = a.id
      LEFT JOIN budget_pending_reservations r ON ${reservationJoin}
      WHERE a.invocation_id LIKE $1 AND a.host_ref = ANY($2::text[]) AND a.provider = 'grok-subscription'`, [`${options.runId}-%`, options.bindings.map((value: any) => value.hostRef)])
    const plan = ownedIssuedCleanupPlan(rows.rows, options.bindings, confirmed)
    // This existing Host endpoint releases only ephemeral reservations. It does
    // not manufacture a receipt, redeem a ticket, or rewrite the audit ledger.
    for (const reservation of plan.reservations) {
      const binding = options.bindings.find((value: any) => value.hostRef === reservation.hostRef)
      const response = await ordinary('POST', '/api/v1/internal/budgets/release', { host_ref: reservation.hostRef, reservationId: reservation.reservationId }, '', hostHeaders(binding))
      if (response.status !== 200 || !Number.isInteger(response.body?.released) || response.body.released < 0 || response.body.released > 1) throw new Error('owned reservation release refused')
      releasedReservationRows += response.body.released
    }
    for (const [rid, expected] of created) {
      const current = await ordinary('GET', `/api/v1/gfs/proxy/v1/resources/${rid}`)
      if (current.status !== 200 || current.body?.data?.resourceId !== expected.resourceId || current.body.data.name !== expected.name || current.body.data.parentResourceId !== expected.parentResourceId) throw new Error('GFS owner changed')
      const deleted = await ordinary('DELETE', `/api/v1/gfs/proxy/v1/resources/${rid}`)
      if (deleted.status !== 200 || deleted.body?.data?.deleted !== true) throw new Error('GFS cleanup failed')
      created.delete(rid)
    }
    const after = await counts()
    if (after.reservationRows || after.activeReservations || after.redeemedTickets || after.finalizedTickets || after.retainedAuthorizedAuditRows !== confirmed.size || after.tickets !== confirmed.size) throw new Error('issued cleanup incomplete')
    return { ...after, lifecycle: 'pg-issued-expiry-before-host-release', ownedGfsRemaining: created.size, releaseEndpoint: '/api/v1/internal/budgets/release', releasedReservationRows }
  }
  async function command(input: any): Promise<unknown> {
    if (input.kind === 'hello') { if (prod) throw new Error('private runtime binding cannot be replaced'); return hello(input.options) }
    if (!prod) throw new Error('runtime admission required')
    if (options.pressureOnly === true && !['open', 'close', 'owners', 'counts', 'health'].includes(input.kind)) throw new Error('pressure mode cannot advance business work')
    if (input.kind === 'open') return open(input)
    if (input.kind === 'end') { sockets.get(input.requestId)?.request.end(); return { ended: true } }
    if (input.kind === 'close') { const state = sockets.get(input.requestId); if (state) { state.closedByClient = true; state.request.destroy() }; return { clientClosed: true } }
    if (input.kind === 'counts') return counts()
    if (input.kind === 'owners') {
      const owner = await inspector.owners()
      const incomplete = [...sockets.values()].map(state => ({ requestId: state.input.requestId, acceptedWriteBytes: state.acceptedWriteBytes, declaredBytes: state.input.length, closedByClient: state.closedByClient }))
      if (incomplete.some(value => value.acceptedWriteBytes >= value.declaredBytes)) throw new Error('pressure body is not incomplete')
      const serverReads = options.pressureOnly === true ? await inspector.pressureReads([...sockets.values()].map(state => ({ requestId: state.input.requestId, headerBytes: state.headerBytes }))) : undefined
      if (serverReads && serverReads.pid !== owner.pid) throw new Error('pressure ownership/read observations changed process')
      return { ...owner, incompleteFixtureBodies: incomplete, serverReads }
    }
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
    if (input.kind === 'sample') { const server = await inspector.snapshot(); return { server: { ...server, nodeOptions: undefined, ...processCounts(server.pid) }, cgroup: cgroup() } }
    if (input.kind === 'gc') return { gc: await inspector.forceGc(), cgroup: cgroup() }
    if (input.kind === 'coverage-start') { await inspector.startCoverage(); return { started: true } }
    if (input.kind === 'coverage') return inspector.coverage()
    if (input.kind === 'coverage-stop') { await inspector.stopCoverage(); return { stopped: true } }
    if (input.kind === 'download') return download(input.rid)
    if (input.kind === 'health') return { status: (await ordinary('GET', '/health', undefined, '')).status }
    if (input.kind === 'cleanup') return cleanup()
    throw new Error('unknown command')
  }
  let header = Buffer.alloc(0), frame: Frame | undefined, remaining = 0
  try {
    for await (const chunk of process.stdin) {
      let offset = 0
      while (offset < chunk.length) {
        if (remaining) {
          if (!frame) throw new Error('body frame was not initialized')
          const length = Math.min(remaining, chunk.length - offset), state = sockets.get(frame.requestId!)
          if (!state) throw new Error('request closed before streaming completed')
          if (options.pressureOnly === true && (state.acceptedWriteBytes + length > 65536 || state.acceptedWriteBytes + length >= state.input.length)) throw new Error('pressure body cannot complete')
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
          const parsed: Frame = JSON.parse(header.toString()); frame = parsed; header = Buffer.alloc(0)
          if (parsed.kind === 'write') {
            if (!Number.isSafeInteger(parsed.length) || parsed.length! < 1 || parsed.length! > 65536) throw new Error('body frame bound exceeded')
            remaining = parsed.length!
          } else { try { emit({ callId: parsed.callId, data: await command(parsed) }) } catch { emit({ callId: parsed.callId, failed: true, code: 'REAL_RUNTIME_COMMAND_FAILED' }) } }
        }
      }
    }
    if (remaining || header.length) throw new Error('incomplete frame')
  } catch { emit({ fatal: true, code: 'COMPANION_PROTOCOL_FAILED' }); process.exitCode = 1 }
  finally { for (const state of sockets.values()) state.request.destroy(); await unlock().catch(() => {}); inspector?.close(); if (prod) await prod.db.pool.end().catch(() => {}); http.globalAgent.destroy() }
}
