const suiteKey = 'evenfire.ai/e2e-suite'
const runKey = 'evenfire.ai/e2e-run'
const suite = 'codex-approved-tools'
const kinds = {
  WorkflowRecipe: ['clerum.io/v1alpha1', 'workflowrecipes', 'sandbox-recipes', 'recipe', 0],
  Host: ['clerum.io/v1alpha1', 'hosts', 'mcp-host', 'agent', 1],
  McpServer: ['clerum.io/v1alpha1', 'mcpservers', 'mcp-server', 'mcp', 2],
  Context: ['clerum.io/v1alpha1', 'contexts', 'mcp-server', 'context', 3],
  NetworkPolicy: ['networking.k8s.io/v1', 'networkpolicies', null, null, 4],
}

// This protocol deliberately has no shell/network implementation. Its adapter
// must send the exact DeleteOptions body, honor finite deadlines, and represent
// only an API NotFound as null. A transport error is never evidence of absence.
export function fixtureResourceIdentity(resource, run) {
  if (!/^approved-tools-[a-f0-9]{12}$/.test(run ?? '')) throw new Error('Invalid fixture run')
  const rule = kinds[resource?.kind]
  const metadata = resource?.metadata
  if (!rule || resource.apiVersion !== rule[0] || !metadata)
    throw new Error('Unsupported fixture resource')
  const labels = metadata.labels
  const scenario = labels?.[runKey]?.slice(run.length + 1)
  if (
    labels?.[suiteKey] !== suite ||
    !['83', '150', '250', 'workflow'].includes(scenario) ||
    labels[runKey] !== `${run}-${scenario}`
  )
    throw new Error('Invalid fixture labels')
  if (resource.kind === 'NetworkPolicy') {
    if (
      scenario !== 'workflow' ||
      ![
        ['sandbox-recipes', `${run}-recipe-receipt-egress`],
        ['mcp-server', `${run}-recipe-receipt-ingress`],
      ].some(([namespace, name]) => metadata.namespace === namespace && metadata.name === name)
    )
      throw new Error('Invalid fixture policy binding')
  } else if (
    metadata.namespace !== rule[2] ||
    metadata.name !==
      (resource.kind === 'WorkflowRecipe' ? `${run}-recipe` : `${run}-${rule[3]}-${scenario}`) ||
    (resource.kind === 'WorkflowRecipe' && scenario !== 'workflow')
  )
    throw new Error('Invalid fixture resource binding')
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: metadata.name,
      namespace: metadata.namespace,
      labels: { [suiteKey]: suite, [runKey]: labels[runKey] },
    },
  }
}

function serverIdentity(metadata) {
  if (
    !/^[a-zA-Z0-9-]{1,128}$/.test(metadata?.uid ?? '') ||
    !/^[0-9]{1,32}$/.test(metadata?.resourceVersion ?? '')
  )
    throw new Error('Missing server resource identity')
  return { uid: metadata.uid, resourceVersion: metadata.resourceVersion }
}

function sameIdentity(expected, observed, run) {
  if (
    JSON.stringify(fixtureResourceIdentity(expected, run)) !==
    JSON.stringify(fixtureResourceIdentity(observed, run))
  )
    throw new Error('Fixture resource ownership changed')
}

export async function createJournaledFixtureResources({
  resources,
  run,
  journal,
  save,
  create,
  validateCreated,
}) {
  if (!Array.isArray(journal) || journal.length)
    throw new Error('Expected an empty resource journal')
  // Validate the entire proposal before its first mutation.
  const identities = resources.map(resource => fixtureResourceIdentity(resource, run))
  if (new Set(identities.map(identity => JSON.stringify(identity))).size !== identities.length)
    throw new Error('Duplicate fixture resource')
  for (const [index, resource] of resources.entries()) {
    const entry = { ...identities[index], status: 'creation-pending' }
    journal.push(entry)
    await save()
    // A lost create response is unresolved, even if a later same-name object
    // bears our labels. Never infer the original UID from a subsequent read.
    const created = await create(resource)
    sameIdentity(entry, created, run)
    Object.assign(entry.metadata, serverIdentity(created.metadata))
    entry.status = 'created'
    await save()
    if (validateCreated) await validateCreated(resource, created)
  }
  return journal
}

export function fixtureResourceGetArgs(entry, run) {
  fixtureResourceIdentity(entry, run)
  serverIdentity(entry.metadata)
  return [
    '-n',
    entry.metadata.namespace,
    'get',
    `${kinds[entry.kind][1]}.${entry.apiVersion.split('/')[0]}/${entry.metadata.name}`,
    '--ignore-not-found=true',
    '-o',
    'json',
  ]
}

export function fixtureDeleteRequest(entry, live, run) {
  sameIdentity(entry, live, run)
  const original = serverIdentity(entry.metadata)
  const current = serverIdentity(live.metadata)
  if (current.uid !== original.uid) throw new Error('Fixture resource UID changed')
  // Controllers may legitimately update resourceVersion since creation. Bind
  // deletion to the version just checked; an intervening update must conflict.
  return {
    method: 'DELETE',
    path: `/apis/${entry.apiVersion}/namespaces/${entry.metadata.namespace}/${kinds[entry.kind][1]}/${entry.metadata.name}`,
    body: {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      propagationPolicy: 'Foreground',
      preconditions: current,
    },
  }
}

export function validateFixtureDeleteRequest(request, entry, live, run) {
  if (JSON.stringify(request) !== JSON.stringify(fixtureDeleteRequest(entry, live, run)))
    throw new Error('Invalid fixture deletion request')
  return request
}

export async function cleanupJournaledFixtureResources({
  journal,
  run,
  save,
  get,
  remove,
  waitForDeletion = get,
}) {
  if (!Array.isArray(journal)) throw new Error('Missing resource journal')
  for (const entry of journal) {
    fixtureResourceIdentity(entry, run)
    if (!['creation-pending', 'created', 'deleted'].includes(entry.status))
      throw new Error('Invalid resource journal status')
    if (entry.status !== 'creation-pending') serverIdentity(entry.metadata)
  }
  // An ambiguous create might have left a dependent alive. Fail closed before
  // removing any dependency, and retain the journal for explicit recovery.
  if (journal.some(entry => entry.status === 'creation-pending'))
    throw new Error('Unresolved fixture creation; cleanup requires server identity')
  for (const entry of [...journal].sort((a, b) => kinds[a.kind][4] - kinds[b.kind][4])) {
    if (entry.status === 'deleted') continue
    const live = await get(entry)
    if (live !== null) {
      await remove(fixtureDeleteRequest(entry, live, run), entry, live)
      // Foreground deletion is asynchronous: do not remove dependencies until
      // the adapter confirms this exact resource is absent. Retry is bounded
      // by the caller; conflicts/terminating objects remain in the journal.
      if ((await waitForDeletion(entry)) !== null)
        throw new Error('Fixture resource deletion is not complete')
    }
    entry.status = 'deleted'
    await save()
  }
  return journal
}
