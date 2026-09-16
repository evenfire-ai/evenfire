export const controlApiFixtureImage = 'clerum/codex-approved-tools-control-api-e2e:test'
export const controlApiRunAnnotation = 'evenfire.ai/codex-tools-fixture-run'
export const controlApiFlags = [
  'NODE_ENV',
  'EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE',
  'APPROVED_TOOLS_RUN_ID',
  'MINIKUBE_PROFILE',
  'CONTROL_API_REAL_PG_CONTEXT',
]
const runPattern = /^approved-tools-[a-f0-9]{12}$/

function validateImage(image, policy) {
  if (
    !(
      image === controlApiFixtureImage ||
      /^(clerum\/control-api|ghcr\.io\/evenfire-ai\/control-api)(:[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/.test(
        image
      )
    ) ||
    !['Always', 'Never', 'IfNotPresent'].includes(policy)
  )
    throw new Error('Invalid Control API image')
}
function validateEnv(env, profile) {
  if (
    !Array.isArray(env) ||
    env.length !== controlApiFlags.length ||
    new Set(env.map(e => e.name)).size !== controlApiFlags.length
  )
    throw new Error('Invalid Control API environment')
  for (const e of env) {
    if (
      !controlApiFlags.includes(e.name) ||
      Object.keys(e).length !== 2 ||
      !(
        e.$patch === 'delete' ||
        (e.name === 'NODE_ENV'
          ? ['test', 'production', 'development'].includes(e.value)
          : e.name === 'EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE'
            ? e.value === '1'
            : e.name === 'APPROVED_TOOLS_RUN_ID'
              ? runPattern.test(e.value)
              : e.value === profile)
      )
    )
      throw new Error('Invalid Control API environment')
  }
}
export function controlApiPatch({ metadata, image, imagePullPolicy, env, run }) {
  return {
    metadata: { uid: metadata.uid, resourceVersion: metadata.resourceVersion },
    spec: {
      template: {
        metadata: { annotations: { [controlApiRunAnnotation]: run } },
        spec: { containers: [{ name: 'control-api', image, imagePullPolicy, env }] },
      },
    },
  }
}
export function validateControlApiPatch(patch, profile) {
  if (
    !/^[a-zA-Z0-9-]{1,128}$/.test(patch?.metadata?.uid ?? '') ||
    !/^[0-9]{1,32}$/.test(patch?.metadata?.resourceVersion ?? '')
  )
    throw new Error('Invalid Control API object binding')
  const c = patch?.spec?.template?.spec?.containers?.[0]
  const run = patch?.spec?.template?.metadata?.annotations?.[controlApiRunAnnotation]
  if (!(run === null || runPattern.test(run))) throw new Error('Invalid Control API run binding')
  validateImage(c?.image, c?.imagePullPolicy)
  validateEnv(c?.env, profile)
  if (
    JSON.stringify(patch) !==
    JSON.stringify(controlApiPatch({ metadata: patch.metadata, ...c, run }))
  )
    throw new Error('Unexpected Control API patch fields')
  if (
    c.image === controlApiFixtureImage &&
    (run === null ||
      c.imagePullPolicy !== 'Never' ||
      JSON.stringify(c.env) !== JSON.stringify(controlApiFixtureEnv(run, profile)))
  )
    throw new Error('Incomplete Control API fixture guards')
  if (c.image !== controlApiFixtureImage && run !== null)
    throw new Error('Unexpected original Control API run binding')
}
export function controlApiFixtureEnv(run, profile) {
  return controlApiFlags.map(name => ({
    name,
    value:
      name === 'NODE_ENV'
        ? 'test'
        : name === 'EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE'
          ? '1'
          : name === 'APPROVED_TOOLS_RUN_ID'
            ? run
            : profile,
  }))
}
export function captureControlApi(deployment, profile) {
  const c = deployment?.spec?.template?.spec?.containers?.find(c => c.name === 'control-api')
  if (
    !c ||
    c.image === controlApiFixtureImage ||
    deployment.spec.template.metadata?.annotations?.[controlApiRunAnnotation] !== undefined ||
    (c.env ?? []).some(e =>
      ['EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE', 'APPROVED_TOOLS_RUN_ID'].includes(e.name)
    )
  )
    throw new Error('Control API already has test ownership')
  const affected = (c.env ?? []).filter(e => controlApiFlags.includes(e.name))
  if (new Set(affected.map(e => e.name)).size !== affected.length)
    throw new Error('Duplicate Control API environment binding')
  const snapshot = {
    metadata: {
      uid: deployment.metadata.uid,
      resourceVersion: deployment.metadata.resourceVersion,
    },
    image: c.image,
    imagePullPolicy: c.imagePullPolicy,
    env: controlApiFlags.map(
      name => c.env?.find(e => e.name === name) ?? { name, $patch: 'delete' }
    ),
  }
  validateControlApiPatch(controlApiPatch({ ...snapshot, run: null }), profile)
  return snapshot
}
export async function restoreControlApi({ state, profile, get, patch, wait }) {
  const original = state.controlApi
  if (!original) throw new Error('Missing original Control API snapshot')
  validateControlApiPatch(controlApiPatch({ ...original, run: null }), profile)
  const live = await get()
  const c = live?.spec?.template?.spec?.containers?.find(c => c.name === 'control-api')
  const run = live?.spec?.template?.metadata?.annotations?.[controlApiRunAnnotation]
  if (live?.metadata?.uid !== original.metadata.uid || !c)
    throw new Error('Control API deployment ownership changed')
  if (c.image === controlApiFixtureImage) {
    if (run !== state.run) throw new Error('Control API fixture run binding changed')
    await patch(controlApiPatch({ ...original, metadata: live.metadata, run: null }))
  } else {
    if (
      c.image !== original.image ||
      c.imagePullPolicy !== original.imagePullPolicy ||
      run !== undefined
    )
      throw new Error('Control API original deployment does not match')
    const env = controlApiFlags.map(
      name => c.env?.find(e => e.name === name) ?? { name, $patch: 'delete' }
    )
    if (JSON.stringify(env) !== JSON.stringify(original.env))
      throw new Error('Control API original environment does not match')
  }
  await wait()
}

// A failed identity cleanup must not leave the fixture API installed. A later
// owned restore may reinstall it temporarily, but only over the recorded
// original deployment after resource cleanup has completed.
export async function recoverControlApiForCleanup({ state, profile, get, patch, wait, verify }) {
  if (
    !state.identitySeedStarted ||
    state.profile !== profile ||
    !runPattern.test(state.run) ||
    !state.controlApi ||
    !state.identityJournal ||
    state.identityJournal.run !== state.run ||
    state.identityJournal.profile !== profile ||
    state.identityJournal.context !== profile ||
    !['creation-pending', 'created', 'cleanup-pending', 'recovery-required', 'cleaned'].includes(
      state.identityJournal.status
    )
  )
    throw new Error('Invalid identity cleanup recovery binding')
  if (!Array.isArray(state.resources) || state.resources.some(entry => entry.status !== 'deleted'))
    throw new Error('Resources remain before API cleanup recovery')
  if (state.identityJournal.status === 'cleaned') return false
  validateControlApiPatch(controlApiPatch({ ...state.controlApi, run: null }), profile)
  const live = await get()
  const c = live?.spec?.template?.spec?.containers?.find(c => c.name === 'control-api')
  if (live?.metadata?.uid !== state.controlApi.metadata.uid || !c)
    throw new Error('Control API deployment ownership changed')
  const run = live.spec.template.metadata?.annotations?.[controlApiRunAnnotation]
  if (c.image === controlApiFixtureImage) {
    if (run !== state.run) throw new Error('Control API fixture run binding changed')
    const affected = (c.env ?? []).filter(e => controlApiFlags.includes(e.name))
    const ordered = controlApiFlags.map(name => affected.find(e => e.name === name))
    if (
      affected.length !== controlApiFlags.length ||
      JSON.stringify(ordered) !== JSON.stringify(controlApiFixtureEnv(state.run, profile)) ||
      c.imagePullPolicy !== 'Never'
    )
      throw new Error('Control API fixture environment changed')
  } else {
    const current = captureControlApi(live, profile)
    if (
      current.image !== state.controlApi.image ||
      current.imagePullPolicy !== state.controlApi.imagePullPolicy ||
      JSON.stringify(current.env) !== JSON.stringify(state.controlApi.env)
    )
      throw new Error('Control API original deployment does not match cleanup recovery snapshot')
    const request = controlApiPatch({
      metadata: live.metadata,
      image: controlApiFixtureImage,
      imagePullPolicy: 'Never',
      env: controlApiFixtureEnv(state.run, profile),
      run: state.run,
    })
    validateControlApiPatch(request, profile)
    await patch(request)
  }
  await wait()
  await verify()
  return true
}
