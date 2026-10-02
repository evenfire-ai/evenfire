import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { parseOptions, validateReceipt, Channel } from './measure-control-api-authorize-memory.mjs'
import { buildAuthorizeFixture, buildRejectedFixture, buildGfsFixture, MIB } from './lib/control-api-authorize-memory-fixtures.mjs'
import { InspectorClient, parseCgroup } from './lib/control-api-authorize-memory-inspector.mjs'
import { ownedIssuedCleanupPlan } from './lib/control-api-authorize-memory-companion.ts'

const require = createRequire(import.meta.url)
const grok = require('../../packages/grok-provider-attempt-contract/index.cjs')
const binding = { policyRevision: 1, policyHash: 'a'.repeat(64) }

test('physical visual/wide/worst fixtures reach35MiB under actual authorizer8MiB share and structure bounds', () => {
  for (const shape of ['visual-35mib', 'wide-strings', 'worst-structure']) {
    const fixture = buildAuthorizeFixture({ shape, binding, invocationId: `unit-${shape}` })
    assert(fixture.bytes.length >= 35 * MIB - 8192)
    assert(fixture.bytes.length <= 35 * MIB)
    assert(fixture.metadata.nonImageAuthorizeBytes <= 8 * MIB)
    assert.equal(fixture.metadata.decodedImageBytes, 20 * MIB)
    assert.match(fixture.metadata.sha256, /^[a-f0-9]{64}$/)
    assert.equal(grok.parseGrokCompletionRequest(fixture.request).ok, true)
    if (shape === 'worst-structure') {
      assert.equal(fixture.metadata.structure.containers, grok.LIMITS.maxRequestContainers)
      assert.equal(fixture.metadata.structure.members, grok.LIMITS.maxRequestMembers)
      assert.equal(fixture.metadata.structure.elements, grok.LIMITS.maxRequestElements)
    }
  }
})
test('rejected fixtures violate the intended physical bound rather than an invented model or malformed container', () => {
  const valid = buildAuthorizeFixture({ shape: 'visual-35mib', binding, invocationId: 'unit-rejection' })
  assert.equal(buildRejectedFixture(valid, 'codex-cap').metadata.expectedStatus, 413)
  const elements = buildRejectedFixture(valid, 'elements')
  assert.throws(() => grok.scanJsonStructure(elements.bytes, grok.BODY_STRUCTURE_LIMITS))
})
test('legacy GFS is actual16MiB contentBase64 below GFSC24MiB and reports decoded/serialized digests', () => {
  const fixture = buildGfsFixture({ name: 'unit-owned.bin', sequence: 37 })
  const parsed = JSON.parse(fixture.bytes.toString())
  assert.equal(Buffer.from(parsed.contentBase64, 'base64').length, 16 * MIB)
  assert(fixture.bytes.length < 24 * MIB)
  assert.equal(fixture.metadata.decodedBytes, 16 * MIB)
  assert.notEqual(fixture.metadata.sha256, fixture.metadata.serializedSha256)
})
test('cgroup requires actual768Mi/current/peak/events and never invents zeros for unavailable fields', () => {
  const raw = { limit: String(768 * MIB), current: '100', peak: '200', events: 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0' }
  assert.equal(parseCgroup(raw).peak, 200)
  for (const patch of [{ limit: 'max' }, { peak: undefined }, { events: 'low 0' }, { current: '300' }]) assert.throws(() => parseCgroup({ ...raw, ...patch }))
})
class UnitSocket extends EventTarget {
  constructor() { super(); this.commands = []; this.heap = 100 }
  send(raw) {
    const request = JSON.parse(raw); this.commands.push(request.method)
    let result = {}
    if (request.method === 'Runtime.evaluate') result = { result: { value: JSON.stringify({ pid: 4, nodeVersion: '24.18.0', at: this.commands.length, memory: { rss: 200, heapUsed: this.heap, heapTotal: 120, external: 20, arrayBuffers: 10 } }) } }
    if (request.method === 'HeapProfiler.collectGarbage') this.heap = 70
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) })))
  }
  close() { this.dispatchEvent(new Event('close')) }
}
test('forced-GC receipt requires native collectGarbage acknowledgement between actual process snapshots', async () => {
  const socket = new UnitSocket(), inspector = new InspectorClient(socket)
  const result = await inspector.forceGc()
  assert.equal(result.kind, 'native-HeapProfiler.collectGarbage')
  assert.equal(result.after.memory.heapUsed, 70)
  assert.deepEqual(socket.commands, ['Runtime.evaluate', 'HeapProfiler.enable', 'HeapProfiler.collectGarbage', 'Runtime.evaluate'])
  inspector.close()
})
test('missing nativeGC/metrics and incomplete coverage are failures, never post-quiescence substituted as forcedGC', async () => {
  const socket = new UnitSocket(), inspector = new InspectorClient(socket)
  await assert.rejects(() => inspector.coverage(), /coverage unavailable/)
  socket.send = raw => { const request = JSON.parse(raw); queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, error: { code: -1 } }) }))) }
  await assert.rejects(() => inspector.forceGc(), /rejected/)
  inspector.close()
})
test('companion is valid native Node24 TypeScript source; it contains no role elevation or delete of audit rows', () => {
  const source = fs.readFileSync(new URL('./lib/control-api-authorize-memory-companion.ts', import.meta.url), 'utf8')
  const compiled = stripTypeScriptTypes(source)
  assert(compiled.includes('issueMcpHostAccessJwt'))
  assert(compiled.includes('/api/v1/internal/budgets/release'))
  assert(!/finalizeGrokProviderAttempt|opaqueAttemptReceipt|markLlmProviderAttemptTicketRedeemed/.test(compiled))
  assert(!/DELETE FROM llm_provider_attempt|ALTER ROLE|DROP TABLE/.test(compiled))
})

// Pure controller tests use synthetic public metadata. They cannot activate a
// runtime, mint credentials or stand in for physical measurement evidence.
function args() {
  return ['--profile','unit-owned','--context','unit-owned','--run-id','pr806-memory-123456abcdef',
    '--host-namespace','mcp-host','--budget-ids','11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222',
    '--gfs-parent-rid','33333333333333333333333333333333','--operator-user','unit-admin','--heap-size-mib','384',
    '--concurrency','1','--read-deadline-ms','10000','--work-deadline-ms','30000','--close-grace-ms','250',
    '--runs','3','--cgroup-limit-mib','768','--shape','visual-35mib,worst-structure,wide-strings','--report','/tmp/unit-memory-report.json',
    '--prepare','restart','--inspector-port','9229','--include-legacy-gfs']
}
test('controller refuses missing/unknown/fractional/zero/partial shapes and silent required-lane omission', () => {
  assert.equal(parseOptions(args(), {}).candidate.concurrency, 1)
  assert.throws(() => parseOptions([], {}))
  for (const [flag,value] of [['--runs','0'],['--concurrency','1.5'],['--shape','visual-35mib'],['--context','foreign'],['--cgroup-limit-mib','512'],['--host-namespace','--all-namespaces']]) {
    const input=args(); input[input.indexOf(flag)+1]=value; assert.throws(() => parseOptions(input, {}))
  }
  assert.throws(() => parseOptions(args().filter(value => value !== '--include-legacy-gfs'), {}))
  assert.throws(() => parseOptions([...args(),'--unknown','1'], {}))
})
test('actual CLI plan and rejection execute without any runtime/secret/helper activation', () => {
  const script = new URL('./measure-control-api-authorize-memory.mjs', import.meta.url)
  const plan = spawnSync(process.execPath, [script.pathname, ...args(),'--inspect-plan'], { env:{PATH:path.dirname(process.execPath)}, encoding:'utf8',timeout:5000 })
  assert.equal(plan.status,0); assert.equal(JSON.parse(plan.stdout).physicalExecution,'NOT_RUN')
  const reject = spawnSync(process.execPath, [script.pathname,'--runs','0'], {env:{PATH:path.dirname(process.execPath)},encoding:'utf8',timeout:5000})
  assert.equal(reject.status,1); assert.equal(reject.stderr.trim(),'CONTROL_API_AUTHORIZE_MEMORY_FAILED')
})
function completeUnitReceipt() {
  const start = new Date(1000).toISOString(), end = new Date(2000).toISOString()
  const cgroup = {limit:768*MIB,current:100,peak:200,events:{oom:0,oom_kill:0}}
  return { status:'complete', startedAt:start, finishedAt:end, source:{head:'a'.repeat(40),policySha256:'b'.repeat(64)}, restoration:{verified:true,healthStatus:200},
    options:{candidate:{concurrency:1},shapes:['visual-35mib','worst-structure','wide-strings']}, runs:Array.from({length:3},(_,index)=>({
      podUid:`unit-pod-${index}`,containerId:`unit-container-${index}`,phase:'complete',startedAt:start,finishedAt:end,
      baseline:{executionTicketTtlMs:60000,compiledPolicySha256:'c'.repeat(64),server:{applicationProcesses:1,nodeProcessesIncludingAuxiliary:2,nodeVersion:'24.18.0'},cgroup},
      producer:{code:0},warmupRelease:{lifecycle:'pg-issued-expiry-before-host-release'},warmup:{status:200,durableRowVerified:true,reservationVerified:true,reservationAmount:200},
      cleanup:{lifecycle:'pg-issued-expiry-before-host-release',releaseEndpoint:'/api/v1/internal/budgets/release',total:8,retainedAuthorizedAuditRows:8,tickets:8,expiredIssuedTickets:8,liveIssuedTickets:0,redeemedAuditRows:0,finalizedAuditRows:0,redeemedTickets:0,finalizedTickets:0,reservationRows:0,activeReservations:0,executionTicketExpiryRemainingMs:0,observedAt:end,ownedGfsRemaining:0},
      gc:{gc:{forced:true,kind:'native-HeapProfiler.collectGarbage',before:{pid:1,at:1000},after:{pid:1,at:2000}}},
      causality:{excess:{status:503,acceptedWriteBytes:0},coverage:{parser:0,authorizer:0}},samples:[{server:{applicationProcesses:1,nodeProcessesIncludingAuxiliary:2},cgroup},{server:{applicationProcesses:1,nodeProcessesIncludingAuxiliary:2},cgroup}],
      combined:Array.from({length:6},(_,i)=>({cleanup:{lifecycle:'pg-issued-expiry-before-host-release',liveIssuedTickets:0,reservationRows:0},authorizes:[{status:200,durableRowVerified:true,reservationVerified:true,reservationAmount:200}],gfsConcurrency:i%2+1,gfs:Array.from({length:i%2+1},()=>({status:201,verifiedDigest:'unit-digest',expectedDigest:'unit-digest'}))})),
      rejected:[{status:413},{status:413}],recovery:{status:200},health:{status:200},stalled:{status:408},closedTransaction:{physicallyQuiesced:true}
    })) }
}
test('complete producer/status/report windows are mandatory and unknown/partial/failed observations cannot become green', () => {
  assert.equal(validateReceipt(completeUnitReceipt()),true)
  for(const change of [
    r=>r.runs.pop(),r=>r.source.policySha256=undefined,r=>r.restoration.verified=false,r=>r.runs[0].producer.code=137,
    r=>r.runs[0].cleanup.liveIssuedTickets=1,r=>r.runs[0].gc.gc.forced=false,r=>r.runs[0].causality.coverage.parser=1,
    r=>r.runs[0].samples[0].cgroup={...r.runs[0].samples[0].cgroup,peak:700*MIB},r=>r.runs[0].combined.pop(),
    r=>r.runs[0].combined[0].authorizes[0].durableRowVerified=false,r=>r.runs[0].closedTransaction.physicallyQuiesced=false,
    r=>r.runs[1].containerId=r.runs[0].containerId,r=>r.runs[0].baseline.server.applicationProcesses=2,
    r=>r.runs[0].cleanup.expiredIssuedTickets=0,r=>r.runs[0].cleanup.retainedAuthorizedAuditRows=0,r=>r.runs[0].cleanup.finalizedTickets=8,
    r=>r.runs[0].combined[0].authorizes[0].reservationVerified=false,r=>r.runs[0].baseline.server.nodeProcessesIncludingAuxiliary=3,r=>r.runs[0].cleanup.reservationRows=1,r=>r.runs[0].cleanup.observedAt=undefined,r=>r.runs[0].baseline.executionTicketTtlMs=undefined,
  ]) {const receipt=completeUnitReceipt();change(receipt);assert.throws(()=>validateReceipt(receipt))}
})
test('Make calibration draft owns mutation lease and require-lock body; core image targets remain public entry points', () => {
  const fragment=fs.readFileSync(new URL('../../Makefile',import.meta.url),'utf8')
  assert(fragment.includes('with-t2-mutation-lock.sh'))
  assert(fragment.includes('require-t2-mutation-lock.sh'))
  assert(fragment.includes('CONTROL_API_MEMORY_READ_ONLY'))
  assert(fragment.includes('--inspect-plan'))
  const driver=fs.readFileSync(new URL('./measure-control-api-authorize-memory.mjs',import.meta.url),'utf8')
  assert(driver.includes("'minikube-deploy-service'"));assert(driver.includes("'minikube-restart-deploy'"))
  assert(!driver.includes('build-images.sh'))
})

test('a blocked producer stdin is bounded by the command deadline; no infinite wait or hidden zero exit', async () => {
  const child = new EventEmitter()
  child.stderr = new PassThrough(); child.stdout = new PassThrough()
  child.stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => {} })
  child.kill = () => true
  const channel = new Channel(child, 30)
  await assert.rejects(() => channel.call({kind:'unit-only'}), /DEADLINE/)
  child.emit('close', 1, null)
})
test('20MiB padded image is actually decodable pixels rather than declared-header-only geometry', async () => {
  const native = createRequire(new URL('../../mcp-host/package.json',import.meta.url))('@napi-rs/canvas')
  const fixture = buildAuthorizeFixture({shape:'visual-35mib',binding,invocationId:'unit-pixel-decode'})
  const bytes = Buffer.from(fixture.request.messages[0].contentParts[1].data,'base64')
  const decoded = await native.loadImage(bytes)
  assert.equal(decoded.width,8); assert.equal(decoded.height,8)
})

test('selected Kubernetes context is explicit and canonical worktree/image schemas are consumed without ambient context mutation', () => {
  const driver=fs.readFileSync(new URL('./measure-control-api-authorize-memory.mjs',import.meta.url),'utf8')
  assert(driver.includes("['--context', options.context, ...args]"))
  assert(driver.includes("['--context', options.context, '-n'"))
  assert(!driver.includes("['config', 'current-context']"))
  assert(!driver.includes('use-context'))
  assert(driver.includes('t2_worktree_id'))
  assert(!driver.includes("createHash('sha1')"))
  const builder=fs.readFileSync(new URL('../minikube/build-images.sh',import.meta.url),'utf8')
  assert(builder.includes('sourceRevisions'))
  assert(builder.includes('MANIFEST_ENTRY_REVISIONS'))
})


test('issued cleanup retains audit and only releases known owner-bound reservations; unknown commits and dispatched states fail', () => {
  const row = {id:'unit-attempt',invocation_id:'unit-invocation',host_ref:'unit-host',request_hash:'a'.repeat(64),connection_id:'unit-connection',status:'authorized',ticket_status:'issued',ticket_expired:true,reservation_id:'unit-reservation',reservation_host_ref:'unit-host',budget_id:'unit-budget'}
  const bindings = [{hostRef:'unit-host',connectionId:'unit-connection',budgetId:'unit-budget'}]
  const confirmed = new Map([['unit-attempt',{invocationId:'unit-invocation',hostRef:'unit-host',requestHash:'a'.repeat(64)}]])
  assert.deepEqual(ownedIssuedCleanupPlan([row],bindings,confirmed), {retainedAuthorizedAuditRows:1,reservations:[{reservationId:'unit-reservation',hostRef:'unit-host'}]})
  assert.deepEqual(ownedIssuedCleanupPlan([{...row,reservation_id:null}],bindings,confirmed), {retainedAuthorizedAuditRows:1,reservations:[]})
  for (const patch of [{ticket_expired:false},{ticket_expired:undefined},{status:'redeemed'},{ticket_status:'redeemed'},{status:'finalized',ticket_status:'finalized'},{ticket_status:null},{connection_id:'foreign'},{reservation_host_ref:'foreign'},{budget_id:'foreign'},{request_hash:'b'.repeat(64)}]) assert.throws(() => ownedIssuedCleanupPlan([{...row,...patch}],bindings,confirmed))
  assert.throws(() => ownedIssuedCleanupPlan([row,{...row,id:'unconfirmed-commit'}],bindings,confirmed))
  assert.throws(() => ownedIssuedCleanupPlan([],bindings,confirmed))
  assert.equal(ownedIssuedCleanupPlan([],bindings,new Map()).retainedAuthorizedAuditRows,0)
})


// Run the actual pure/state function source without importing production config
// or bootstrap side effects. Captured SQL is a unit fake, not PostgreSQL proof.
function actualFunction(file, start, end, name, parameters = [], values = []) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  const offset = source.indexOf(start); assert(offset >= 0)
  const until = source.indexOf(end, offset); assert(until > offset)
  const compiled = stripTypeScriptTypes(source.slice(offset, until)).replace(/^export /gm, '')
  return new Function(...parameters, `${compiled}; return ${name}`)(...values)
}
test('actual production finalization store refuses issued and makes no audit mutation', async () => {
  const finalize = actualFunction('../../control-api/src/services/llmProviderAttemptStore.ts', 'export async function markLlmProviderAttemptFinalized(', 'export async function getMaxLlmProviderAttemptGeneration(', 'markLlmProviderAttemptFinalized')
  const statements = []
  const db = {query: async text => {statements.push(text);assert.match(text.trim(), /^SELECT /);return {rows:[{status:'issued',receipt_hash:null}],rowCount:1}}}
  assert.equal(await finalize(db,{providerAttemptId:'unit-owned-attempt',receiptHash:'a'.repeat(64),outcome:'canceled'}),'conflict')
  assert.equal(statements.length,1)
})
test('actual release route binds both sentinel/recipe namespace and exact Host; scope cannot release another Host', () => {
  const releaseBinding = actualFunction('../../control-api/src/routes/internal/budgetsCheck.ts', 'function checkReleaseClaimBinding(', 'export function createInternalBudgetsCheckRouter(', 'checkReleaseClaimBinding', ['config'], [{hostsNamespace:'unit-hosts',sandboxNamespace:'unit-sandbox'}])
  for (const recipeNamespace of ['unit-hosts','unit-sandbox']) {
    const claims={recipeNamespace,hostRefs:['unit-owner']}
    assert.equal(releaseBinding('unit-owner',claims),null)
    assert.equal(releaseBinding('foreign-host',claims),'host_ref_mismatch')
  }
  assert.equal(releaseBinding('unit-owner',{recipeNamespace:'foreign-namespace',hostRefs:['unit-owner']}),'unrecognized_token_binding')
})
class UnitOwnerSocket extends UnitSocket {
  constructor() { super();this.instances=1;this.owner=1;this.missing=false }
  send(raw) {
    const request=JSON.parse(raw);this.commands.push(request.method)
    let result={}
    if(request.method==='Runtime.evaluate')result=this.missing?{exceptionDetails:{}}:{result:{objectId:'unit-production-prototype'}}
    if(request.method==='Runtime.queryObjects')result={objects:{objectId:'unit-actual-owner-array'}}
    if(request.method==='Runtime.callFunctionOn')result={result:{value:{pid:4,at:this.commands.length,instanceCount:this.instances,inFlight:this.owner}}}
    queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:request.id,result})})))
  }
}
test('native owner projection requires unique actual singleton and releases inspection references; unavailable is not zero', async () => {
  const socket=new UnitOwnerSocket(),inspector=new InspectorClient(socket)
  assert.equal((await inspector.owners()).inFlight,1)
  assert.deepEqual(socket.commands,['Runtime.evaluate','Runtime.queryObjects','Runtime.callFunctionOn','Runtime.releaseObjectGroup'])
  for(const count of [0,2]){socket.instances=count;await assert.rejects(()=>inspector.owners(),/unknown/)}
  socket.instances=1;socket.owner=null;await assert.rejects(()=>inspector.owners(),/unknown/)
  socket.missing=true;await assert.rejects(()=>inspector.owners(),/unavailable/)
  assert.equal(socket.commands.at(-1),'Runtime.releaseObjectGroup');inspector.close()
})
