#!/usr/bin/env node
'use strict'

// Product/controller E2E, not a browser journey and not a T2 attestation.
// All mutation goes through the explicit-context client and inherited lease.
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns/promises')
const { BlockList, isIPv4 } = require('node:net')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { assertPolicy } = require('./wrc-egress-proof.cjs')
const {
  Journal,
  journalPath,
  readJournal,
  assertJournalBinding,
  createOwned,
  deleteOwned,
  waitFor,
  createCommandRunner,
  createKubeClient,
  invariant,
  RUN_LABEL,
  resourceIdentity,
} = require('./wrc-egress-lifecycle.cjs')

const STATE = 'clerum.io/egress-fqdn-state'
const LOOPBACK = [127, 0, 0, 1].join('.')
const endpointHost = 'example.com' // Existing mock-MCP fixture public endpoint contract.
const deploymentReady = object =>
  Boolean(
    object &&
    object.spec?.replicas > 0 &&
    object.status?.observedGeneration >= object.metadata.generation &&
    object.status.readyReplicas === object.spec.replicas &&
    object.status.availableReplicas === object.spec.replicas
  )
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const id = (kind, namespace, name) => ({ kind, namespace, name })

// Called after the complete policy oracle succeeds. Fresh DNS traffic alone
// cannot satisfy recovery; every tuple needs a newer persisted observation.
function policyObservation(policy, newerThan) {
  const entries = JSON.parse(policy.metadata.annotations[STATE])
  invariant(
    entries.length > 0 &&
      entries.every(
        entry => Number.isFinite(entry.lastObservedAt) && Number.isFinite(entry.expiresAt)
      ),
    'MISSING_ACCEPTED_DNS_OBSERVATION'
  )
  if (newerThan !== undefined && !entries.every(entry => entry.lastObservedAt > newerThan))
    return null
  return {
    lastAcceptedAt: Math.max(...entries.map(entry => entry.lastObservedAt)),
    latestExpiry: Math.max(...entries.map(entry => entry.expiresAt)),
  }
}

function acceptPolicyIntentChange(lanes, before, after, recipeUid, targets) {
  invariant(
    after.metadata?.uid === recipeUid &&
      before.metadata?.uid === recipeUid &&
      after.metadata.generation > before.metadata.generation,
    'HOST_MIGRATION_NOT_APPLIED'
  )
  for (const lane of lanes) {
    const target = targets.find(target => target.lane === (lane.lane === 'ui' ? 'worker' : 'ui'))
    invariant(target, 'MISSING_MIGRATION_TARGET')
    lane.target = target
    lane.uid = undefined
  }
}

// A test setup restriction, not an alternate production address classifier.
const blocked = new BlockList()
for (const cidr of [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]) {
  const [address, prefix] = cidr.split('/')
  blocked.addSubnet(address, Number(prefix), 'ipv4')
}

const trafficCode = `
const net=require('node:net'),https=require('node:https');
const [ip,portText,host,mode]=process.argv.slice(1); const port=Number(portText);
if(mode==='https') {
  const request=https.get({hostname:ip,port,servername:host,path:'/',agent:false,
    headers:{host,connection:'close'}},response=>{
    let body=''; response.on('data',chunk=>{body+=chunk;if(body.length>65536)request.destroy(new Error('body limit'))});
    response.once('aborted',()=>{process.exitCode=43;});
    response.once('error',()=>{process.exitCode=43;});
    response.once('end',()=>{if(response.statusCode===200&&body.includes('Example Domain')){
      process.stdout.write(JSON.stringify({allowed:true,contentVerified:true}));
    }else process.exitCode=44;});
  });
  const timer=setTimeout(()=>request.destroy(new Error('deadline')),5000);
  request.once('close',()=>clearTimeout(timer)); request.once('error',()=>{process.exitCode=43;});
} else {
  const socket=net.connect({host:ip,port});
  const timer=setTimeout(()=>{socket.destroy();process.exitCode=42;},2500);
  socket.once('connect',()=>{clearTimeout(timer);socket.destroy();process.stdout.write('connected');});
  socket.once('error',()=>{clearTimeout(timer);process.exitCode=43;});
}`

const businessCode = `
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const [url,key,value,operation]=process.argv.slice(1);
const client=new Client({name:'wrc-egress-business-witness',version:'1.0.0'},{capabilities:{}});
const timer=setTimeout(()=>process.exit(45),10000);
(async()=>{try{
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  if(operation==='record'){
    const stored=await client.callTool({name:'record',arguments:{key,value}});
    if(stored.isError)throw new Error('record failed');
  }
  const response=await client.callTool({name:'recall',arguments:{key}});
  const payload=JSON.parse(response.content.find(item=>item.type==='text').text);
  if(response.isError||payload.key!==key||payload.value!==value)throw new Error('business state lost');
  process.stdout.write(JSON.stringify({businessVerified:true}));
}finally{await client.close();clearTimeout(timer);}})().catch(()=>{process.exitCode=46;});`

const dnsControlCode = `
const http=require('node:http'); const [host,route,method]=process.argv.slice(1);
const request=http.request({host,port:8090,path:route,method},response=>{
  let body='';response.on('data',chunk=>{body+=chunk;if(body.length>262144)request.destroy()});
  response.once('end',()=>{if(response.statusCode!==200)process.exitCode=47;else process.stdout.write(body);});
});
const timer=setTimeout(()=>request.destroy(new Error('deadline')),5000);
request.once('close',()=>clearTimeout(timer));request.once('error',()=>{process.exitCode=48;});request.end();`

function fixtureObjects(config, runId, wrcImage, answerIp, upstream) {
  const suffix = runId.slice(0, 12)
  const names = {
    proxy: `e2e-wrc-dns-${suffix}`,
    script: `e2e-wrc-dns-script-${suffix}`,
    policy: `e2e-wrc-dns-policy-${suffix}`,
    fromWrc: `e2e-wrc-from-${suffix}`,
    recipe: `e2e-wrc-${suffix}`,
    canary: `e2e-wrc-canary-${suffix}`,
  }
  const labels = { 'e2e.clerum.io/suite': 'wrc-egress-degradation', [RUN_LABEL]: runId }
  const metadata = (name, namespace = config.wrcNamespace) => ({ name, namespace, labels })
  const targets = [
    { lane: 'ui', fqdn: `ui-${suffix}.example.com`, ip: answerIp },
    { lane: 'worker', fqdn: `worker-${suffix}.example.com`, ip: answerIp },
    { lane: 'canary', fqdn: `canary-${suffix}.example.com`, ip: answerIp },
  ]
  const securityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  }
  const ports = [
    { protocol: 'UDP', port: 53 },
    { protocol: 'TCP', port: 53 },
    { protocol: 'UDP', port: 8053 },
    { protocol: 'TCP', port: 8053 },
  ]
  const proxyPeer = { podSelector: { matchLabels: { app: names.proxy } } }
  const objects = [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata(names.script),
      data: {
        'server.cjs': fs.readFileSync(
          path.join(config.repository, 'tests/e2e/fixtures/wrc-egress-dns-proxy/server.cjs'),
          'utf8'
        ),
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(names.policy),
      spec: {
        podSelector: proxyPeer.podSelector,
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          { from: [{ podSelector: { matchLabels: { app: config.wrcDeployment } } }], ports },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
              },
            ],
            ports: ports.slice(0, 2),
          },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(names.fromWrc),
      spec: {
        podSelector: { matchLabels: { app: config.wrcDeployment } },
        policyTypes: ['Egress'],
        egress: [{ to: [proxyPeer], ports }],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(names.proxy),
      spec: {
        selector: { app: names.proxy },
        ports: [
          { name: 'dns-udp', protocol: 'UDP', port: 53, targetPort: 8053 },
          { name: 'dns-tcp', protocol: 'TCP', port: 53, targetPort: 8053 },
        ],
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(names.proxy),
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: names.proxy } },
        template: {
          metadata: { labels: { ...labels, app: names.proxy } },
          spec: {
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: 1,
            containers: [
              {
                name: 'dns-proxy',
                image: wrcImage,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '/fixture/server.cjs'],
                env: [
                  { name: 'DNS_TARGETS_JSON', value: JSON.stringify(targets) },
                  { name: 'DNS_TTL_SECONDS', value: '5' },
                  { name: 'UPSTREAM_DNS', value: upstream },
                ],
                ports: [
                  { name: 'dns-udp', containerPort: 8053, protocol: 'UDP' },
                  { name: 'dns-tcp', containerPort: 8053, protocol: 'TCP' },
                ],
                readinessProbe: {
                  tcpSocket: { port: 8053 },
                  periodSeconds: 1,
                  failureThreshold: 10,
                },
                volumeMounts: [{ name: 'fixture', mountPath: '/fixture', readOnly: true }],
                resources: {
                  requests: { cpu: '5m', memory: '20Mi' },
                  limits: { cpu: '100m', memory: '96Mi' },
                },
                securityContext,
              },
            ],
            volumes: [{ name: 'fixture', configMap: { name: names.script } }],
          },
        },
      },
    },
  ]
  const workload = name => ({
    id: name,
    type: 'deployment',
    image: 'clerum/mock-mcp-server:test',
    port: 3000,
    healthCheck: { type: 'http', path: '/', port: 3001 },
  })
  const bindings = fqdn => [80, 443].map(port => ({ dns: fqdn, port, protocol: 'TCP' }))
  const recipe = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: metadata(names.recipe, config.recipeNamespace),
    spec: {
      contextRef: 'context1',
      description: 'WRC authorization continuity fixture',
      workloads: [
        workload('frontend'),
        { ...workload('worker'), egressBindings: bindings(targets[1].fqdn) },
      ],
      ui: {
        workloadRef: 'frontend',
        port: 3000,
        title: 'WRC continuity',
        defaultPath: '/mcp',
        egress: {
          internal: [
            { workloadRef: 'worker', port: 3000 },
            { workloadRef: 'worker', port: 3001 },
          ],
          external: [80, 443].map(port => ({ fqdn: targets[0].fqdn, port })),
        },
      },
      security: { isolationLevel: 'minimal' },
    },
  }
  const canary = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: metadata(names.canary, config.recipeNamespace),
    spec: {
      contextRef: 'context1',
      description: 'Independent WRC business witness',
      workloads: [{ ...workload('witness'), egressBindings: bindings(targets[2].fqdn) }],
      security: { isolationLevel: 'minimal' },
    },
  }
  return { names, targets, objects, recipe, canary }
}

async function readyPod(kube, namespace, recipe, workload, timeoutMs = 120_000) {
  let pod
  await waitFor('ready-fixture-pod', timeoutMs, async (remaining, signal) => {
    const pods = await kube.list(
      'pods',
      namespace,
      `clerum.io/recipe=${recipe},clerum.io/workload=${workload}`,
      remaining,
      signal
    )
    const ready = pods.filter(
      item =>
        !item.metadata.deletionTimestamp &&
        item.status?.conditions?.some(
          condition => condition.type === 'Ready' && condition.status === 'True'
        )
    )
    invariant(ready.length <= 1, 'AMBIGUOUS_FIXTURE_POD')
    pod = ready[0]
    return Boolean(pod?.metadata.uid)
  })
  return pod
}

const identityKey = identity => `${identity.kind}/${identity.namespace}/${identity.name}`
const checkedIdentity = identity => resourceIdentity({ kind: identity.kind, metadata: identity })

function uiChildIdentities(ui) {
  const identities = []
  if (ui.physicalName !== null) {
    for (const kind of ['Deployment', 'Service']) {
      identities.push(checkedIdentity({ kind, namespace: ui.namespace, name: ui.physicalName }))
    }
  }
  identities.push(
    checkedIdentity({
      kind: 'NetworkPolicy',
      namespace: ui.namespace,
      name: `ui-egress-${ui.parent.name}`,
    })
  )
  return identities
}

function uiCleanupRecord(journal) {
  const ui = journal.state.uiCleanup
  // Journals from before UI capture cannot silently certify cross-namespace
  // teardown once a recipe was attempted. They require explicit inspection.
  invariant(
    ui !== undefined || !journal.state.resources.some(entry => entry.kind === 'WorkflowRecipe'),
    'UI_CLEANUP_RECORD_MISSING'
  )
  if (ui === null || ui === undefined) return null
  invariant(
    ui.runId === journal.state.runId &&
      ui.parent?.kind === 'WorkflowRecipe' &&
      typeof ui.workload === 'string' &&
      /^[a-z0-9][a-z0-9.-]*$/.test(ui.workload) &&
      Array.isArray(ui.children) &&
      ui.children.length <= 3,
    'INVALID_UI_CLEANUP_RECORD'
  )
  checkedIdentity(ui.parent)
  const allowed = new Set(uiChildIdentities(ui).map(identityKey))
  const seen = new Set()
  for (const child of ui.children) {
    const key = identityKey(checkedIdentity(child))
    invariant(
      allowed.has(key) &&
        !seen.has(key) &&
        (child.uid === null || (typeof child.uid === 'string' && child.uid.length > 0)),
      'INVALID_UI_CHILD_RECORD'
    )
    seen.add(key)
  }
  return ui
}

function assertUiChild(object, identity, ui) {
  invariant(
    identityKey(resourceIdentity(object)) === identityKey(identity) &&
      typeof object.metadata.uid === 'string' &&
      object.metadata.uid.length > 0 &&
      typeof object.metadata.resourceVersion === 'string' &&
      object.metadata.resourceVersion.length > 0,
    'UI_CHILD_IDENTITY_UNPROVEN'
  )
  const labels = object.metadata.labels ?? {}
  invariant(
    labels['clerum.io/managed-by'] === 'workflow-recipes' &&
      labels['clerum.io/recipe'] === ui.parent.name,
    'UI_CHILD_OWNER_UNPROVEN'
  )
  invariant(
    (labels['clerum.io/recipe-name'] === undefined ||
      labels['clerum.io/recipe-name'] === ui.parent.name) &&
      (labels['clerum.io/recipe-namespace'] === undefined ||
        labels['clerum.io/recipe-namespace'] === ui.parent.namespace) &&
      (labels['clerum.io/sandbox-ui'] === undefined || labels['clerum.io/sandbox-ui'] === 'true'),
    'UI_CHILD_SCOPE_CONFLICT'
  )
  if (identity.kind !== 'NetworkPolicy') {
    invariant(labels['clerum.io/workload'] === ui.workload, 'UI_CHILD_WORKLOAD_UNPROVEN')
  }
  // Deployment metadata may omit sandbox-ui labels; its physical status name
  // plus ordinary WRC recipe/workload labels supply the ownership proof.
  if (identity.kind !== 'Deployment') {
    invariant(
      labels['clerum.io/recipe-name'] === ui.parent.name &&
        labels['clerum.io/recipe-namespace'] === ui.parent.namespace,
      'UI_CHILD_SCOPE_UNPROVEN'
    )
  }
  if (identity.kind === 'Service') {
    invariant(labels['clerum.io/sandbox-ui'] === 'true', 'UI_SERVICE_SCOPE_UNPROVEN')
  }
  for (const owner of object.metadata.ownerReferences ?? []) {
    invariant(
      owner.kind === 'WorkflowRecipe' &&
        owner.name === ui.parent.name &&
        owner.uid === ui.parentUid,
      'UI_CHILD_HAS_FOREIGN_OWNER'
    )
  }
}

async function captureUiChildren(kube, journal) {
  const ui = uiCleanupRecord(journal)
  if (!ui) return null
  const parentIdentity = checkedIdentity(ui.parent)
  const parentRecord = journal.state.resources.find(
    entry => identityKey(entry) === identityKey(parentIdentity)
  )
  if (ui.parentUid !== null) {
    invariant(parentRecord?.uid === ui.parentUid, 'UI_PARENT_RECORD_MISMATCH')
  }
  const parent = await kube.get(parentIdentity)
  // On recovery, absence cannot authorize adopting a same-name child. Only
  // identities durably captured while the exact parent existed remain usable.
  if (!parent) return ui
  invariant(
    parentRecord?.uid &&
      identityKey(resourceIdentity(parent)) === identityKey(parentIdentity) &&
      parent.metadata.uid === parentRecord.uid &&
      parent.metadata.labels?.[RUN_LABEL] === ui.runId &&
      parent.spec?.ui?.workloadRef === ui.workload &&
      parent.spec.workloads?.some(
        workload => workload.id === ui.workload && workload.type === 'deployment'
      ),
    'UI_PARENT_OWNERSHIP_UNPROVEN'
  )
  ui.parentUid = parentRecord.uid
  const physicalName = parent.status?.workloadInstances?.[ui.workload]
  if (physicalName !== undefined) {
    // Status is persisted before WRC creates workloads. Validate it before any
    // CLI argument; never substitute the raw logical workload ID when absent.
    checkedIdentity({ kind: 'Deployment', namespace: ui.namespace, name: physicalName })
    invariant(
      ui.physicalName === null || ui.physicalName === physicalName,
      'UI_PHYSICAL_NAME_CHANGED'
    )
    ui.physicalName = physicalName
  }
  for (const identity of uiChildIdentities(ui)) {
    const recorded = ui.children.find(child => identityKey(child) === identityKey(identity))
    const object = await kube.get(identity)
    if (object) {
      assertUiChild(object, identity, ui)
      invariant(!recorded || recorded.uid === object.metadata.uid, 'UI_CHILD_IDENTITY_CHANGED')
    }
    if (!recorded) ui.children.push({ ...identity, uid: object?.metadata.uid ?? null })
    journal.save()
  }
  return ui
}

async function cleanupUiChildren(kube, ui) {
  invariant(!(await kube.get(checkedIdentity(ui.parent))), 'UI_PARENT_STILL_PRESENT')
  for (const child of ui.children) {
    const identity = checkedIdentity(child)
    const live = await kube.get(identity)
    if (!live) continue
    invariant(child.uid && live.metadata.uid === child.uid, 'UI_CHILD_IDENTITY_CHANGED')
    assertUiChild(live, identity, ui)
    try {
      await kube.delete(identity, {
        uid: child.uid,
        resourceVersion: live.metadata.resourceVersion,
      })
    } catch (error) {
      if (await kube.get(identity)) throw error
    }
    await waitFor('UI-child-absence', 90_000, async (remaining, signal) => {
      const current = await kube.get(identity, remaining, signal)
      if (!current) return true
      invariant(current.metadata.uid === child.uid, 'UI_CHILD_RECREATED_DURING_CLEANUP')
      return false
    })
  }
  // WRC's best-effort finalizer can delete a Deployment in Background. Its
  // ReplicaSets/Pods must also disappear before a restored verdict is valid.
  // Discovery is read-only: an uncaptured managed child is never adopted here.
  await waitFor('UI-resource-absence', 90_000, async (remaining, signal) => {
    const deadline = Date.now() + remaining
    let empty = true
    for (const kind of ['deployments', 'services', 'networkpolicies', 'replicasets', 'pods']) {
      const objects = await kube.list(
        kind,
        ui.namespace,
        `clerum.io/recipe=${ui.parent.name}`,
        deadline - Date.now(),
        signal
      )
      for (const object of objects) {
        if (!['replicasets', 'pods'].includes(kind)) {
          const identity = resourceIdentity(object)
          const recorded = ui.children.find(child => identityKey(child) === identityKey(identity))
          invariant(
            recorded?.uid && recorded.uid === object.metadata.uid,
            'UI_CHILD_IDENTITY_NOT_CAPTURED'
          )
        }
        empty = false
      }
    }
    return empty
  })
}

async function restore(kube, journal) {
  await kube.setCleanup(true)
  journal.state.phase = 'restoring'
  journal.save()
  const failures = []
  let ui
  const wrc = journal.state.wrc
  if (wrc?.attempted) {
    try {
      const live = await kube.get(wrc.identity)
      invariant(
        live?.metadata.uid === wrc.uid && live.spec.replicas === wrc.replicas,
        'WRC_RESTORE_IDENTITY_CHANGED'
      )
      const current = live.spec.template.spec
      const alreadyRestored =
        (current.dnsPolicy ?? 'ClusterFirst') === wrc.originalPolicy &&
        (current.dnsConfig ?? null) === null
      if (!alreadyRestored) {
        invariant(
          current.dnsPolicy === 'None' && same(current.dnsConfig, wrc.injectedConfig),
          'WRC_DNS_CHANGED_BY_ANOTHER_OWNER'
        )
        await kube.patch(wrc.identity, [
          { op: 'test', path: '/metadata/uid', value: wrc.uid },
          { op: 'test', path: '/metadata/resourceVersion', value: live.metadata.resourceVersion },
          { op: 'replace', path: '/spec/template/spec/dnsPolicy', value: wrc.originalPolicy },
          { op: 'remove', path: '/spec/template/spec/dnsConfig' },
        ])
      }
      await kube.rollout(wrc.identity.namespace, wrc.identity.name)
      const restored = await kube.get(wrc.identity)
      invariant(
        restored?.metadata.uid === wrc.uid &&
          restored.spec.replicas === wrc.replicas &&
          deploymentReady(restored) &&
          (restored.spec.template.spec.dnsPolicy ?? 'ClusterFirst') === wrc.originalPolicy &&
          (restored.spec.template.spec.dnsConfig ?? null) === null,
        'WRC_RESTORE_NOT_PROVEN'
      )
      journal.state.wrc.attempted = false
      journal.save()
    } catch (error) {
      failures.push(error)
    }
  }
  // Keep the DNS fixture if restoration is uncertain; deleting it would remove
  // the nameserver from a WRC Deployment that may still depend on it.
  if (failures.length === 0) {
    try {
      ui = await captureUiChildren(kube, journal)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 0) {
    for (const entry of [...journal.state.resources].reverse()) {
      try {
        await deleteOwned(kube, journal, entry)
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length === 0 && ui) {
    try {
      await cleanupUiChildren(kube, ui)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) {
    journal.state.phase = 'recovery-required'
    journal.save()
    throw new AggregateError(failures, 'WRC_EGRESS_RECOVERY_REQUIRED')
  }
  journal.state.phase = 'restored'
  journal.save()
  journal.remove()
}

async function protectedRun(kube, journal, exercise, cancellation) {
  let original
  try {
    await exercise()
  } catch (error) {
    original = error
  }
  try {
    await restore(kube, journal)
  } catch (cleanupError) {
    throw new AggregateError(
      [...(original ? [original] : []), cleanupError],
      'WRC_EGRESS_RECOVERY_REQUIRED'
    )
  }
  if (cancellation.signal.aborted) throw cancellation.signal.reason
  if (original) throw original
}

async function exercise(config, kube, journal) {
  const wrcIdentity = id('Deployment', config.wrcNamespace, config.wrcDeployment)
  const wrc = await kube.get(wrcIdentity)
  invariant(deploymentReady(wrc) && wrc.spec.replicas === 1, 'WRC_NOT_READY_OR_NOT_SINGLE_WRITER')
  invariant(
    (wrc.spec.template.spec.dnsPolicy ?? 'ClusterFirst') === 'ClusterFirst' &&
      (wrc.spec.template.spec.dnsConfig ?? null) === null,
    'WRC_DNS_NOT_BASELINE'
  )
  const image = wrc.spec.template.spec.containers.find(
    container => container.name === 'workflow-recipes'
  )?.image
  invariant(image, 'MISSING_WRC_IMAGE')
  const upstream = (await kube.get(id('Service', 'kube-system', 'kube-dns')))?.spec.clusterIP
  invariant(upstream, 'MISSING_CLUSTER_DNS')
  const resolver = new dns.Resolver({ timeout: 5000, tries: 1 })
  const answers = await resolver.resolve4(endpointHost)
  const answerIp = answers.find(address => isIPv4(address) && !blocked.check(address, 'ipv4'))
  invariant(answerIp, 'PUBLIC_ENDPOINT_UNAVAILABLE')
  const fixture = fixtureObjects(config, journal.state.runId, image, answerIp, upstream)
  const { names, targets } = fixture
  for (const object of fixture.objects) await createOwned(kube, journal, object)
  await kube.rollout(config.wrcNamespace, names.proxy, 90_000)
  const proxy = (await kube.list('pods', config.wrcNamespace, `app=${names.proxy}`)).find(
    pod =>
      !pod.metadata.deletionTimestamp &&
      pod.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')
  )
  invariant(proxy?.metadata.uid, 'DNS_PROXY_NOT_READY')
  const proxyIp = (await kube.get(id('Service', config.wrcNamespace, names.proxy)))?.spec.clusterIP
  invariant(proxyIp, 'DNS_PROXY_ADDRESS_MISSING')
  const dnsControl = async (route = '/state', method = 'GET', remaining = 15_000, signal) => {
    const state = JSON.parse(
      await kube.exec(
        config.wrcNamespace,
        proxy.metadata.name,
        dnsControlCode,
        [LOOPBACK, route, method],
        Math.min(15_000, remaining),
        signal
      )
    )
    invariant(state.fault === null && Array.isArray(state.lanes), 'DNS_FIXTURE_FAULT')
    return state
  }
  const setAffectedDns = async mode => {
    await dnsControl(`/mode/ui/${mode}`, 'POST')
    await dnsControl(`/mode/worker/${mode}`, 'POST')
  }
  await dnsControl()
  const injectedConfig = {
    nameservers: [proxyIp],
    options: [
      { name: 'ndots', value: '1' },
      { name: 'timeout', value: '2' },
      { name: 'attempts', value: '1' },
    ],
  }
  journal.state.wrc = {
    identity: wrcIdentity,
    uid: wrc.metadata.uid,
    replicas: 1,
    originalPolicy: 'ClusterFirst',
    injectedConfig,
    attempted: true,
  }
  journal.state.phase = 'DNS-injected'
  journal.save()
  const beforeInjection = await kube.get(wrcIdentity)
  invariant(
    beforeInjection?.metadata.uid === wrc.metadata.uid &&
      deploymentReady(beforeInjection) &&
      (beforeInjection.spec.template.spec.dnsPolicy ?? 'ClusterFirst') === 'ClusterFirst' &&
      (beforeInjection.spec.template.spec.dnsConfig ?? null) === null,
    'WRC_CHANGED_BEFORE_INJECTION'
  )
  await kube.patch(wrcIdentity, [
    { op: 'test', path: '/metadata/uid', value: wrc.metadata.uid },
    {
      op: 'test',
      path: '/metadata/resourceVersion',
      value: beforeInjection.metadata.resourceVersion,
    },
    { op: 'add', path: '/spec/template/spec/dnsPolicy', value: 'None' },
    { op: 'add', path: '/spec/template/spec/dnsConfig', value: injectedConfig },
  ])
  await kube.rollout(config.wrcNamespace, config.wrcDeployment)
  journal.state.uiCleanup = {
    parent: resourceIdentity(fixture.recipe),
    parentUid: null,
    runId: journal.state.runId,
    namespace: config.uiNamespace,
    workload: fixture.recipe.spec.ui.workloadRef,
    physicalName: null,
    children: [],
  }
  journal.save()
  const recipe = await createOwned(kube, journal, fixture.recipe)
  await createOwned(kube, journal, fixture.canary)
  const recipeIdentity = id('WorkflowRecipe', config.recipeNamespace, names.recipe)
  const active = async (name, remaining, signal) => {
    const current = await kube.get(
      id('WorkflowRecipe', config.recipeNamespace, name),
      remaining,
      signal
    )
    return current?.status?.phase === 'active'
  }
  await waitFor('active-recipes', 180_000, async (remaining, signal) => {
    const deadline = Date.now() + remaining
    return (
      (await active(names.recipe, remaining, signal)) &&
      (await active(names.canary, deadline - Date.now(), signal))
    )
  })
  const frontend = await readyPod(kube, config.uiNamespace, names.recipe, 'frontend')
  const worker = await readyPod(kube, config.recipeNamespace, names.recipe, 'worker')
  const canary = await readyPod(kube, config.recipeNamespace, names.canary, 'witness')
  const lanes = [
    {
      lane: 'ui',
      workload: 'frontend',
      namespace: config.uiNamespace,
      pod: frontend,
      policy: `ui-egress-${names.recipe}`,
      target: targets[0],
    },
    {
      lane: 'workload',
      workload: 'worker',
      namespace: config.recipeNamespace,
      pod: worker,
      policy: `wl-egress-${names.recipe}-worker`,
      target: targets[1],
    },
  ]
  const policiesMatch = async (ports, internalPorts, remaining = 30_000, signal) => {
    const deadline = Date.now() + remaining
    for (const lane of lanes) {
      const policy = await kube.get(
        id('NetworkPolicy', lane.namespace, lane.policy),
        deadline - Date.now(),
        signal
      )
      if (!policy) return false
      try {
        assertPolicy(policy, {
          name: lane.policy,
          namespace: lane.namespace,
          recipe: names.recipe,
          recipeNamespace: config.recipeNamespace,
          lane: lane.lane,
          workload: lane.workload,
          podLabels: lane.pod.metadata.labels,
          uid: lane.uid,
          tuples: ports.map(port => ({
            fqdn: lane.target.fqdn,
            ip: answerIp,
            port,
            protocol: 'TCP',
          })),
          internal:
            lane.lane === 'ui'
              ? internalPorts.map(port => ({
                  namespace: config.recipeNamespace,
                  workload: 'worker',
                  port,
                  protocol: 'TCP',
                }))
              : [],
        })
      } catch {
        return false
      }
      const observation = policyObservation(policy, lane.recoveryAfter)
      if (!observation) return false
      Object.assign(lane, observation)
      lane.uid = policy.metadata.uid
    }
    return true
  }
  await waitFor('baseline-policy-proof', 120_000, (remaining, signal) =>
    policiesMatch([80, 443], [3000, 3001], remaining, signal)
  )
  const services = await kube.list(
    'services',
    config.recipeNamespace,
    `clerum.io/recipe=${names.recipe},clerum.io/workload=worker`
  )
  invariant(
    services.length === 1 &&
      services[0].metadata.ownerReferences?.some(owner => owner.uid === recipe.metadata.uid),
    'WORKER_SERVICE_OWNERSHIP_NOT_PROVEN'
  )
  const workerUrl = `http://${services[0].metadata.name}.${config.recipeNamespace}.svc:3000/mcp`
  const business = async (write = false, internal = true) => {
    for (const [namespace, pod, url, key] of [
      [config.uiNamespace, frontend, `http://${LOOPBACK}:3000/mcp`, 'frontend'],
      [config.recipeNamespace, canary, `http://${LOOPBACK}:3000/mcp`, 'canary'],
      ...(internal ? [[config.uiNamespace, frontend, workerUrl, 'worker']] : []),
    ])
      await kube.exec(
        namespace,
        pod.metadata.name,
        businessCode,
        [url, key, journal.state.runId, write ? 'record' : 'recall'],
        15_000
      )
  }
  const traffic = async (namespace, pod, port, mode = 'tcp') => {
    const output = await kube.exec(
      namespace,
      pod.metadata.name,
      trafficCode,
      [answerIp, String(port), endpointHost, mode],
      10_000
    )
    if (mode === 'https')
      invariant(
        same(JSON.parse(output), { allowed: true, contentVerified: true }),
        'HTTPS_BUSINESS_CONTENT_NOT_PROVEN'
      )
    else invariant(output === 'connected', 'TCP_CONNECTION_NOT_PROVEN')
  }
  const proveTraffic = async removed => {
    // The canary proves the remote port is open at the moment of a negative
    // observation. Only a connection timeout counts as policy denial.
    await traffic(config.recipeNamespace, canary, 80)
    await traffic(config.recipeNamespace, canary, 443, 'https')
    for (const lane of lanes) {
      await traffic(lane.namespace, lane.pod, 443, 'https')
      if (!removed) await traffic(lane.namespace, lane.pod, 80)
      else {
        let denied = false
        try {
          await traffic(lane.namespace, lane.pod, 80)
        } catch (error) {
          denied = error.exitCode === 42
        }
        invariant(denied, 'REVOKED_TRAFFIC_NOT_PROVEN_DENIED')
        await traffic(config.recipeNamespace, canary, 80)
      }
    }
  }
  await proveTraffic(false)
  await business(true)
  // Internal health port is genuinely listening before its declaration is removed.
  invariant(worker.status?.podIP, 'WORKER_POD_ADDRESS_MISSING')
  await kube.exec(
    config.uiNamespace,
    frontend.metadata.name,
    trafficCode,
    [worker.status.podIP, '3001', endpointHost, 'tcp'],
    10_000
  )
  journal.state.phase = 'exercising'
  journal.save()
  console.log('WRC_EGRESS_BASELINE_PROVEN')

  await setAffectedDns('hold')
  const heldBefore = await dnsControl()
  const current = await kube.get(recipeIdentity)
  const reduced = await kube.patch(recipeIdentity, [
    { op: 'test', path: '/metadata/uid', value: recipe.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    {
      op: 'replace',
      path: '/spec/ui/egress/external',
      value: [{ fqdn: targets[0].fqdn, port: 443 }],
    },
    {
      op: 'replace',
      path: '/spec/ui/egress/internal',
      value: [{ workloadRef: 'worker', port: 3000 }],
    },
    {
      op: 'replace',
      path: '/spec/workloads/1/egressBindings',
      value: [{ dns: targets[1].fqdn, port: 443, protocol: 'TCP' }],
    },
  ])
  const countsFor = (state, lane, mode) => {
    const count = state.lanes.find(item => item.lane === lane)?.received?.[mode]
    invariant(Number.isSafeInteger(count) && count >= 0, 'MISSING_UNIQUE_DNS_OBSERVATION')
    return count
  }
  await waitFor('DNS-hold-started', 60_000, async (remaining, signal) => {
    const state = await dnsControl('/state', 'GET', remaining, signal)
    return ['ui', 'worker'].some(
      lane => countsFor(state, lane, 'hold') > countsFor(heldBefore, lane, 'hold')
    )
  })
  // Runtime proves convergence/continuity while the resolver withholds replies.
  // Exact pre/post-DNS ordering and same-attempt races are proved by the
  // deterministic controller tests, not by historical packet counters here.
  await waitFor('contraction-with-resolver-unavailable', 60_000, (remaining, signal) =>
    policiesMatch([443], [3000], remaining, signal)
  )
  await business()
  await proveTraffic(true)
  let internalDenied = false
  try {
    await kube.exec(
      config.uiNamespace,
      frontend.metadata.name,
      trafficCode,
      [worker.status.podIP, '3001', endpointHost, 'tcp'],
      10_000
    )
  } catch (error) {
    internalDenied = error.exitCode === 42
  }
  invariant(internalDenied, 'REMOVED_INTERNAL_PORT_NOT_DENIED')
  console.log('WRC_EGRESS_HELD_CONTINUITY_PROVEN')

  for (const lane of lanes) {
    const policyIdentity = id('NetworkPolicy', lane.namespace, lane.policy)
    const policy = await kube.get(policyIdentity)
    await kube.patch(policyIdentity, [
      { op: 'test', path: '/metadata/uid', value: lane.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: policy.metadata.resourceVersion },
      {
        op: 'add',
        path: '/spec/egress/-',
        value: {
          to: [{ ipBlock: { cidr: `${answerIp}/32` } }],
          ports: [{ port: 80, protocol: 'TCP' }],
        },
      },
    ])
  }
  const failedBefore = await dnsControl()
  await setAffectedDns('servfail')
  await waitFor('both-DNS-lanes-SERVFAIL', 90_000, async (remaining, signal) => {
    const state = await dnsControl('/state', 'GET', remaining, signal)
    return ['ui', 'worker'].every(
      lane => countsFor(state, lane, 'servfail') > countsFor(failedBefore, lane, 'servfail')
    )
  })
  await waitFor('drift-convergence-under-SERVFAIL', 90_000, (remaining, signal) =>
    policiesMatch([443], [3000], remaining, signal)
  )
  await business()
  await proveTraffic(true)
  invariant(
    (await active(names.recipe)) && (await active(names.canary)),
    'RECIPE_AVAILABILITY_LOST'
  )
  console.log('WRC_EGRESS_SERVFAIL_CONTINUITY_PROVEN')

  // A no-op refresh may legitimately avoid writing timestamps until renewal.
  // Bound that wait by the observed stored window instead of demanding churn
  // or mistaking a DNS packet / old active phase for accepted convergence.
  const latestExpiry = Math.max(...lanes.map(lane => lane.latestExpiry))
  invariant(Number.isFinite(latestExpiry), 'MISSING_ACCEPTED_DNS_WINDOW')
  const recoveryBudget = Math.max(90_000, latestExpiry - Date.now() + 90_000)
  invariant(recoveryBudget <= 600_000, 'DNS_WINDOW_EXCEEDS_GATE_RECOVERY_BUDGET')
  for (const lane of lanes) {
    invariant(Number.isFinite(lane.lastAcceptedAt), 'MISSING_ACCEPTED_DNS_OBSERVATION')
    lane.recoveryAfter = lane.lastAcceptedAt
  }
  const recoveredBefore = await dnsControl()
  await setAffectedDns('ok')
  await waitFor('autonomous-DNS-recovery', 180_000, async (remaining, signal) => {
    const state = await dnsControl('/state', 'GET', remaining, signal)
    return ['ui', 'worker'].every(
      lane => countsFor(state, lane, 'ok') > countsFor(recoveredBefore, lane, 'ok')
    )
  })
  const recovered = await kube.get(recipeIdentity)
  invariant(
    recovered.metadata.generation === reduced.metadata.generation,
    'RECOVERY_NEEDED_SPEC_NUDGE'
  )
  await waitFor('accepted-recovered-policy-proof', recoveryBudget, async (remaining, signal) => {
    const deadline = Date.now() + remaining
    return (
      (await policiesMatch([443], [3000], remaining, signal)) &&
      (await active(names.recipe, deadline - Date.now(), signal)) &&
      (await active(names.canary, deadline - Date.now(), signal))
    )
  })
  await business()
  await proveTraffic(true)

  // Exercise the real API's empty-list serialization on a valid A→B edit.
  // Remove the internal route intentionally; no service-continuity claim is
  // made for that explicitly revoked route after this configuration change.
  const migration = await kube.get(recipeIdentity)
  const migrated = await kube.patch(recipeIdentity, [
    { op: 'test', path: '/metadata/uid', value: recipe.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: migration.metadata.resourceVersion },
    {
      op: 'replace',
      path: '/spec/ui/egress',
      value: { external: [{ fqdn: targets[1].fqdn, port: 443 }] },
    },
    {
      op: 'replace',
      path: '/spec/workloads/1/egressBindings',
      value: [{ dns: targets[0].fqdn, port: 443, protocol: 'TCP' }],
    },
  ])
  // Contracting away the worker's last old FQDN legitimately deletes its
  // aggregate policy. Re-pin the recreated identity only after this confirmed
  // intent change and the complete ownership/spec/provenance proof below.
  // The baseline UID remains mandatory throughout the prior fault/race phases.
  acceptPolicyIntentChange(lanes, migration, migrated, recipe.metadata.uid, targets)
  await waitFor('valid-host-migration', 120_000, async (remaining, signal) => {
    const deadline = Date.now() + remaining
    return (
      (await policiesMatch([443], [], remaining, signal)) &&
      (await active(names.recipe, deadline - Date.now(), signal))
    )
  })
  await business(false, false)
  await proveTraffic(true)
  for (const name of [config.wrcDeployment, 'control-api', 'host-context-controller']) {
    invariant(
      deploymentReady(await kube.get(id('Deployment', config.wrcNamespace, name))),
      'SIBLING_DEPLOYMENT_NOT_READY'
    )
  }
  for (const lane of [...lanes, { pod: canary, namespace: config.recipeNamespace }]) {
    const now = (
      await kube.list(
        'pods',
        lane.namespace,
        `clerum.io/recipe=${lane.pod.metadata.labels['clerum.io/recipe']},clerum.io/workload=${lane.pod.metadata.labels['clerum.io/workload']}`
      )
    ).find(pod => pod.metadata.uid === lane.pod.metadata.uid)
    invariant(
      now &&
        !now.metadata.deletionTimestamp &&
        same(
          now.status?.containerStatuses?.map(c => c.restartCount),
          lane.pod.status?.containerStatuses?.map(c => c.restartCount)
        ),
      'FIXTURE_POD_RESTARTED_OR_REPLACED'
    )
  }
  console.log('WRC_EGRESS_AUTONOMOUS_RECOVERY_AND_MIGRATION_PROVEN')
}

async function main(argv) {
  invariant(
    argv.length === 0 || (argv.length === 1 && argv[0] === '--recover'),
    'INVALID_GATE_ARGUMENTS'
  )
  const repository = fs.realpathSync(path.join(__dirname, '../../..'))
  invariant(
    process.env.T2_PROJECT_DIR === repository &&
      process.env.T2_PROFILE === process.env.T2_CONTEXT &&
      process.env.KUBECONTEXT === process.env.T2_CONTEXT,
    'INVALID_GATE_BINDING'
  )
  const binding = {
    repository,
    profile: process.env.T2_PROFILE,
    context: process.env.T2_CONTEXT,
    branch: execFileSync('git', ['branch', '--show-current'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 5000,
    }).trim(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 5000,
    }).trim(),
  }
  const cancellation = new AbortController()
  let signalCode = 0
  const signalHandlers = new Map(
    ['SIGINT', 'SIGTERM'].map(signal => [
      signal,
      () => {
        signalCode ||= signal === 'SIGINT' ? 130 : 143
        const error = new Error('WRC_GATE_INTERRUPTED')
        error.exitCode = signalCode
        cancellation.abort(error)
      },
    ])
  )
  for (const [signal, handler] of signalHandlers) process.on(signal, handler)
  const run = createCommandRunner(repository, cancellation)
  const kube = createKubeClient(repository, binding.context, run)
  try {
    // Protect direct Node invocation as well as the Bash entry point.
    await run(['bash', path.join(repository, 'scripts/minikube/require-t2-mutation-lock.sh')], {
      timeoutMs: 15_000,
    })
    const file = journalPath(repository, binding.profile)
    if (argv[0] === '--recover') {
      const state = readJournal(file)
      assertJournalBinding(state, binding)
      await restore(kube, new Journal(file, state, true))
      invariant(!signalCode, 'RECOVERY_INTERRUPTED')
      console.log('WRC_EGRESS_RECOVERY_COMPLETE') // Never the interrupted test's PASS.
      return
    }
    invariant(
      process.env.E2E_WRC_EGRESS_FAULT_INJECTION === '1',
      'FAULT_INJECTION_NOT_ACKNOWLEDGED'
    )
    // Direct Node invocation cannot bypass exact-head/image/context verification.
    // Reuse the supported read-only preflight while inheriting the same lease.
    await run(
      [
        'env',
        'T2_PLAN_MODE=false',
        'bash',
        path.join(repository, 'scripts/minikube/t2-preflight.sh'),
      ],
      { timeoutMs: 300_000 }
    )
    const journal = new Journal(file, {
      version: 1,
      binding,
      runId: randomUUID(),
      phase: 'validated',
      resources: [],
      uiCleanup: null,
    })
    const config = {
      repository,
      wrcNamespace: process.env.WRC_NAMESPACE || 'control-plane',
      wrcDeployment: process.env.WRC_DEPLOYMENT || 'workflow-recipes',
      uiNamespace: process.env.SANDBOX_UI_NS || 'sandbox-ui',
      recipeNamespace: process.env.WORKFLOW_RECIPE_NS || 'sandbox-recipes',
    }
    await protectedRun(kube, journal, () => exercise(config, kube, journal), cancellation)
    console.log('WRC_EGRESS_DEGRADATION_E2E_PASS')
  } catch (error) {
    process.stderr.write(
      `${error instanceof AggregateError ? 'WRC_EGRESS_RECOVERY_REQUIRED' : 'WRC_EGRESS_GATE_FAILED'}\n`
    )
    process.exitCode = signalCode || error.exitCode || 1
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
  }
}

module.exports = {
  restore,
  protectedRun,
  fixtureObjects,
  deploymentReady,
  policyObservation,
  acceptPolicyIntentChange,
  main,
}
if (require.main === module)
  main(process.argv.slice(2)).catch(() => {
    process.exitCode = 1
  })
