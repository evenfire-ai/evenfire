#!/usr/bin/env node
/** Experimental real Control API HTTP/PG/cgroup calibration. A complete receipt is not activation authorization. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import { buildAuthorizeFixture, buildRejectedFixture, buildGfsFixture, SHAPES, MIB, sha256 } from './lib/control-api-authorize-memory-fixtures.mjs'
import { pressureCommandDeadlineMs } from '../e2e/fixtures/subscription-image-admission-pressure.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NAMESPACE = 'control-plane', DEPLOYMENT = 'control-api', CONTAINER = 'control-api'
const sleepPoll = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, code) => { if (!condition) throw new Error(code) }
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
function readOwnedJson(file, maxBytes = 65536) {
  const stat = fs.lstatSync(file)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size > 0 && stat.size <= maxBytes, 'OWNED_PRIVATE_JSON_REQUIRED')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
export function validateFixtureReceipt(record, binding) {
  const value = record.fixtures
  assert(record.kind === 'control-api-authorize-memory-fixtures.v1' && record.status === 'complete' && record.producer?.code === 0 && !record.producer.signal &&
    record.options?.profile === binding.profile && record.options.context === binding.context && record.options.runId === binding.runId && record.options.hostNamespace === binding.hostNamespace &&
    /^[a-f0-9]{40}$/.test(record.source?.head ?? '') && /^[a-f0-9]{40}$/.test(record.source.worktreeId ?? '') && typeof record.source.clusterFingerprint === 'string' && record.source.clusterFingerprint.length > 0 &&
    Number.isFinite(Date.parse(record.startedAt)) && Date.parse(record.finishedAt) >= Date.parse(record.startedAt), 'COMPLETE_OWNED_FIXTURE_RECEIPT_REQUIRED')
  assert(value?.fixtureCredentialState === 'opaque-qa-not-real-G8' && value.upstreamDispatch === 'NOT_RUN' && value.vendorCronsDisabled === true &&
    value.context?.name === 'context1' && uuid(value.context.uid) && Array.isArray(value.context.mcpServers) && value.context.mcpServers.length === 0 && value.bindings?.length === 2 &&
    value.gfs?.drive === 'main' && value.gfs.name === binding.runId && value.gfs.createStatus === 201 && value.gfs.durableReadStatus === 200 && /^[a-f0-9]{32}$/.test(value.gfs.parentRid ?? '') && uuid(value.gfs.parentResourceId), 'REAL_QA_FIXTURE_STATE_REQUIRED')
  const refs = ['pr806-memory-grok-host', 'pr806-memory-grok-host-2']
  const hosts = value.bindings.map((item, index) => {
    assert(item.hostRef === refs[index] && uuid(item.hostUid) && uuid(item.budgetId) && uuid(item.connectionId) && item.connectionKey === `${binding.runId}-grok-${index + 1}` &&
      item.credentialRevision === 1 && item.catalogRevision === 1 && item.reservationAmount === 200 && item.catalogProjectionPublished === true, 'FIXTURE_HOST_BINDING_INVALID')
    return { hostRef: item.hostRef, hostUid: item.hostUid, budgetId: item.budgetId, connectionKey: item.connectionKey, connectionId: item.connectionId }
  })
  assert(new Set(hosts.map(item => item.budgetId)).size === 2 && typeof value.operatorUsername === 'string' && /^[A-Za-z0-9_.-]{3,64}$/.test(value.operatorUsername), 'FIXTURE_OPERATOR_OR_BUDGET_INVALID')
  if (value.operatorDesktopUserId !== undefined) assert(uuid(value.operatorDesktopUserId) && value.operatorDesktopUserId !== value.operatorId && value.operatorLink?.status === 'active', 'FIXTURE_DESKTOP_OPERATOR_ID_INVALID')
  return { worktreeId: record.source.worktreeId, clusterFingerprint: record.source.clusterFingerprint, hosts, parentRid: value.gfs.parentRid,
    parentResourceId: value.gfs.parentResourceId, operatorUser: value.operatorUsername, operatorDesktopUserId: value.operatorDesktopUserId, contextUid: value.context.uid, seedPodUid: record.podUid }
}
export function parseOptions(args, env = process.env) {
  const fields = {}, flags = new Set(['inspect-plan', 'include-legacy-gfs', 'prepare-fixtures'])
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; assert(/^--[a-z-]+$/.test(key), 'INVALID_ARGUMENT')
    const name = key.slice(2); assert(!(name in fields), 'DUPLICATE_ARGUMENT')
    if (flags.has(name)) fields[name] = true
    else { assert(args[index + 1] && !args[index + 1].startsWith('--'), 'MISSING_ARGUMENT_VALUE'); fields[name] = args[++index] }
  }
  const allowed = ['config', 'profile', 'context', 'run-id', 'host-namespace', 'budget-ids', 'gfs-parent-rid', 'fixtures-receipt', 'operator-user', 'heap-size-mib', 'concurrency', 'read-deadline-ms', 'work-deadline-ms', 'close-grace-ms', 'runs', 'cgroup-limit-mib', 'shape', 'report', 'prepare', 'inspector-port', ...flags]
  for (const key of Object.keys(fields)) assert(allowed.includes(key), 'UNKNOWN_ARGUMENT')
  if (fields.config) {
    assert(Object.keys(fields).every(key => key === 'config' || flags.has(key)), 'CONFIG_ARGUMENT_CONFLICT')
    const stat = fs.lstatSync(fields.config); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077) && stat.size < 32768, 'CONFIG_NOT_PRIVATE_OWNED')
    const input = JSON.parse(fs.readFileSync(fields.config, 'utf8'))
    assert(input.kind === 'control-api-authorize-memory-config.v1', 'CONFIG_KIND_INVALID')
    const converted = []
    for (const [key, value] of Object.entries(input.arguments)) { assert(allowed.includes(key) && key !== 'config', 'CONFIG_FIELD_INVALID'); converted.push(`--${key}`); if (!flags.has(key)) converted.push(String(value)); else assert(value === true, 'CONFIG_FLAG_INVALID') }
    for (const flag of flags) if (fields[flag] && !converted.includes(`--${flag}`)) converted.push(`--${flag}`)
    return parseOptions(converted, env)
  }
  const string = (key, value = fields[key]) => { assert(typeof value === 'string' && value.trim() === value && value.length > 0, `REQUIRED_${key.toUpperCase().replaceAll('-', '_')}`); return value }
  const integer = (key, min, max) => { const raw = string(key); assert(/^\d+$/.test(raw), 'INTEGER_ARGUMENT_INVALID'); const n = Number(raw); assert(Number.isSafeInteger(n) && n >= min && n <= max, 'INTEGER_ARGUMENT_OUT_OF_RANGE'); return n }
  const profile = string('profile', fields.profile ?? env.MINIKUBE_PROFILE), context = string('context', fields.context ?? env.CONTROL_API_REAL_PG_CONTEXT)
  assert(profile === context && /^[a-z0-9][a-z0-9-]{0,62}$/.test(profile) && profile !== 'clerum-test' && !/(^|[-_])(prod|production)([-_]|$)/i.test(profile), 'OWNED_DEVELOPMENT_CONTEXT_REQUIRED')
  const runId = string('run-id'); assert(/^pr806-memory-[a-f0-9]{12}$/.test(runId), 'RUN_ID_INVALID')
  const hostNamespace = string('host-namespace'); assert(/^[a-z0-9][a-z0-9-]{0,62}$/.test(hostNamespace), 'HOST_NAMESPACE_INVALID')
  const prepareFixtures = fields['prepare-fixtures'] === true
  assert(!prepareFixtures || (!fields['budget-ids'] && !fields['gfs-parent-rid'] && !fields['fixtures-receipt']), 'PREPARATION_CANNOT_REUSE_FIXTURE_DATA')
  const fixture = fields['fixtures-receipt'] ? validateFixtureReceipt(readOwnedJson(fields['fixtures-receipt']), { profile, context, runId, hostNamespace }) : undefined
  assert(!fixture || (!fields['budget-ids'] && !fields['gfs-parent-rid'] && !fields['operator-user']), 'FIXTURE_RECEIPT_ARGUMENT_CONFLICT')
  const budgets = prepareFixtures ? [] : fixture?.hosts.map(item => item.budgetId) ?? string('budget-ids').split(',')
  assert(prepareFixtures || (budgets.length === 2 && budgets.every(uuid) && new Set(budgets).size === 2), 'TWO_OWNED_BUDGET_IDS_REQUIRED')
  const parentRid = prepareFixtures ? undefined : fixture?.parentRid ?? string('gfs-parent-rid')
  assert(prepareFixtures || /^[a-f0-9]{32}$/.test(parentRid) || uuid(parentRid), 'GFS_PARENT_RID_INVALID')
  const shapes = string('shape').split(','); assert(new Set(shapes).size === shapes.length && shapes.every(value => SHAPES.includes(value)) && ['visual-35mib', 'worst-structure', 'wide-strings'].every(value => shapes.includes(value)), 'REPRESENTATIVE_SHAPES_REQUIRED')
  const report = string('report'); assert(path.isAbsolute(report) && path.extname(report) === '.json', 'ABSOLUTE_JSON_REPORT_REQUIRED')
  const prepare = string('prepare'); assert(['restart', 'build'].includes(prepare), 'PREPARE_MODE_INVALID')
  assert(fields['include-legacy-gfs'] === true, 'LEGACY_GFS_REQUIRED')
  const options = { profile, context, runId, hostNamespace, budgets, parentRid, shapes, report: path.resolve(report), prepare,
    operatorUser: prepareFixtures ? string('operator-user', fields['operator-user'] ?? `${runId}-operator`) : fixture?.operatorUser ?? string('operator-user'), prepareFixtures, fixtureBinding: fixture,
    inspectorPort: integer('inspector-port', 1024, 65535), runs: integer('runs', 3, 3), cgroupLimitMiB: integer('cgroup-limit-mib', 768, 768), inspectPlan: fields['inspect-plan'] === true,
    candidate: { heapSizeMiB: integer('heap-size-mib', 64, 512), concurrency: integer('concurrency', 1, 4), readDeadlineMs: integer('read-deadline-ms', 100, 60000), workDeadlineMs: integer('work-deadline-ms', 100, 120000), closeGraceMs: integer('close-grace-ms', 1, 10000) }, publicArguments: fields }
  assert(options.candidate.closeGraceMs < options.candidate.readDeadlineMs, 'CLOCK_ARGUMENT_RELATION_INVALID')
  return options
}
async function command(binary, args, { env = process.env, timeoutMs = 180000, maxBytes = 2 * MIB } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []; let size = 0, timedOut = false
    child.stderr.resume()
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref() }, timeoutMs)
    child.stdout.on('data', data => { size += data.length; if (size > maxBytes) child.kill('SIGKILL'); else chunks.push(data) })
    child.once('error', () => { clearTimeout(timer); reject(new Error('COMMAND_START_FAILED')) })
    child.once('close', (code, signal) => { clearTimeout(timer); if (code !== 0 || timedOut || size > maxBytes) reject(new Error(`COMMAND_FAILED_${binary.toUpperCase()}_${code ?? 'SIGNAL'}`)); else resolve(Buffer.concat(chunks).toString()) })
  })
}
export function buildAuthorizeMemorySeederBundle(prepareGfsImages) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/tests/lib/control-api-authorize-memory-seeder.ts'), 'utf8')
  const action = prepareGfsImages ? `const gfsFixtureAction = ${prepareGfsImages.toString()};\n` : ''
  assert(!prepareGfsImages || typeof prepareGfsImages === 'function', 'GFS_FIXTURE_ACTION_SOURCE_REQUIRED')
  return stripTypeScriptTypes(source).replace(/^export /gm, '') + '\n' + action + (prepareGfsImages ? 'await runSeedCompanion({prepareGfsImages:gfsFixtureAction})\n' : 'await runSeedCompanion()\n')
}
export function buildAuthorizeMemoryCompanionBundle() {
  const dir = path.join(ROOT, 'scripts/tests/lib')
  const inspector = fs.readFileSync(path.join(dir, 'control-api-authorize-memory-inspector.mjs'), 'utf8').replace(/^export /gm, '')
  const source = fs.readFileSync(path.join(dir, 'control-api-authorize-memory-companion.ts'), 'utf8').replace(/^import .* from '\.\/control-api-authorize-memory-inspector\.mjs'\n/m, '')
  const companion = stripTypeScriptTypes(source).replace(/^export /gm, '')
  return `${inspector}\n${companion}\nawait runCompanion()\n`
}
export class Channel {
  constructor(child, timeoutMs) {
    this.child = child; this.timeoutMs = timeoutMs; this.pending = new Map(); this.responses = new Map(); this.next = 1; this.buffer = ''; this.exit = undefined
    child.stderr.resume(); child.stdout.setEncoding('utf8'); child.stdin.on('error', () => this.fail())
    child.stdout.on('data', chunk => {
      this.buffer += chunk
      if (this.buffer.length > 256 * 1024) { this.fail(); return }
      for (;;) { const newline = this.buffer.indexOf('\n'); if (newline < 0) break; const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
        let message; try { message = JSON.parse(line) } catch { this.fail(); return }
        if (message.fatal) { this.fail(); return }
        const map = message.event === 'response' ? this.responses : this.pending, id = message.event === 'response' ? message.requestId : message.callId
        const item = map.get(id); if (!item) continue; map.delete(id); clearTimeout(item.timer)
        if (message.failed || message.data?.failed) item.reject(new Error('REAL_COMPANION_COMMAND_FAILED')); else item.resolve(message.data)
      }
    })
    this.closed = new Promise(resolve => child.once('close', (code, signal) => { this.exit = { code, signal }; this.fail(); resolve(this.exit) }))
    child.once('error', () => this.fail())
  }
  fail() { for (const map of [this.pending, this.responses]) { for (const item of map.values()) { clearTimeout(item.timer); item.reject(new Error('COMPANION_PRODUCER_FAILED')) }; map.clear() } }
  deferred(map, id, timeout = this.timeoutMs) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { map.delete(id); reject(new Error('COMPANION_DEADLINE')) }, timeout); map.set(id, { resolve, reject, timer }) }) }
  async call(input, bytes) {
    const callId = String(this.next++), reply = this.deferred(this.pending, callId); reply.catch(() => {})
    const header = Buffer.from(JSON.stringify({ ...input, callId }) + '\n')
    const packet = bytes ? Buffer.concat([header, bytes]) : header
    const writing = new Promise((resolve, reject) => this.child.stdin.write(packet, error => error ? reject(new Error('COMPANION_INPUT_FAILED')) : resolve()))
    await Promise.race([writing, reply.then(() => undefined)])
    return reply
  }
  async open(input) { const result = this.deferred(this.responses, input.requestId); result.catch(() => {}); await this.call({ ...input, kind: 'open' }); return { requestId: input.requestId, result } }
  async body(handle, bytes) { for (let offset = 0; offset < bytes.length; offset += 65536) { const chunk = bytes.subarray(offset, offset + 65536); await this.call({ kind: 'write', requestId: handle.requestId, length: chunk.length }, chunk) }; await this.call({ kind: 'end', requestId: handle.requestId }) }
  async stop() { this.child.stdin.end(); const timer = setTimeout(() => { this.child.kill('SIGTERM'); setTimeout(() => this.child.kill('SIGKILL'), 1000).unref() }, 10000); const exit = await this.closed; clearTimeout(timer); assert(exit.code === 0 && !exit.signal, 'COMPANION_EXIT_NOT_ZERO'); return exit }
}
async function waitFor(check, predicate, timeoutMs, code) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await check(); if (predicate(value)) return value; await sleepPoll(25) }; throw new Error(code) }
/** Source for the private Unix relay. The caller owns its verified kubectl exec
 * Channel, real Host bindings and loopback inspector lease; no material leaves
 * the in-pod signer. This fixture can only keep incomplete authorize requests.
 */
export async function openAuthorizeAdmissionPressure(channel, privateOptions) {
  const baseline = await channel.call({ kind: 'hello', options: { ...privateOptions, pressureOnly: true } })
  assert(baseline.pressureOnly === true && baseline.owner.inFlight === 0 && baseline.policy.maxInFlight === privateOptions.candidate.concurrency, 'PRESSURE_BASELINE_UNPROVED')
  const commandDeadlineMs = pressureCommandDeadlineMs(baseline.policy)
  channel.timeoutMs = commandDeadlineMs
  const handles = []
  let closing
  const zeroBusiness = async () => {
    const counts = await channel.call({ kind: 'counts' })
    assert(counts.total === 0 && counts.tickets === 0 && counts.reservationRows === 0, 'PRESSURE_REACHED_BUSINESS_WORK')
    return counts
  }
  const owners = async () => {
    const value = await channel.call({ kind: 'owners' })
    assert(value.pid === baseline.serverPid && value.instanceCount === 1 && value.serverReads?.pid === baseline.serverPid, 'PRESSURE_PROCESS_OR_READ_OBSERVATION_UNKNOWN')
    return { ...value, counts: await zeroBusiness() }
  }
  const release = async () => {
    for (const handle of handles) await channel.call({ kind: 'close', requestId: handle.requestId })
    await Promise.all(handles.map(handle => handle.result))
    const value = await waitFor(owners, value => value.inFlight === 0 && value.serverReads.reads.length === 0, baseline.policy.workDeadlineMs + baseline.policy.closeGraceMs + 5000, 'PRESSURE_RELEASE_NOT_QUIESCENT')
    handles.length = 0
    return value
  }
  return {
    policy: Object.freeze({ ...baseline.policy }), commandDeadlineMs,
    async hold() {
      assert(!closing && handles.length === 0, 'PRESSURE_ALREADY_HELD_OR_CLOSING')
      for (let index = 0; index < baseline.policy.maxInFlight; index++) {
        assert(!closing, 'PRESSURE_CLOSING')
        const handle = await channel.open({ requestId: `${privateOptions.runId}-pressure-${index + 1}`, route: 'authorize', hostRef: privateOptions.bindings[index % privateOptions.bindings.length].hostRef, length: 35 * MIB - 4096 })
        handles.push(handle); await channel.call({ kind: 'write', requestId: handle.requestId, length: 1 }, Buffer.from('{'))
      }
      return waitFor(owners, value => value.inFlight === baseline.policy.maxInFlight && value.serverReads.reads.length === handles.length && value.serverReads.reads.every(read => handles.some(handle => handle.requestId === read.requestId) && read.receivedBodyBytes > 0 && read.complete === false), baseline.policy.readDeadlineMs, 'AUTHENTICATED_SERVER_BODY_HOLD_UNOBSERVED')
    }, owners, release,
    close() {
      return closing ??= (async () => {
        const failures = []
        try { if (handles.length) await release() } catch (error) { failures.push(error) }
        let producer
        try { producer = await channel.stop() } catch (error) { failures.push(error) }
        if (failures.length) throw new AggregateError(failures, 'PRESSURE_CLOSE_FAILED')
        return producer
      })()
    },
  }
}
export function validateReceipt(report) {
  assert(/^[a-f0-9]{40}$/.test(report.source?.head ?? '') && /^[a-f0-9]{64}$/.test(report.source?.policySha256 ?? '') && Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'SOURCE_OR_REPORT_WINDOW_MISSING')
  assert(report.status === 'complete' && report.runs.length === 3 && report.restoration?.verified === true && report.restoration.healthStatus === 200, 'INCOMPLETE_REPORT')
  assert(new Set(report.runs.map(run => run.podUid)).size === 3 && new Set(report.runs.map(run => run.containerId)).size === 3, 'CGROUP_WINDOWS_REUSED')
  for (const run of report.runs) {
    assert(run.phase === 'complete' && Number.isFinite(Date.parse(run.startedAt)) && Date.parse(run.finishedAt) >= Date.parse(run.startedAt) && /^[a-f0-9]{64}$/.test(run.baseline?.compiledPolicySha256 ?? '') && run.baseline.server.applicationProcesses === 1 && run.baseline.server.nodeProcessesIncludingAuxiliary === 2 && /^24\./.test(run.baseline.server.nodeVersion), 'RUN_SOURCE_PROCESS_OR_WINDOW_MISSING')
    assert(run.producer?.code === 0 && run.cleanup?.ownedGfsRemaining === 0, 'PRODUCER_OR_CLEANUP_INCOMPLETE')
    const expectedIssued = 2 + report.options.shapes.length * 2 * report.options.candidate.concurrency
    assert(run.warmup?.status === 200 && run.warmup.durableRowVerified === true && run.warmup.reservationVerified === true && run.warmup.reservationAmount === 200 && run.cleanup.lifecycle === 'pg-issued-expiry-before-host-release' && run.cleanup.releaseEndpoint === '/api/v1/internal/budgets/release' &&
      run.warmupRelease?.lifecycle === 'pg-issued-expiry-before-host-release' && run.combined.every(phase => phase.cleanup?.lifecycle === 'pg-issued-expiry-before-host-release' && phase.cleanup.liveIssuedTickets === 0 && phase.cleanup.reservationRows === 0) && run.cleanup.total === expectedIssued && run.cleanup.retainedAuthorizedAuditRows === expectedIssued && run.cleanup.tickets === expectedIssued && run.cleanup.expiredIssuedTickets === expectedIssued && run.cleanup.liveIssuedTickets === 0 &&
      run.cleanup.redeemedAuditRows === 0 && run.cleanup.finalizedAuditRows === 0 && run.cleanup.redeemedTickets === 0 && run.cleanup.finalizedTickets === 0 && run.cleanup.reservationRows === 0 && run.cleanup.activeReservations === 0 && run.cleanup.executionTicketExpiryRemainingMs === 0 &&
      Number.isSafeInteger(run.baseline.executionTicketTtlMs) && run.baseline.executionTicketTtlMs > 0 && run.baseline.executionTicketTtlMs <= 120000 && Date.parse(run.cleanup.observedAt) >= Date.parse(run.startedAt) && Date.parse(run.cleanup.observedAt) <= Date.parse(run.finishedAt), 'ISSUED_TICKET_LIFECYCLE_INCOMPLETE')
    assert(run.gc?.gc?.forced === true && run.gc.gc.kind === 'native-HeapProfiler.collectGarbage' && run.gc.gc.before.pid === run.gc.gc.after.pid && run.gc.gc.after.at >= run.gc.gc.before.at, 'FORCED_GC_UNKNOWN')
    assert(run.causality?.excess?.status === 503 && run.causality.excess.acceptedWriteBytes === 0 && run.causality.coverage.parser === 0 && run.causality.coverage.authorizer === 0, 'PRE_PARSE_PROOF_MISSING')
    assert(run.samples.length >= 2 && run.baseline.cgroup.events.oom === 0 && run.baseline.cgroup.events.oom_kill === 0 && run.samples.every(sample => sample.server.applicationProcesses === 1 && sample.server.nodeProcessesIncludingAuxiliary === 2 && sample.cgroup.limit === 768 * MIB && sample.cgroup.peak * 1.25 <= sample.cgroup.limit && sample.cgroup.events.oom === run.baseline.cgroup.events.oom && sample.cgroup.events.oom_kill === run.baseline.cgroup.events.oom_kill), 'CGROUP_MARGIN_OR_OOM_FAILED')
    assert(run.combined.length === report.options.shapes.length * 2 && run.combined.every(phase => phase.authorizes.length === report.options.candidate.concurrency && phase.authorizes.every(row => row.status === 200 && row.durableRowVerified === true && row.reservationVerified === true && row.reservationAmount === 200) && phase.gfs.length === phase.gfsConcurrency && phase.gfs.every(row => row.status === 201 && row.verifiedDigest === row.expectedDigest)), 'COMBINED_WORKLOAD_INCOMPLETE')
    assert(run.rejected.length === 2 && run.rejected.every(row => row.status === 413) && run.recovery?.status === 200 && run.recovery.durableRowVerified === true && run.recovery.reservationVerified === true && run.recovery.reservationAmount === 200 && run.health?.status === 200 && run.stalled?.status === 408 && run.closedTransaction?.physicallyHeldBeforeClose === true && run.closedTransaction.physicallyQuiesced === true, 'LIFECYCLE_CONTROL_INCOMPLETE')
  }
  return true
}
export async function run(options, privateSeedOptions, privateFixtureWork) {
  assert(privateFixtureWork === undefined || ((options.prepareFixtures === true || options.fixtureBinding) &&
    typeof privateFixtureWork === 'function'), 'PRIVATE_FIXTURE_WORK_INVALID')
  assert(privateSeedOptions === undefined || (privateSeedOptions && typeof privateSeedOptions === 'object' && !Array.isArray(privateSeedOptions) && Object.keys(privateSeedOptions).every(key => ['cookie', 'operatorPassword'].includes(key))), 'PRIVATE_SEED_ARGUMENT_INVALID')
  for (const field of ['cookie', 'operatorPassword', 'password', 'privateSeedOptions', 'dsn', 'privateKey']) assert(!(field in options) && !(field in (options.publicArguments ?? {})), 'PRIVATE_MATERIAL_CANNOT_ENTER_PUBLIC_OPTIONS')
  // The long-lived caller retains its original object in RAM across preparation,
  // visible Linux login and later measurement calls. Only these private values
  // cross the child stdin; the report/config/options never receive this object.
  const privateMaterial = privateSeedOptions === undefined
    ? { cookie: process.env.E2E_ADMIN_TOKEN, operatorPassword: process.env.CONTROL_API_MEMORY_OPERATOR_PASSWORD }
    : { cookie: privateSeedOptions.cookie, operatorPassword: privateSeedOptions.operatorPassword }
  const env = { ...process.env, MINIKUBE_PROFILE: options.profile, CONTROL_API_REAL_PG_CONTEXT: options.context }
  const kc = args => command('kubectl', ['--context', options.context, ...args], { env, timeoutMs: args.includes('rollout') ? 150000 : 15000 })
  const json = async args => JSON.parse(await kc(args))
  const head = (await command('git', ['rev-parse', 'HEAD'])).trim()
  assert((await command('git', ['status', '--porcelain'])).trim() === '', 'CLEAN_SOURCE_REQUIRED')
  await command('bash', ['scripts/minikube/require-t2-mutation-lock.sh'], { env: { ...env, T2_PROJECT_DIR: ROOT, T2_PROFILE: options.profile, T2_CONTEXT: options.context, T2_SKIP_LOCK: 'true' }, timeoutMs: 10000 })
  if (options.prepare === 'build') {
    await command('make', ['--no-print-directory', 'minikube-deploy-service', 'SVC=control-api', 'NS=control-plane', 'DEPLOYMENT=control-api'], { env, timeoutMs: 300000 })
    await command('make', ['--no-print-directory', 'minikube-pre-gate-sync'], { env, timeoutMs: 600000 })
  }
  const marker = (await json(['-n', NAMESPACE, 'get', 'configmap', 'clerum-pre-gate-sync-state', '-o', 'json'])).data
  const worktreeId = (await command('bash', ['-c', 'source scripts/minikube/t2-worktree-id.sh\nt2_worktree_id "$1"', 'memory-worktree-id', ROOT])).trim(); assert(worktreeId, 'CANONICAL_WORKTREE_ID_MISSING')
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/minikube/.image-manifest.json'), 'utf8'))
  assert(marker.gitHead === head && marker.worktreeId === worktreeId && marker.clusterFingerprint && marker.imagesGeneratedAt === manifest.generated && manifest.profile === options.profile, 'EXACT_SOURCE_IMAGE_MARKER_REQUIRED')
  await command('bash', ['scripts/minikube/require-t2-mutation-lock.sh'], { env: { ...env, T2_PROJECT_DIR: ROOT, T2_PROFILE: options.profile, T2_CONTEXT: options.context, T2_SKIP_LOCK: 'true' }, timeoutMs: 10000 })
  const common = (await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(), canonical = path.dirname(common)
  const allowedReports = path.join(canonical, '.local-notes/infra/runs')
  assert(options.report.startsWith(allowedReports + path.sep) && !fs.existsSync(options.report), 'FRESH_CANONICAL_REPORT_REQUIRED')
  fs.mkdirSync(path.dirname(options.report), { recursive: true, mode: 0o700 }); assert(fs.realpathSync(path.dirname(options.report)) === path.dirname(options.report), 'REPORT_PARENT_SYMLINK')
  if (options.fixtureBinding) assert(options.fixtureBinding.worktreeId === worktreeId && options.fixtureBinding.clusterFingerprint === marker.clusterFingerprint, 'FIXTURE_PROFILE_IDENTITY_CHANGED')
  const report = { kind: options.prepareFixtures || privateFixtureWork ? 'control-api-authorize-memory-fixtures.v1' : 'control-api-authorize-memory.v1', status: 'running', startedAt: new Date().toISOString(), source: { head, worktreeId, policySha256: sha256(fs.readFileSync(path.join(ROOT, 'control-api/src/middleware/llmProviderAttemptAdmissionLimits.ts'))), driverSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), companionBundleSha256: sha256(buildAuthorizeMemoryCompanionBundle()), clusterFingerprint: marker.clusterFingerprint, imagesGeneratedAt: manifest.generated }, options, runs: [], restoration: { verified: false } }
  const save = () => { const temporary = options.report + '.next'; fs.writeFileSync(temporary, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, options.report) }
  const deployment = await json(['-n', NAMESPACE, 'get', 'deployment', DEPLOYMENT, '-o', 'json'])
  assert(deployment.spec.replicas === 1, 'SINGLE_APP_REPLICA_REQUIRED')
  const ci = deployment.spec.template.spec.containers.findIndex(container => container.name === CONTAINER)
  assert(ci >= 0 && !deployment.spec.template.spec.hostNetwork, 'OWNED_CONTAINER_REQUIRED')
  if (options.prepareFixtures || privateFixtureWork) {
    const ready = (await json(['-n', NAMESPACE, 'get', 'pods', '-l', 'app=control-api', '-o', 'json'])).items.filter(pod => !pod.metadata.deletionTimestamp && pod.status.phase === 'Running' && pod.status.containerStatuses?.some(item => item.name === CONTAINER && item.ready))
    assert(ready.length === 1, 'SEED_READY_API_POD_AMBIGUOUS')
    const pod = ready[0], status = pod.status.containerStatuses.find(item => item.name === CONTAINER), spec = pod.spec.containers.find(item => item.name === CONTAINER)
    const replica = pod.metadata.ownerReferences?.find(item => item.kind === 'ReplicaSet' && item.controller === true)
    assert(replica && !pod.spec.hostNetwork && status.restartCount === 0, 'SEED_POD_IDENTITY_INVALID')
    const rs = await json(['-n', NAMESPACE, 'get', 'replicaset', replica.name, '-o', 'json'])
    assert(rs.metadata.ownerReferences?.some(item => item.kind === 'Deployment' && item.uid === deployment.metadata.uid && item.controller === true), 'SEED_DEPLOYMENT_OWNER_CHANGED')
    const imageId = status.imageID.match(/sha256:[a-f0-9]{64}$/)?.[0]
    assert(imageId && imageId === (manifest.images[spec.image] ?? manifest.images[`docker.io/${spec.image}`]) && manifest.sourceRevisions?.[spec.image] === head, 'SEED_IMAGE_SOURCE_MISMATCH')
    report.podUid = pod.metadata.uid; report.imageId = imageId; report.containerId = status.containerID
    const { prepareGfsImages } = await import('../e2e/prepare-subscription-remaining-fixtures.gfs.mjs')
    const seederBundle = buildAuthorizeMemorySeederBundle(privateFixtureWork ? prepareGfsImages : undefined)
    report.source.seederBundleSha256 = sha256(seederBundle); report.phase = 'real-fixture-preparation'; save()
    const child = spawn('kubectl', ['--context', options.context, '-n', NAMESPACE, 'exec', '-i', pod.metadata.name, '-c', CONTAINER, '--', 'env', '-u', 'NODE_OPTIONS', 'node', '--max-old-space-size=256', '--input-type=module', '-e', seederBundle], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const channel = new Channel(child, 120000)
    try {
      const resumed = !options.prepareFixtures && readOwnedJson(options.publicArguments['fixtures-receipt']).fixtures
      report.fixtures = await channel.call({ kind: options.prepareFixtures ? 'prepare' : 'resume',
        options: { runId: options.runId, hostNamespace: options.hostNamespace, operatorUser: options.operatorUser, ...privateMaterial },
        ...(resumed ? { input: { fixtures: resumed } } : {}) })
      if (privateFixtureWork) {
        // Only the actual session's private command interface is passed out.
        // No cookie/password, server module or mutable report is exposed.
        await privateFixtureWork({ fixtures: report.fixtures,
          apiPod: { name: pod.metadata.name, uid: pod.metadata.uid, imageId },
          source: { head, worktreeId, clusterFingerprint: marker.clusterFingerprint },
          prepareImages: runId => channel.call({ kind: 'prepare-subscription-images', input: { runId } }),
          prepareGfs: input => channel.call({ kind: 'prepare-gfs-images', input }),
          revokeImages: () => channel.call({ kind: 'revoke-subscription-images' }),
          revokeMemory: async () => {
            const result = await channel.call({ kind: 'revoke-memory-fixtures' })
            assert(result.verified === true && result.state === 'revoked' && result.grantsRevoked === 2 && result.hostsDetached === 2,
              'MEMORY_QA_FINALIZATION_UNPROVED')
            report.fixtureFinalization = result
            return result
          },
        })
      }
      report.producer = await channel.stop(); report.finishedAt = new Date().toISOString(); report.status = 'complete'; report.phase = 'complete'
      if (report.fixtureFinalization) {
        report.kind = 'control-api-authorize-qa-finalization.v1'
        report.releasedFixtureIdentities = report.fixtures.bindings.map(({ hostRef, hostUid, connectionKey, connectionId }) =>
          ({ hostRef, hostUid, connectionKey, connectionId }))
        delete report.fixtures
      } else validateFixtureReceipt(report, options)
      save(); return report
    } catch {
      report.status = 'failed'; report.failure = 'REAL_FIXTURE_PREPARATION_FAILED'; report.finishedAt = new Date().toISOString()
      await channel.stop().catch(() => {}); report.producer = channel.exit ?? { code: null, signal: 'unknown' }; save(); throw new Error('SEED_FAILED_REPORT_SAVED')
    }
  }
  const original = deployment.spec.template.spec.containers[ci].env?.find(item => item.name === 'NODE_OPTIONS')
  assert(!original?.valueFrom && (!original || /^--max-old-space-size=\d+$/.test(original.value)), 'ORIGINAL_NODE_OPTIONS_UNSUPPORTED')
  const candidateValue = `--max-old-space-size=${options.candidate.heapSizeMiB} --inspect=127.0.0.1:${options.inspectorPort}`
  const mutateOptions = async restore => {
    const current = await json(['-n', NAMESPACE, 'get', 'deployment', DEPLOYMENT, '-o', 'json']); assert(current.metadata.uid === deployment.metadata.uid, 'DEPLOYMENT_OWNER_CHANGED')
    const containers = current.spec.template.spec.containers, index = containers.findIndex(container => container.name === CONTAINER), values = containers[index].env ?? [], ei = values.findIndex(item => item.name === 'NODE_OPTIONS')
    const base = `/spec/template/spec/containers/${index}/env`, patch = [{ op: 'test', path: '/metadata/uid', value: current.metadata.uid }, { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion }]
    if (restore && JSON.stringify(ei >= 0 ? values[ei] : undefined) === JSON.stringify(original)) return
    if (restore) { assert(ei >= 0 && values[ei].value === candidateValue, 'RUNTIME_OPTION_OWNER_CHANGED'); patch.push({ op: 'test', path: `${base}/${ei}`, value: values[ei] }, ...(original ? [{ op: 'replace', path: `${base}/${ei}`, value: original }] : [{ op: 'remove', path: `${base}/${ei}` }])) }
    else { if (!containers[index].env) patch.push({ op: 'add', path: base, value: [] }); if (ei >= 0) patch.push({ op: 'test', path: `${base}/${ei}`, value: values[ei] }); patch.push({ op: ei >= 0 ? 'replace' : 'add', path: ei >= 0 ? `${base}/${ei}` : `${base}/-`, value: { name: 'NODE_OPTIONS', value: candidateValue } }) }
    await kc(['-n', NAMESPACE, 'patch', 'deployment', DEPLOYMENT, '--type=json', '--patch', JSON.stringify(patch)])
    await kc(['-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`, '--timeout=120s'])
  }
  let patched = false
  try {
    patched = true; await mutateOptions(false)
    for (let index = 0; index < 3; index++) {
      await command('make', ['--no-print-directory', 'minikube-restart-deploy', 'SVC=control-api', 'NS=control-plane', 'DEPLOYMENT=control-api'], { env, timeoutMs: 300000 })
      const pods = (await json(['-n', NAMESPACE, 'get', 'pods', '-l', 'app=control-api', '-o', 'json'])).items.filter(pod => !pod.metadata.deletionTimestamp && pod.status.phase === 'Running' && pod.status.containerStatuses?.find(value => value.name === CONTAINER)?.ready)
      assert(pods.length === 1 && pods[0].metadata.ownerReferences?.some(owner => owner.kind === 'ReplicaSet'), 'READY_POD_AMBIGUOUS')
      const pod = pods[0], container = pod.status.containerStatuses.find(value => value.name === CONTAINER), spec = pod.spec.containers.find(value => value.name === CONTAINER)
      assert(container.restartCount === 0, 'UNOBSERVED_PRIOR_CONTAINER_RESTART')
      const replica = pod.metadata.ownerReferences.find(owner => owner.kind === 'ReplicaSet' && owner.controller === true)
      const replicaSet = await json(['-n', NAMESPACE, 'get', 'replicaset', replica.name, '-o', 'json'])
      assert(replicaSet.metadata.ownerReferences?.some(owner => owner.kind === 'Deployment' && owner.uid === deployment.metadata.uid && owner.controller === true), 'POD_DEPLOYMENT_OWNER_CHANGED')
      assert(!spec.ports?.some(port => port.hostPort || port.containerPort === options.inspectorPort) && !pod.spec.hostNetwork && spec.resources?.limits?.memory === '768Mi', 'CGROUP_OR_INSPECTOR_BOUNDARY_INVALID')
      const actualImageId = container.imageID.match(/sha256:[a-f0-9]{64}$/)?.[0], expectedImageId = manifest.images[spec.image] ?? manifest.images[`docker.io/${spec.image}`]
      assert(actualImageId && actualImageId === expectedImageId && manifest.sourceRevisions?.[spec.image] === head, 'ACTUAL_IMAGE_SOURCE_MISMATCH')
      assert(!report.runs.some(run => run.podUid === pod.metadata.uid || run.containerId === container.containerID), 'CGROUP_WINDOW_NOT_FRESH')
      const bindings = []
      for (const [hi, hostRef] of ['pr806-memory-grok-host', 'pr806-memory-grok-host-2'].entries()) {
        const host = await json(['-n', options.hostNamespace, 'get', 'host', hostRef, '-o', 'json'])
        assert(host.spec.model?.provider === 'grok-subscription' && host.spec.model.connectionRef?.includes(options.runId), 'HOST_ASSIGNMENT_NOT_OWNED')
        if (options.fixtureBinding) assert(options.fixtureBinding.hosts[hi].hostUid === host.metadata.uid && options.fixtureBinding.hosts[hi].connectionKey === host.spec.model.connectionRef, 'FIXTURE_HOST_INCARCERATION_CHANGED')
        bindings.push({ hostRef, hostUid: host.metadata.uid, connectionKey: host.spec.model.connectionRef, budgetId: options.budgets[hi] })
      }
      const child = spawn('kubectl', ['--context', options.context, '-n', NAMESPACE, 'exec', '-i', pod.metadata.name, '-c', CONTAINER, '--', 'env', '-u', 'NODE_OPTIONS', 'node', '--max-old-space-size=64', '--input-type=module', '-e', buildAuthorizeMemoryCompanionBundle()], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
      const channel = new Channel(child, options.candidate.readDeadlineMs + options.candidate.workDeadlineMs + 10000)
      const row = { number: index + 1, podUid: pod.metadata.uid, containerId: container.containerID, imageId: actualImageId, image: spec.image, startedAt: new Date().toISOString(), phase: 'hello', samples: [], combined: [], rejected: [] }; report.runs.push(row); save()
      const trialId = `pr806-memory-${sha256(options.runId + index).slice(0, 12)}`
      let sequence = 0, sampling = false
      const requestFixture = (shape, binding, small = false) => buildAuthorizeFixture({ shape, binding, invocationId: `${trialId}-${++sequence}`, small })
      const execute = async (fixture, binding) => { const handle = await channel.open({ requestId: fixture.envelope.invocationId, route: 'authorize', hostRef: binding.hostRef, length: fixture.bytes.length }); await channel.body(handle, fixture.bytes); const response = await handle.result; assert(response.status === 200 && response.durableRowVerified === true && response.reservationVerified === true && response.reservationAmount === 200 && uuid(response.providerAttemptId) && response.requestHash === fixture.metadata.requestHash, 'REAL_AUTHORIZE_FAILED'); return { ...response, fixture: fixture.metadata } }
      const settleIssued = async () => {
        const ttl = row.baseline.executionTicketTtlMs
        assert(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 120000, 'ACTUAL_TICKET_TTL_UNKNOWN')
        // Query actual database time. No reservation is released while any owned
        // issued ticket can still be redeemed, and no audit outcome is invented.
        const observed = await waitFor(() => channel.call({ kind: 'counts' }), value => value.liveIssuedTickets === 0 && value.executionTicketExpiryRemainingMs === 0, ttl + 5000, 'ISSUED_TICKET_EXPIRY_UNOBSERVED')
        const released = await channel.call({ kind: 'cleanup' })
        assert(released.lifecycle === 'pg-issued-expiry-before-host-release' && released.liveIssuedTickets === 0 && released.reservationRows === 0, 'STRICT_ISSUED_CLEANUP_FAILED')
        return { ...released, expiryObservedAt: observed.observedAt }
      }
      const sample = async () => { const value = await channel.call({ kind: 'sample' }); row.samples.push(value); assert(value.cgroup.peak * 1.25 <= value.cgroup.limit && value.cgroup.events.oom === row.baseline.cgroup.events.oom && value.cgroup.events.oom_kill === row.baseline.cgroup.events.oom_kill, 'MEMORY_MARGIN_OR_OOM_FAILED'); return value }
      try {
        row.baseline = await channel.call({ kind: 'hello', options: { candidate: options.candidate, inspectorPort: options.inspectorPort, runId: trialId, hostNamespace: options.hostNamespace, fixtureRunId: options.runId, bindings, operatorUser: options.operatorUser, ...privateMaterial, gfsParentRid: options.parentRid } })
        row.bindings = row.baseline.bindings
        assert(row.baseline.server.applicationProcesses === 1 && row.baseline.server.nodeProcessesIncludingAuxiliary === 2 && row.baseline.cgroup.events.oom === 0 && row.baseline.cgroup.events.oom_kill === 0 && row.baseline.auxiliary.inputHighWaterMark <= 65536, 'CLIENT_RETAINER_BOUND_INVALID')
        row.warmup = await execute(requestFixture('visual-35mib', row.bindings[0], true), row.bindings[0])
        // No dispatch occurs in this benchmark. The real Host release endpoint
        // frees the known reservation; authorized/issued audit rows are retained.
        row.warmupRelease = await settleIssued()
        row.phase = 'pre-parse-saturation'; await channel.call({ kind: 'coverage-start' })
        const held = []
        for (let n = 0; n < options.candidate.concurrency; n++) { const fixture = requestFixture('visual-35mib', row.bindings[n % 2]); held.push(await channel.open({ requestId: fixture.envelope.invocationId, route: 'authorize', hostRef: row.bindings[n % 2].hostRef, length: fixture.bytes.length })) }
        let seen = 0; await waitFor(async () => { const coverage = await channel.call({ kind: 'coverage' }); seen += coverage.parser; return seen }, count => count >= options.candidate.concurrency, 5000, 'AUTHENTICATED_PARSER_ENTRY_UNOBSERVED')
        const extra = await channel.open({ requestId: `${trialId}-excess`, route: 'authorize', hostRef: row.bindings[1].hostRef, length: 35 * MIB - 4096 })
        const excess = await extra.result, coverage = await channel.call({ kind: 'coverage' })
        assert(excess.status === 503 && excess.error === 'authorize_capacity_exceeded' && excess.acceptedWriteBytes === 0 && coverage.parser === 0 && coverage.authorizer === 0, 'PRE_PARSE_CAPACITY_PROOF_FAILED')
        row.causality = { excess, coverage }
        assert((await channel.call({ kind: 'counts' })).total === 1, 'EXCESS_OR_HELD_REQUEST_AUTHORIZED')
        for (const handle of held) await channel.call({ kind: 'close', requestId: handle.requestId })
        await Promise.all(held.map(handle => handle.result))
        await waitFor(() => channel.call({ kind: 'owners' }), value => value.inFlight === 0, options.candidate.closeGraceMs + 5000, 'READ_OWNER_CALLBACK_DID_NOT_UNWIND')
        await channel.call({ kind: 'coverage-stop' })
        row.gc = await channel.call({ kind: 'gc' }); await sample()
        for (const shape of options.shapes) for (const gfsConcurrency of [1, 2]) {
          await channel.call({ kind: 'lock' })
          row.phase = `combined-${shape}-gfs${gfsConcurrency}`
          const phase = { shape, gfsConcurrency, authorizes: [], gfs: [] }; row.combined.push(phase)
          const authorizes = []
          for (let n = 0; n < options.candidate.concurrency; n++) { const binding = row.bindings[n % 2], fixture = requestFixture(shape, binding); const handle = await channel.open({ requestId: fixture.envelope.invocationId, route: 'authorize', hostRef: binding.hostRef, length: fixture.bytes.length }); await channel.body(handle, fixture.bytes); authorizes.push({ handle, fixture }) }
          await waitFor(() => channel.call({ kind: 'waiting' }), value => value.count === options.candidate.concurrency, 5000, 'REAL_TRANSACTION_HOLD_UNOBSERVED'); await sample()
          const gfsh = []
          for (let n = 0; n < gfsConcurrency; n++) { const fixture = buildGfsFixture({ name: `${trialId}-${++sequence}.bin`, sequence: n + 1 }); const handle = await channel.open({ requestId: `${trialId}-gfs-${sequence}`, route: 'gfs', name: fixture.metadata.name, length: fixture.bytes.length, decodedBytes: fixture.metadata.decodedBytes }); gfsh.push({ fixture, handle }) }
          const maxLength = Math.max(...gfsh.map(value => value.fixture.bytes.length))
          for (let offset = 0; offset < maxLength; offset += 65536) for (const value of gfsh) { const chunk = value.fixture.bytes.subarray(offset, offset + 65536); if (chunk.length) await channel.call({ kind: 'write', requestId: value.handle.requestId, length: chunk.length }, chunk); if (!(offset % (1024 * 1024))) await sample() }
          for (const value of gfsh) await channel.call({ kind: 'end', requestId: value.handle.requestId })
          for (const value of gfsh) { const response = await value.handle.result; assert(response.status === 201 && response.resource?.rid, 'REAL_GFS_WRITE_FAILED'); const observed = await channel.call({ kind: 'download', rid: response.resource.rid }); assert(observed.sha256 === value.fixture.metadata.sha256 && observed.bytes === 16 * MIB, 'REAL_GFS_BYTES_MISMATCH'); phase.gfs.push({ ...response, fixture: value.fixture.metadata, verifiedDigest: observed.sha256, expectedDigest: value.fixture.metadata.sha256 }) }
          await sample(); await channel.call({ kind: 'unlock' })
          for (const value of authorizes) { const response = await value.handle.result; assert(response.status === 200 && response.durableRowVerified === true && response.reservationVerified === true && response.reservationAmount === 200 && uuid(response.providerAttemptId) && response.requestHash === value.fixture.metadata.requestHash, 'REAL_AUTHORIZE_FAILED'); phase.authorizes.push({ ...response, fixture: value.fixture.metadata }) }
          phase.cleanup = await settleIssued(); await sample(); save()
        }
        row.phase = 'rejection-and-lifetime-controls'
        const accepted = requestFixture('visual-35mib', row.bindings[0])
        for (const kind of ['codex-cap', 'elements']) { const fixture = buildRejectedFixture(accepted, kind), handle = await channel.open({ requestId: `${trialId}-reject-${kind}`, route: 'authorize', hostRef: row.bindings[0].hostRef, length: fixture.bytes.length }); await channel.body(handle, fixture.bytes); const response = await handle.result; assert(response.status === 413 && response.error === 'payload_too_large', 'REAL_REJECTION_CONTROL_FAILED'); row.rejected.push({ ...response, fixture: fixture.metadata }) }
        const stallStart = Date.now(), stalled = await channel.open({ requestId: `${trialId}-stalled`, route: 'authorize', hostRef: row.bindings[0].hostRef, length: 35 * MIB - 4096 }); row.stalled = { ...(await stalled.result), elapsedMs: Date.now() - stallStart }; assert(row.stalled.elapsedMs >= options.candidate.readDeadlineMs - 100 && row.stalled.elapsedMs <= options.candidate.readDeadlineMs + 5000 && row.stalled.status === 408, 'STALLED_READ_NOT_BOUNDED')
        await channel.call({ kind: 'lock' }); const closing = requestFixture('visual-35mib', row.bindings[0], true), closingHandle = await channel.open({ requestId: closing.envelope.invocationId, route: 'authorize', hostRef: row.bindings[0].hostRef, length: closing.bytes.length }); await channel.body(closingHandle, closing.bytes)
        await waitFor(() => channel.call({ kind: 'waiting' }), value => value.count >= 1, 5000, 'CLOSE_TRANSACTION_HOLD_UNOBSERVED'); await channel.call({ kind: 'close', requestId: closingHandle.requestId }); await closingHandle.result
        await waitFor(() => channel.call({ kind: 'waiting' }), value => value.count === 0, options.candidate.workDeadlineMs + 1000, 'CLOSED_TRANSACTION_DID_NOT_UNWIND'); await channel.call({ kind: 'unlock' }); row.closedTransaction = { physicallyHeldBeforeClose: true, physicallyQuiesced: true }
        row.recovery = await execute(requestFixture('visual-35mib', row.bindings[1], true), row.bindings[1]); row.health = await channel.call({ kind: 'health' }); assert(row.health.status === 200, 'POST_WORKLOAD_HEALTH_FAILED')
        row.phase = 'observing-issued-ticket-expiry'; save()
        row.cleanup = await settleIssued()
        row.gc = await channel.call({ kind: 'gc' }); await sample(); row.producer = await channel.stop(); row.finishedAt = new Date().toISOString(); row.phase = 'complete'; save()
      } finally { if (!row.producer) { await channel.call({ kind: 'cleanup' }).catch(() => { row.cleanupFailed = true }); channel.child.stdin.end(); await channel.stop().catch(() => { row.producer = channel.exit ?? { code: null, signal: 'unknown' } }) }; save() }
    }
  } catch (error) { report.status = 'failed'; report.failure = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REAL_MEASUREMENT_OR_PREREQUISITE_FAILED' }
  finally {
    if (patched) { try { await mutateOptions(true); const restored = await json(['-n', NAMESPACE, 'get', 'deployment', DEPLOYMENT, '-o', 'json']); const value = restored.spec.template.spec.containers.find(item => item.name === CONTAINER).env?.find(item => item.name === 'NODE_OPTIONS'); assert(JSON.stringify(value) === JSON.stringify(original), 'RESTORATION_MISMATCH'); const restoredPods = (await json(['-n', NAMESPACE, 'get', 'pods', '-l', 'app=control-api', '-o', 'json'])).items.filter(value => !value.metadata.deletionTimestamp && value.status.containerStatuses?.some(c => c.name === CONTAINER && c.ready))
        assert(restoredPods.length === 1, 'RESTORED_POD_AMBIGUOUS')
        const healthCode = "const http=require('node:http'); const out=process.stdout.write.bind(process.stdout); process.stdout.write=()=>true;process.stderr.write=()=>true; const port=require('./dist/config.js').config.port; const req=http.get({hostname:'127.0.0.1',port,path:'/health'},r=>{r.resume();r.on('end',()=>{out(String(r.statusCode));process.exitCode=r.statusCode===200?0:1})});req.setTimeout(10000,()=>req.destroy());req.on('error',()=>process.exitCode=1);"
        const health = await kc(['-n', NAMESPACE, 'exec', restoredPods[0].metadata.name, '-c', CONTAINER, '--', 'env', '-u', 'NODE_OPTIONS', 'node', '-e', healthCode])
        assert(health.trim() === '200', 'RESTORED_HEALTH_FAILED')
        report.restoration = { verified: true, deploymentUid: restored.metadata.uid, healthStatus: 200 } } catch { report.restoration = { verified: false }; report.status = 'failed' } }
    report.finishedAt = new Date().toISOString(); if (report.status !== 'failed') { report.status = 'complete'; try { validateReceipt(report) } catch { report.status = 'failed'; report.failure = 'RECEIPT_HARD_GATE_FAILED' } }; save()
  }
  assert(report.status === 'complete', 'MEASUREMENT_FAILED_REPORT_SAVED')
  return report
}
async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.inspectPlan) { process.stdout.write(JSON.stringify({ mode: options.prepareFixtures ? 'read-only-fixtures-plan' : 'read-only-plan', profile: options.profile, context: options.context, candidate: options.candidate, shapes: options.shapes, runs: 3, gfsConcurrency: [1, 2], physicalExecution: 'NOT_RUN' }) + '\n'); return }
  if (process.env.T2_SKIP_LOCK !== 'true' || !process.env.T2_LOCK_TOKEN) {
    const common = (await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(), dir = path.join(path.dirname(common), '.local-notes/infra/runs', options.runId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const config = path.join(dir, options.prepareFixtures ? 'memory-fixtures-configuration.json' : 'memory-benchmark-configuration.json')
    fs.writeFileSync(config, JSON.stringify({ kind: 'control-api-authorize-memory-config.v1', arguments: options.publicArguments }), { flag: 'wx', mode: 0o600 })
    await command('make', ['--no-print-directory', 'minikube-control-api-authorize-memory'], { env: { ...process.env, MINIKUBE_PROFILE: options.profile, CONTROL_API_REAL_PG_CONTEXT: options.context, CONTROL_API_MEMORY_CONFIG: config }, timeoutMs: 3 * (options.shapes.length * 2 + 2) * (120000 + options.candidate.readDeadlineMs + options.candidate.workDeadlineMs + 30000) + 600000, maxBytes: MIB })
    process.stdout.write('CONTROL_API_AUTHORIZE_MEMORY_COMPLETE\n'); return
  }
  await run(options); process.stdout.write('CONTROL_API_AUTHORIZE_MEMORY_COMPLETE\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('CONTROL_API_AUTHORIZE_MEMORY_FAILED\n'); process.exitCode = 1 })
