/** Test-only QA preparation. The caller must prove an exclusive owned profile/DB,
 * current image/source marker and mutation lease before running this companion.
 * Opaque QA connection state is not real G8 evidence. No vendor is contacted.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { randomBytes, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

type SeedOptions = { runId: string; hostNamespace: string; operatorUser: string; operatorPassword?: string; cookie?: string }
const seedAssert = (condition: unknown, code: string) => { if (!condition) throw new Error(code) }
export function validateDesktopOperatorLink(controlAdminId: string, link: any) {
  const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  seedAssert(uuid(controlAdminId) && link?.controlAdminId === controlAdminId && uuid(link.desktopUserId) && link.desktopUserId !== controlAdminId && link.gfsOperatorLinkStatus === 'active', 'SEED_DESKTOP_OPERATOR_LINK_UNPROVED')
  return { desktopUserId: link.desktopUserId, gfsOperatorLinkStatus: link.gfsOperatorLinkStatus, generation: link.generation, rowVersion: link.rowVersion }
}
/** Credentials remain private fields in the in-pod process. The public request
 * interface returns neither session headers nor the underlying cookie value.
 */
export class PrivateCookieSession {
  #port: number; #db: any; #bootstrap: string; #runId: string; #operator: string
  #password?: string; #cookie?: string
  constructor(config: any, db: any, options: SeedOptions) {
    this.#port = config.port; this.#db = db; this.#bootstrap = config.adminBootstrapUsername
    this.#runId = options.runId; this.#operator = options.operatorUser
    this.#password = options.operatorPassword; this.#cookie = options.cookie
  }
  async #raw(method: string, route: string, body?: unknown, binary = false, anonymous = false): Promise<any> {
    seedAssert(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && (route.startsWith('/api/v1/admin/') || route.startsWith('/api/v1/gfs/')), 'SEED_REQUEST_OUTSIDE_API_BOUNDARY')
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: this.#port, method, path: route,
        headers: { 'content-type': 'application/json', ...(!anonymous && this.#cookie ? { cookie: `control_ui_admin_session=${this.#cookie}` } : {}) } }, res => {
        const chunks: Buffer[] = []; let bytes = 0
        res.on('data', chunk => { bytes += chunk.length; if (bytes > (binary ? 8 * 1024 * 1024 : 65536)) req.destroy(new Error('SEED_RESPONSE_BOUND')); else chunks.push(chunk) })
        res.on('end', () => { try { const data = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, ...(binary ? { bytes: data } : { json: bytes ? JSON.parse(data.toString()) : null }) }) } catch { reject(new Error('SEED_RESPONSE_INVALID')) } })
      })
      req.on('error', () => reject(new Error('SEED_HTTP_FAILED')))
      req.setTimeout(30000, () => req.destroy(new Error('SEED_HTTP_DEADLINE')))
      if (body) req.write(JSON.stringify(body)); req.end()
    })
  }
  #takeSession(response: any) {
    const value = (response.headers['set-cookie'] ?? []).find((item: string) => item.startsWith('control_ui_admin_session='))
    seedAssert(response.status === 200 && value, 'SEED_LOGIN_OR_SETUP_REFUSED')
    this.#cookie = value.split(';')[0].slice('control_ui_admin_session'.length + 1)
  }
  async authenticate() {
    let setupPerformed = false
    if (!this.#cookie) {
      seedAssert(typeof this.#password === 'string' && this.#password.length >= 8, 'SEED_PRIVATE_OPERATOR_MATERIAL_REQUIRED')
      const bootstrap = await this.#db.pool.query(`SELECT id::text, username, status, last_login_at FROM control_admin_users WHERE username = $1`, [this.#bootstrap])
      const active = await this.#db.pool.query("SELECT COUNT(*)::int AS count FROM control_admin_users WHERE status = 'active'")
      const eligible = bootstrap.rows.length === 1 && bootstrap.rows[0].status === 'active' && bootstrap.rows[0].last_login_at === null && active.rows[0].count === 1
      if (eligible) {
        seedAssert(this.#operator === `${this.#runId}-operator`, 'SEED_FIRST_RUN_OPERATOR_MUST_BE_OWNED')
        const collision = await this.#db.pool.query('SELECT COUNT(*)::int AS count FROM control_admin_users WHERE username = $1 OR lower(email) = lower($2)', [this.#operator, `${this.#runId}@example.invalid`])
        seedAssert(collision.rows[0].count === 0, 'SEED_INITIAL_OPERATOR_IDENTITY_COLLISION')
        this.#takeSession(await this.#raw('POST', '/api/v1/admin/auth/setup', { username: this.#operator, email: `${this.#runId}@example.invalid`, password: this.#password, seedDesktopPassword: true }, false, true))
        setupPerformed = true
      } else {
        this.#takeSession(await this.#raw('POST', '/api/v1/admin/auth/login', { username: this.#operator, password: this.#password }, false, true))
      }
      this.#password = undefined
    }
    const me = await this.#raw('GET', '/api/v1/admin/auth/me')
    seedAssert(me.status === 200 && me.json?.me?.username === this.#operator && me.json.me.role === 'admin', 'SEED_OPERATOR_IDENTITY_MISMATCH')
    const link = await this.#raw('GET', `/api/v1/admin/control-admins/${me.json.me.id}/gfs-operator-link`)
    seedAssert(link.status === 200, 'SEED_DESKTOP_OPERATOR_LINK_UNAVAILABLE')
    const identity = await this.#db.pool.query('SELECT email FROM control_admin_users WHERE id = $1', [me.json.me.id])
    seedAssert(identity.rows.length === 1 && typeof identity.rows[0].email === 'string' &&
      /^[^\s@]+@[^\s@]+$/.test(identity.rows[0].email), 'SEED_OPERATOR_EMAIL_UNPROVED')
    return { id: me.json.me.id, username: me.json.me.username, email: identity.rows[0].email,
      setupPerformed, ...validateDesktopOperatorLink(me.json.me.id, link.json) }
  }
  async request(input: { method: string; path: string; body?: unknown; binary?: boolean }) {
    const value = await this.#raw(input.method, input.path, input.body, input.binary === true)
    return input.binary === true ? { status: value.status, bytes: value.bytes } : { status: value.status, json: value.json }
  }
}
export function assertQaBudget(budget: any, hostRef: string, name: string): void {
  const scope = budget.scope
  seedAssert(budget.name === name && budget.enabled === true && budget.unit === 'tokens' && budget.currency === null && budget.enforcement === 'block' &&
    Number(budget.limit_amount) === 100 && Number(budget.max_task_amount) === 200 && Number(budget.min_start_amount) === 1 && budget.period === 'daily' && budget.timezone === 'UTC' &&
    scope && Object.keys(scope).length === 3 && scope.host_ref?.length === 1 && scope.host_ref[0] === hostRef && scope.provider?.length === 1 && scope.provider[0] === 'grok-subscription' && scope.model?.length === 1 && scope.model[0] === 'grok-4.6', 'QA_DANGER_ZONE_BUDGET_MISMATCH')
}
/** Planned QA identities only. Eligibility is proved from persisted catalogue
 * rows, the materialized production projection and the actual Host later.
 * One Host has one oauth-broker provider; its alternate uses the same grant.
 */
export function subscriptionImageSeedInputs(runId: string) {
  seedAssert(/^subscription-image-[a-f0-9]{12}$/.test(runId), 'IMAGE_SEED_RUN_INVALID')
  const suffix = runId.slice(-12)
  return ['grok', 'codex'].map(kind => ({
    provider: `${kind}-subscription`, connectionKey: `qa-image-${kind}-${suffix}`,
    hostRef: `qa-image-${kind}-${suffix}`, hostLabel: `qa-image-${kind}-${suffix}`,
    modelId: `qa-${kind}-image-${suffix}`, modelLabel: `QA ${kind} image ${suffix}`,
    unsupportedModelId: `qa-${kind}-text-${suffix}`, unsupportedModelLabel: `QA ${kind} text ${suffix}`,
    fallback: { provider: `${kind}-subscription`, modelId: `qa-${kind}-alternate-${suffix}` },
  }))
}

export async function prepareSubscriptionImageBindings({ prod, session, options, prepared, runId, state }: any) {
  seedAssert(prepared?.operatorDesktopUserId && prepared.operatorLink?.status === 'active' && state.length === 0,
    'IMAGE_SEED_PRIVATE_SESSION_REQUIRED')
  const context = await session.request({ method: 'GET', path: '/api/v1/admin/contexts/context1' })
  seedAssert(context.status === 200 && context.json?.metadata?.uid === prepared.context.uid &&
    !context.json.metadata.deletionTimestamp && Array.isArray(context.json.spec?.mcpServers) &&
    context.json.spec.mcpServers.length === 0, 'IMAGE_SEED_CONTEXT_CHANGED')
  const planned = subscriptionImageSeedInputs(runId)
  const result = []
  for (const input of planned) {
    const kind = input.provider.startsWith('grok') ? 'grok' : 'codex'
    const service = kind === 'grok' ? prod.connection : prod.codexConnection
    const fingerprint = `qa-image-${runId}-${kind}`
    const connection = await prod.db.withTransaction(async (tx: any) => {
      const found = await tx.query(`SELECT id FROM ${kind}_subscription_connections WHERE connection_key=$1`, [input.connectionKey])
      seedAssert(found.rows.length === 0, 'IMAGE_SEED_CONNECTION_COLLISION')
      // Opaque test-only material belongs to this isolated QA grant. A cached
      // access token is necessary: a refresh would escape the external fixture
      // boundary through Control API. This is never OAuth or G8 evidence.
      const credential = { refreshToken: randomBytes(32).toString('base64url'),
        accessToken: randomBytes(32).toString('base64url'),
        accessTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        accountFingerprint: fingerprint, status: 'connected',
        ...(kind === 'codex' ? { chatgptAccountId: `qa-image-${runId}` } : {}) }
      const create = kind === 'grok' ? service.insertInitialGrokSubscriptionConnection : service.insertInitialCodexSubscriptionConnection
      const row = await create(tx, prod.encryption.deriveOAuthEncryptionKey(prod.config.oauthEncryptionKey), credential, input.connectionKey)
      const publish = kind === 'grok' ? service.recordGrokCatalogOutcome : service.recordCodexCatalogOutcome
      const ready = await publish(tx, { connectionKey: input.connectionKey, catalogStatus: 'ready',
        connectionStatus: 'connected', expectedCredentialRevision: 1, expectedCatalogRevision: 0 })
      seedAssert(ready?.id === row.id && ready.catalogRevision === 1, 'IMAGE_SEED_CATALOG_REVISION_FAILED')
      for (const model of [input.modelId, input.unsupportedModelId, input.fallback.modelId]) {
        await tx.query(`INSERT INTO ${kind}_catalog_models (connection_id,model,enabled,source,discovered_at,last_seen_at,stale)
          VALUES ($1,$2,true,'manual',NOW(),NOW(),false)`, [row.id, model])
      }
      return ready
    })
    const owned = { ...input, runId, connectionId: connection.id, hostNamespace: options.hostNamespace,
      credentialRevision: connection.credentialRevision, catalogRevision: connection.catalogRevision }
    state.push(owned)
    const models = [input.modelId, input.unsupportedModelId, input.fallback.modelId]
    for (const [index, model] of models.entries()) {
      const capability = { state: index === 1 ? 'unsupported' : 'supported',
        evidence: { source: 'curated', reference: `evidence:${runId}`, checkedAt: new Date().toISOString() } }
      const body = { provider: input.provider, model, display_name: index === 0 ? input.modelLabel :
        index === 1 ? input.unsupportedModelLabel : `QA ${kind} alternate ${runId.slice(-12)}`,
        enabled: true, image_input: capability }
      const created = await session.request({ method: 'POST', path: '/api/v1/admin/llm-models', body })
      seedAssert(created.status === 201 && created.json?.provider === input.provider && created.json.model === model &&
        created.json.enabled === true && isDeepStrictEqual(created.json.image_input, capability), 'IMAGE_SEED_MODEL_API_FAILED')
      const durable = await session.request({ method: 'GET', path: `/api/v1/admin/llm-models/${created.json.id}` })
      seedAssert(durable.status === 200 && isDeepStrictEqual(durable.json.image_input, capability), 'IMAGE_SEED_MODEL_NOT_DURABLE')
    }
    await prod.gateway.llmAllowedModelsConfigMap().materialize()
    const spec = { host: input.hostRef, contextRef: 'context1', desktop: { x11: true, browser: false },
      model: { provider: input.provider, name: input.modelId, connectionRef: input.connectionKey },
      allowedModels: models.map(model => ({ provider: input.provider, model })),
      llmPolicy: { fallbacks: [{ provider: input.provider, model: input.fallback.modelId }] } }
    const created = await session.request({ method: 'POST', path: '/api/v1/admin/hosts',
      body: { metadata: { name: input.hostRef, labels: { 'evenfire.io/qa-image-run': runId } }, spec } })
    seedAssert(created.status === 201 && /^[a-f0-9-]{36}$/.test(created.json?.metadata?.uid) &&
      created.json.metadata.namespace === options.hostNamespace &&
      created.json.metadata.labels?.['evenfire.io/qa-image-run'] === runId &&
      isDeepStrictEqual(created.json.spec.model, spec.model) && isDeepStrictEqual(created.json.spec.allowedModels, spec.allowedModels) &&
      isDeepStrictEqual(created.json.spec.llmPolicy?.fallbacks, spec.llmPolicy.fallbacks), 'IMAGE_SEED_ACTUAL_HOST_FAILED')
    Object.assign(owned, { hostUid: created.json.metadata.uid, runId, spec })
    const durable = await session.request({ method: 'GET', path: `/api/v1/admin/hosts/${input.hostRef}` })
    seedAssert(durable.status === 200 && durable.json?.metadata?.uid === owned.hostUid &&
      isDeepStrictEqual(durable.json.spec.model, spec.model) && isDeepStrictEqual(durable.json.spec.llmPolicy?.fallbacks, spec.llmPolicy.fallbacks),
      'IMAGE_SEED_HOST_NOT_DURABLE')
    result.push({ ...input, hostNamespace: options.hostNamespace, hostUid: owned.hostUid,
      connectionId: connection.id, credentialRevision: connection.credentialRevision, catalogRevision: connection.catalogRevision,
      catalogueModels: models, catalogProjectionPublished: true })
  }
  return { kind: 'evenfire-subscription-image-qa-bindings-v1', runId, bindings: result,
    operatorDesktopUserId: prepared.operatorDesktopUserId, loginEmail: prepared.operatorEmail,
    credentialState: 'opaque-qa-not-real-G8', vendorCronsDisabled: true, upstreamDispatch: 'NOT_RUN' }
}

export async function revokeSubscriptionImageBindings({ prod, session, state }: any) {
  for (const binding of state) {
    if (binding.hostUid) {
      const current = await session.request({ method: 'GET', path: `/api/v1/admin/hosts/${binding.hostRef}` })
      seedAssert(current.status === 200 && current.json?.metadata?.uid === binding.hostUid &&
        current.json.metadata.labels?.['evenfire.io/qa-image-run'] === binding.runId &&
        isDeepStrictEqual(current.json.spec.model, binding.spec.model) &&
        isDeepStrictEqual(current.json.spec.llmPolicy?.fallbacks, binding.spec.llmPolicy.fallbacks), 'IMAGE_SEED_HOST_RESTORE_CONFLICT')
      const detached = await session.request({ method: 'PUT', path: `/api/v1/admin/hosts/${binding.hostRef}`,
        body: { metadata: { uid: binding.hostUid, resourceVersion: current.json.metadata.resourceVersion,
          labels: current.json.metadata.labels }, spec: { ...current.json.spec,
          model: { ...current.json.spec.model, connectionRef: 'unassigned' }, llmPolicy: { fallbacks: [] } } } })
      seedAssert(detached.status === 200 && detached.json?.metadata?.uid === binding.hostUid &&
        isDeepStrictEqual(detached.json.spec?.model, { ...binding.spec.model, connectionRef: 'unassigned' }) &&
        Array.isArray(detached.json.spec?.llmPolicy?.fallbacks) && detached.json.spec.llmPolicy.fallbacks.length === 0,
        'IMAGE_SEED_HOST_DETACH_FAILED')
    }
    const kind = binding.provider.startsWith('grok') ? 'grok' : 'codex'
    await prod.db.withTransaction(async (tx: any) => {
      const current = await tx.query(`SELECT id::text,credential_revision,account_fingerprint FROM ${kind}_subscription_connections
        WHERE connection_key=$1 AND revoked_at IS NULL FOR UPDATE`, [binding.connectionKey])
      seedAssert(current.rows.length === 1 && current.rows[0].id === binding.connectionId &&
        Number(current.rows[0].credential_revision) === 1 && current.rows[0].account_fingerprint === `qa-image-${binding.runId}-${kind}`,
        'IMAGE_SEED_GRANT_RESTORE_CONFLICT')
      const service = kind === 'grok' ? prod.connection : prod.codexConnection
      const revoke = kind === 'grok' ? service.revokeGrokSubscriptionConnection : service.revokeCodexSubscriptionConnection
      const value = await revoke(tx, binding.connectionKey)
      seedAssert(value?.id === binding.connectionId && value.status === 'revoked', 'IMAGE_SEED_GRANT_REVOKE_FAILED')
    })
  }
  await prod.gateway.llmAllowedModelsConfigMap().materialize()
  return { verified: true, grantsRevoked: state.length, hostsDetached: state.filter((value: any) => value.hostUid).length,
    retainedQaData: true, realOAuthOrG8: 'NOT_RUN' }
}
/** Resume the retained memory fixtures, not a prior image run's detached and
 * revoked QA bindings. A later image suite creates a fresh qa-image run below.
 */
export async function resumeMemoryFixtures({ prod, session, options, expected, operator }: any) {
  seedAssert(/^pr806-memory-[a-f0-9]{12}$/.test(options.runId) && expected?.fixtureCredentialState === 'opaque-qa-not-real-G8' &&
    expected.bindings?.length === 2, 'SEED_RESUME_RECEIPT_INVALID')
  seedAssert(operator.id === expected.operatorId && operator.desktopUserId === expected.operatorDesktopUserId &&
    operator.username === expected.operatorUsername, 'SEED_RESUME_OPERATOR_CHANGED')
  const request = async (route: string) => session.request({ method: 'GET', path: route })
  const context = await request('/api/v1/admin/contexts/context1')
  seedAssert(context.status === 200 && context.json?.metadata?.uid === expected.context.uid &&
    !context.json.metadata.deletionTimestamp && Array.isArray(context.json.spec?.mcpServers) && context.json.spec.mcpServers.length === 0,
    'SEED_RESUME_CONTEXT_CHANGED')
  for (const [index, binding] of expected.bindings.entries()) {
    seedAssert(binding.hostRef === ['pr806-memory-grok-host', 'pr806-memory-grok-host-2'][index] &&
      binding.connectionKey === `${options.runId}-grok-${index + 1}`, 'SEED_RESUME_BINDING_FOREIGN')
    const host = await request(`/api/v1/admin/hosts/${binding.hostRef}`)
    seedAssert(host.status === 200 && host.json?.metadata?.uid === binding.hostUid &&
      host.json.metadata.namespace === options.hostNamespace && host.json.metadata.labels?.['evenfire.io/qa-memory-run'] === options.runId &&
      host.json.spec.contextRef === 'context1' && host.json.spec.model?.provider === 'grok-subscription' &&
      host.json.spec.model.name === 'grok-4.6' && host.json.spec.model.connectionRef === binding.connectionKey, 'SEED_RESUME_HOST_CHANGED')
    const grant = await prod.connection.getSafeGrokSubscriptionConnection(prod.db.pool, binding.connectionKey)
    seedAssert(grant?.id === binding.connectionId && grant.status === 'connected' && grant.catalogStatus === 'ready' &&
      grant.credentialRevision === 1 && grant.catalogRevision === 1 &&
      grant.accountFingerprint === `qa-memory-${options.runId}-${index + 1}`, 'SEED_RESUME_GRANT_CHANGED')
    const budget = await request(`/api/v1/admin/budgets/${binding.budgetId}`)
    seedAssert(budget.status === 200, 'SEED_RESUME_BUDGET_MISSING'); assertQaBudget(budget.json, binding.hostRef, binding.budgetName)
  }
  const directory = await request(`/api/v1/gfs/proxy/v1/resources/${expected.gfs.parentRid}`)
  seedAssert(directory.status === 200 && directory.json?.data?.resourceId === expected.gfs.parentResourceId &&
    directory.json.data.kind === 'directory' && directory.json.data.name === options.runId, 'SEED_RESUME_GFS_CHANGED')
  return { ...expected, operatorEmail: operator.email }
}

/** Final scope release, after all suites/cgroup windows. Keep audit/budget/GFS
 * rows, but detach and revoke the two exact memory QA bindings before crons can
 * resume. This makes later reuse fail closed rather than spending opaque QA.
 */
export async function revokeMemoryFixtures({ prod, session, options, prepared }: any) {
  seedAssert(prepared?.bindings?.length === 2, 'MEMORY_QA_RELEASE_RECEIPT_REQUIRED')
  for (const [index, binding] of prepared.bindings.entries()) {
    seedAssert(binding.hostRef === ['pr806-memory-grok-host', 'pr806-memory-grok-host-2'][index] &&
      binding.connectionKey === `${options.runId}-grok-${index + 1}`, 'MEMORY_QA_RELEASE_FOREIGN_BINDING')
    const current = await session.request({ method: 'GET', path: `/api/v1/admin/hosts/${binding.hostRef}` })
    const expected = { provider: 'grok-subscription', name: 'grok-4.6', connectionRef: binding.connectionKey }
    seedAssert(current.status === 200 && current.json?.metadata?.uid === binding.hostUid &&
      current.json.metadata.labels?.['evenfire.io/qa-memory-run'] === options.runId &&
      isDeepStrictEqual(current.json.spec.model, expected), 'MEMORY_QA_RELEASE_HOST_CHANGED')
    const detached = await session.request({ method: 'PUT', path: `/api/v1/admin/hosts/${binding.hostRef}`,
      body: { metadata: { uid: binding.hostUid, resourceVersion: current.json.metadata.resourceVersion, labels: current.json.metadata.labels },
        spec: { ...current.json.spec, model: { ...expected, connectionRef: 'unassigned' }, llmPolicy: { fallbacks: [] } } } })
    seedAssert(detached.status === 200 && detached.json?.metadata?.uid === binding.hostUid &&
      isDeepStrictEqual(detached.json.spec?.model, { ...expected, connectionRef: 'unassigned' }) &&
      Array.isArray(detached.json.spec?.llmPolicy?.fallbacks) && detached.json.spec.llmPolicy.fallbacks.length === 0,
      'MEMORY_QA_RELEASE_DETACH_UNPROVED')
    await prod.db.withTransaction(async (tx: any) => {
      const observed = await tx.query(`SELECT id::text,credential_revision,account_fingerprint FROM grok_subscription_connections
        WHERE connection_key=$1 AND revoked_at IS NULL FOR UPDATE`, [binding.connectionKey])
      seedAssert(observed.rows.length === 1 && observed.rows[0].id === binding.connectionId &&
        Number(observed.rows[0].credential_revision) === 1 &&
        observed.rows[0].account_fingerprint === `qa-memory-${options.runId}-${index + 1}`, 'MEMORY_QA_RELEASE_GRANT_CHANGED')
      const revoked = await prod.connection.revokeGrokSubscriptionConnection(tx, binding.connectionKey)
      seedAssert(revoked?.id === binding.connectionId && revoked.status === 'revoked', 'MEMORY_QA_RELEASE_GRANT_UNPROVED')
    })
  }
  await prod.gateway.llmAllowedModelsConfigMap().materialize()
  return { verified: true, state: 'revoked', grantsRevoked: 2, hostsDetached: 2,
    connectionIds: prepared.bindings.map((binding: any) => binding.connectionId),
    hostUids: prepared.bindings.map((binding: any) => binding.hostUid), retainedAuditAndQaData: true }
}

export async function runSeedCompanion(actions: { prepareGfsImages?: (input: any) => Promise<unknown> } = {}): Promise<void> {
  const output = process.stdout.write.bind(process.stdout)
  process.stdout.write = () => true; process.stderr.write = () => true
  process.env.LOG_LEVEL = 'silent'
  const emit = (value: unknown) => output(JSON.stringify(value) + '\n')
  const require = createRequire(path.join(process.cwd(), 'package.json'))
  let prod: any, options: SeedOptions, phase = 'private-input', input = Buffer.alloc(0)
  let session: PrivateCookieSession
  let prepared: any
  const imageState: any[] = []
  async function request(method: string, route: string, body?: unknown): Promise<any> { const value = await session.request({ method, path: route, body }); return { status: value.status, body: value.json } }
  async function resume(expected: any) {
    seedAssert(/^pr806-memory-[a-f0-9]{12}$/.test(options.runId) && expected?.fixtureCredentialState === 'opaque-qa-not-real-G8' &&
      expected.bindings?.length === 2, 'SEED_RESUME_RECEIPT_INVALID')
    prod = { config: require('./dist/config.js').config, db: require('./dist/db.js'),
      connection: require('./dist/services/grokSubscriptionConnection.js'), codexConnection: require('./dist/services/codexSubscriptionConnection.js'),
      encryption: require('./dist/oauth/encryption.js'), gateway: new (require('./dist/k8s.js').K8sGateway)() }
    seedAssert(prod.config.hostsNamespace === options.hostNamespace && prod.config.grokSubscriptionEnabled && prod.config.codexSubscriptionEnabled &&
      prod.config.subscriptionCatalogSyncCronEnabled === false && prod.config.llmCatalogSyncCronEnabled === false, 'SEED_RESUME_RUNTIME_INVALID')
    session = new PrivateCookieSession(prod.config, prod.db, options)
    const operator = await session.authenticate()
    options.operatorPassword = undefined; options.cookie = undefined
    return resumeMemoryFixtures({ prod, session, options, expected, operator })
  }
  async function prepare() {
    seedAssert(/^pr806-memory-[a-f0-9]{12}$/.test(options.runId), 'SEED_RUN_ID_INVALID')
    prod = { config: require('./dist/config.js').config, db: require('./dist/db.js'),
      connection: require('./dist/services/grokSubscriptionConnection.js'),
      codexConnection: require('./dist/services/codexSubscriptionConnection.js'), encryption: require('./dist/oauth/encryption.js'),
      gateway: new (require('./dist/k8s.js').K8sGateway)() }
    seedAssert(prod.config.hostsNamespace === options.hostNamespace && prod.config.grokSubscriptionEnabled && prod.config.codexSubscriptionEnabled, 'SEED_PROVIDER_OR_NAMESPACE_MISMATCH')
    seedAssert(prod.config.subscriptionCatalogSyncCronEnabled === false && prod.config.llmCatalogSyncCronEnabled === false, 'SEED_VENDOR_CRON_MUST_BE_DISABLED')
    phase = 'operator-session'
    session = new PrivateCookieSession(prod.config, prod.db, options)
    const operator = await session.authenticate()
    options.operatorPassword = undefined; options.cookie = undefined
    phase = 'context-binding'
    const context = await request('GET', '/api/v1/admin/contexts/context1')
    seedAssert(context.status === 200 && context.body?.metadata?.name === 'context1' && context.body.metadata.namespace === prod.config.contextsNamespace && /^[a-f0-9-]{36}$/.test(context.body.metadata.uid) &&
      !context.body.metadata.deletionTimestamp && typeof context.body.metadata.resourceVersion === 'string' && context.body.spec?.contextId === 'context1', 'SEED_CONTEXT1_UNPROVED')
    // A new Host boots MCP inventory. Empty actual inventory prevents that boot
    // from connecting external services; stateless/suspend is not a shortcut.
    seedAssert(Array.isArray(context.body.spec?.mcpServers) && context.body.spec.mcpServers.length === 0, 'SEED_CONTEXT1_VENDOR_FREE_INVENTORY_UNPROVED')
    const bindings = []
    for (const [index, hostRef] of ['pr806-memory-grok-host', 'pr806-memory-grok-host-2'].entries()) {
      const connectionKey = `${options.runId}-grok-${index + 1}`, fingerprint = `qa-memory-${options.runId}-${index + 1}`
      phase = `connection-${index + 1}`
      await prod.db.withTransaction(async (tx: any) => {
        const existing = await tx.query('SELECT id::text, account_fingerprint, credential_revision, catalog_revision, status, catalog_status, revoked_at FROM grok_subscription_connections WHERE connection_key = $1', [connectionKey])
        if (existing.rows.length) {
          const row = existing.rows[0]
          seedAssert(existing.rows.length === 1 && row.account_fingerprint === fingerprint && row.credential_revision === 1 && row.catalog_revision === 1 && row.status === 'connected' && row.catalog_status === 'ready' && row.revoked_at === null, 'SEED_EXISTING_CONNECTION_CHANGED')
        } else {
          const created = await prod.connection.insertInitialGrokSubscriptionConnection(tx, prod.encryption.deriveOAuthEncryptionKey(prod.config.oauthEncryptionKey),
            { refreshToken: randomBytes(32).toString('base64url'), accountFingerprint: fingerprint, status: 'connected' }, connectionKey)
          const ready = await prod.connection.recordGrokCatalogOutcome(tx, { connectionKey, catalogStatus: 'ready', connectionStatus: 'connected', expectedCredentialRevision: 1, expectedCatalogRevision: 0 })
          seedAssert(ready?.id === created.id && ready.catalogRevision === 1, 'SEED_CATALOG_REVISION_GUARD_FAILED')
          await tx.query(`INSERT INTO grok_catalog_models (connection_id, model, enabled, source, discovered_at, last_seen_at, stale)
            VALUES ($1, 'grok-4.6', true, 'discovery', NOW(), NOW(), false)`, [created.id])
        }
      })
      const connection = await prod.connection.getSafeGrokSubscriptionConnection(prod.db.pool, connectionKey)
      const catalog = await prod.db.pool.query("SELECT enabled, stale FROM grok_catalog_models WHERE connection_id = $1 AND model = 'grok-4.6'", [connection.id])
      seedAssert(connection.status === 'connected' && connection.catalogStatus === 'ready' && catalog.rows.length === 1 && catalog.rows[0].enabled === true && catalog.rows[0].stale === false, 'SEED_CATALOG_WITNESS_MISSING')
      // HCC consumes the production per-connection ConfigMap projection. Ready
      // PostgreSQL state alone does not publish that runtime contract.
      await prod.gateway.llmAllowedModelsConfigMap().materialize()
      phase = `budget-${index + 1}`
      const budgetName = `${options.runId}-${hostRef}-budget`
      const found = await prod.db.pool.query('SELECT id::text, name, enabled, scope, unit, currency, enforcement, limit_amount, max_task_amount, min_start_amount, period, timezone FROM token_budgets WHERE name = $1', [budgetName])
      let budget
      if (found.rows.length) {
        seedAssert(found.rows.length === 1, 'SEED_BUDGET_NAME_AMBIGUOUS'); budget = found.rows[0]
      } else {
        const created = await request('POST', '/api/v1/admin/budgets', { name: budgetName, enabled: true, scope: { host_ref: [hostRef], provider: ['grok-subscription'], model: ['grok-4.6'] },
          unit: 'tokens', currency: null, limit_amount: 100, max_task_amount: 200, min_start_amount: 1, period: 'daily', timezone: 'UTC', enforcement: 'block' })
        seedAssert(created.status === 201, 'SEED_BUDGET_API_REFUSED'); budget = created.body
      }
      assertQaBudget(budget, hostRef, budgetName)
      const storedBudget = await request('GET', `/api/v1/admin/budgets/${budget.id}`)
      seedAssert(storedBudget.status === 200, 'SEED_BUDGET_NOT_DURABLE'); assertQaBudget(storedBudget.body, hostRef, budgetName)
      phase = `host-${index + 1}`
      const contextNow = await request('GET', '/api/v1/admin/contexts/context1')
      seedAssert(contextNow.status === 200 && contextNow.body?.metadata?.uid === context.body.metadata.uid && contextNow.body.metadata.resourceVersion === context.body.metadata.resourceVersion &&
        !contextNow.body.metadata.deletionTimestamp && Array.isArray(contextNow.body.spec?.mcpServers) && contextNow.body.spec.mcpServers.length === 0, 'SEED_CONTEXT_CHANGED_BEFORE_HOST_CREATE')
      let host = await request('GET', `/api/v1/admin/hosts/${hostRef}`), createdHost = false
      if (host.status === 404) {
        host = await request('POST', '/api/v1/admin/hosts', { metadata: { name: hostRef, labels: { 'evenfire.io/qa-memory-run': options.runId } },
          spec: { host: hostRef, contextRef: 'context1', desktop: { x11: true, browser: false }, model: { provider: 'grok-subscription', name: 'grok-4.6', connectionRef: connectionKey }, allowedModels: [{ provider: 'grok-subscription', model: 'grok-4.6' }] } })
        seedAssert(host.status === 201, 'SEED_HOST_API_REFUSED'); createdHost = true
      }
      const value = host.body
      seedAssert((host.status === 200 || host.status === 201) && value?.metadata?.name === hostRef && value.metadata.namespace === options.hostNamespace && /^[a-f0-9-]{36}$/.test(value.metadata.uid) &&
        value.metadata.labels?.['evenfire.io/qa-memory-run'] === options.runId && value.spec?.host === hostRef && value.spec.contextRef === 'context1' && value.spec.model?.provider === 'grok-subscription' && value.spec.model.name === 'grok-4.6' && value.spec.model.connectionRef === connectionKey &&
        value.spec.desktop?.x11 === true && value.spec.desktop.browser === false && value.spec.allowedModels?.length === 1 && value.spec.allowedModels[0].provider === 'grok-subscription' && value.spec.allowedModels[0].model === 'grok-4.6', 'SEED_EXISTING_HOST_OWNER_OR_SPEC_CHANGED')
      bindings.push({ hostRef, hostUid: value.metadata.uid, connectionKey, connectionId: connection.id, credentialRevision: connection.credentialRevision, catalogRevision: connection.catalogRevision, budgetId: budget.id, budgetName, reservationAmount: 200, hostCreateStatus: createdHost ? 201 : 200, catalogProjectionPublished: true })
    }
    phase = 'gfs-owned-directory'
    const root = await request('GET', '/api/v1/gfs/by-path?drive=main&path=%2F')
    seedAssert(root.status === 200 && root.body?.drive === 'main' && root.body.kind === 'directory' && root.body.path === '/' && /^[a-f0-9]{32}$/.test(root.body.rid), 'SEED_GFS_ROOT_UNPROVED')
    const statRoot = await request('GET', `/api/v1/gfs/proxy/v1/resources/${root.body.rid}`)
    seedAssert(statRoot.status === 200 && statRoot.body?.data?.resourceId === root.body.resourceId && statRoot.body.data.parentResourceId === null && statRoot.body.data.drive === 'main', 'SEED_GFS_ROOT_NOT_CANONICAL')
    const existingDirectory = await request('GET', `/api/v1/gfs/by-path?drive=main&path=${encodeURIComponent('/' + options.runId)}`)
    seedAssert(existingDirectory.status === 404, 'SEED_GFS_DIRECTORY_ALREADY_EXISTS_NO_OVERWRITE')
    const directory = await request('POST', `/api/v1/gfs/proxy/v1/resources/${root.body.rid}/children`, { name: options.runId, kind: 'directory' })
    seedAssert(directory.status === 201 && directory.body?.ok === true && directory.body.data.name === options.runId && directory.body.data.kind === 'directory' && directory.body.data.parentResourceId === root.body.resourceId && directory.body.data.drive === 'main', 'SEED_GFS_DIRECTORY_CREATE_FAILED')
    const parent = await request('GET', `/api/v1/gfs/proxy/v1/resources/${directory.body.data.rid}`)
    seedAssert(parent.status === 200 && parent.body?.data?.resourceId === directory.body.data.resourceId && parent.body.data.name === options.runId && parent.body.data.parentResourceId === root.body.resourceId, 'SEED_GFS_DIRECTORY_NOT_DURABLE')
    phase = 'complete'
    return { fixtureCredentialState: 'opaque-qa-not-real-G8', upstreamDispatch: 'NOT_RUN', operatorUsername: operator.username, operatorEmail: operator.email,
      operatorId: operator.id, operatorDesktopUserId: operator.desktopUserId,
      operatorLink: { status: operator.gfsOperatorLinkStatus, generation: operator.generation, rowVersion: operator.rowVersion }, setupPerformed: operator.setupPerformed,
      context: { name: 'context1', namespace: context.body.metadata.namespace, uid: context.body.metadata.uid, resourceVersion: context.body.metadata.resourceVersion, mcpServers: [] }, bindings,
      gfs: { drive: 'main', rootRid: root.body.rid, rootResourceId: root.body.resourceId, parentRid: directory.body.data.rid, parentResourceId: directory.body.data.resourceId, name: options.runId, createStatus: 201, durableReadStatus: 200 },
      budgetCache: { definitionsTtlMs: 5000, strategy: 'benchmark-requires-new-actual-api-pod-before-first-authorize', resetHelperCalled: false },
      vendorCronsDisabled: true, compiledPolicySha256: createHash('sha256').update(fs.readFileSync('./dist/middleware/llmProviderAttemptAdmissionLimits.js')).digest('hex') }
  }
  let handled = false
  try {
    for await (const chunk of process.stdin) {
      input = Buffer.concat([input, chunk]); seedAssert(input.length <= 4 * 1024 * 1024, 'SEED_PRIVATE_INPUT_BOUND')
      const end = input.indexOf(10); if (end < 0) continue
      for (let newline; (newline = input.indexOf(10)) >= 0;) {
      const line = input.subarray(0, newline)
      const frame = JSON.parse(line.toString()); line.fill(0); input = Buffer.from(input.subarray(newline + 1))
      seedAssert(['prepare', 'resume', 'prepare-gfs-images', 'prepare-subscription-images', 'revoke-subscription-images', 'revoke-memory-fixtures'].includes(frame.kind) && typeof frame.callId === 'string', 'SEED_PRIVATE_COMMAND_INVALID')
      handled = true
      try {
        if (frame.kind === 'prepare' || frame.kind === 'resume') {
          seedAssert(!session, 'SEED_PRIVATE_SESSION_ALREADY_PREPARED')
          options = frame.options; prepared = frame.kind === 'prepare' ? await prepare() : await resume(frame.input?.fixtures)
          emit({ callId: frame.callId, data: prepared })
        } else if (frame.kind === 'prepare-subscription-images') {
          seedAssert(session && prepared && !frame.options, 'IMAGE_SEED_PRIVATE_SESSION_REQUIRED')
          emit({ callId: frame.callId, data: await prepareSubscriptionImageBindings({ prod, session, options, prepared,
            runId: frame.input?.runId, state: imageState }) })
        } else if (frame.kind === 'revoke-subscription-images') {
          seedAssert(session && prepared && !frame.options, 'IMAGE_SEED_PRIVATE_SESSION_REQUIRED')
          emit({ callId: frame.callId, data: await revokeSubscriptionImageBindings({ prod, session, state: imageState }) })
        } else if (frame.kind === 'revoke-memory-fixtures') {
          seedAssert(session && prepared && !frame.options, 'MEMORY_QA_RELEASE_PRIVATE_SESSION_REQUIRED')
          emit({ callId: frame.callId, data: await revokeMemoryFixtures({ prod, session, options, prepared }) })
        } else {
          seedAssert(actions.prepareGfsImages, 'GFS_FIXTURE_ACTION_NOT_INSTALLED')
          if (!session) {
            options = frame.options; prod = { config: require('./dist/config.js').config, db: require('./dist/db.js') }
            seedAssert(/^pr806-memory-[a-f0-9]{12}$/.test(options.runId) && options.hostNamespace === prod.config.hostsNamespace, 'GFS_FIXTURE_BINDING_INVALID')
            session = new PrivateCookieSession(prod.config, prod.db, options); await session.authenticate()
          } else seedAssert(!frame.options, 'SEED_PRIVATE_SESSION_CANNOT_BE_REBOUND')
          emit({ callId: frame.callId, data: await actions.prepareGfsImages!({ ...frame.input, session }) })
        }
      }
      catch (error: any) { emit({ callId: frame.callId, failed: true, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SEED_REAL_RUNTIME_FAILED', phase }); process.exitCode = 1 }
      }
    }
    seedAssert(handled, 'SEED_PRIVATE_INPUT_MISSING')
    seedAssert(input.length === 0, 'SEED_PRIVATE_PARTIAL_COMMAND')
  } catch { emit({ fatal: true, code: 'SEED_PRIVATE_PROTOCOL_FAILED', phase }); process.exitCode = 1 }
  finally { if (prod) await prod.db.pool.end().catch(() => {}); http.globalAgent.destroy() }
}
