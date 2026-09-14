// Persist only the public fields this development fixture changes.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const changedEnvironment = [
  'CONTEXT_MAPPER_K8S_API_CIDRS',
  'CONTEXT_MAPPER_NETPOL_RESYNC_SEC',
  'KUBECONFIG',
]
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function environmentNames(env) {
  const names = env.map(item => item?.name)
  if (names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== names.length)
    throw new Error('environment_name_conflict')
  return names
}

export function snapshot(deployment) {
  const pod = deployment.spec.template.spec
  const container = pod.containers.find(item => item.name === 'host-context-controller')
  if (!deployment.metadata.uid || !container) throw new Error('deployment_identity_missing')
  if (
    (pod.volumes ?? []).some(item => item.name === 'hcc-pr-a-config') ||
    (container.volumeMounts ?? []).some(item => item.name === 'hcc-pr-a-config')
  )
    throw new Error('fixture_mount_collision')
  const env = container.env ?? []
  return {
    uid: deployment.metadata.uid,
    envPresent: own(container, 'env'),
    // The name sequence is public structure. Values remain private unless
    // this fixture owns the entry.
    envNames: environmentNames(env),
    env: env.filter(item => changedEnvironment.includes(item.name)),
    volumesPresent: own(pod, 'volumes'),
    volumes: pod.volumes ?? [],
    mountsPresent: own(container, 'volumeMounts'),
    mounts: container.volumeMounts ?? [],
  }
}
export function restorePatch(original, deployment) {
  if (deployment.metadata.uid !== original.uid) throw new Error('deployment_uid_changed')
  const pod = deployment.spec.template.spec
  const index = pod.containers.findIndex(item => item.name === 'host-context-controller')
  if (index < 0) throw new Error('deployment_container_missing')
  const container = pod.containers[index]
  const currentEnv = container.env ?? []
  const currentEnvNames = environmentNames(currentEnv)
  const originalEnvNames = original.envNames
  if (
    !Array.isArray(originalEnvNames) ||
    originalEnvNames.some(name => typeof name !== 'string' || !name) ||
    new Set(originalEnvNames).size !== originalEnvNames.length
  )
    throw new Error('environment_snapshot_invalid')
  const originalUnrelatedNames = originalEnvNames.filter(name => !changedEnvironment.includes(name))
  const currentUnrelatedNames = currentEnvNames.filter(name => !changedEnvironment.includes(name))
  if (JSON.stringify(currentUnrelatedNames) !== JSON.stringify(originalUnrelatedNames))
    throw new Error('unrelated_environment_changed')
  const originalOwnedNames = originalEnvNames.filter(name => changedEnvironment.includes(name))
  if (
    !Array.isArray(original.env) ||
    JSON.stringify(environmentNames(original.env)) !== JSON.stringify(originalOwnedNames)
  )
    throw new Error('environment_snapshot_invalid')
  for (const [current, previous] of [
    [pod.volumes ?? [], original.volumes],
    [container.volumeMounts ?? [], original.mounts],
  ]) {
    if (
      JSON.stringify(current.filter(item => item.name !== 'hcc-pr-a-config')) !==
      JSON.stringify(previous)
    ) {
      throw new Error('unrelated_configuration_changed')
    }
  }
  if (
    typeof deployment.metadata.resourceVersion !== 'string' ||
    !deployment.metadata.resourceVersion
  ) {
    throw new Error('deployment_resource_version_missing')
  }
  const patches = [
    { op: 'test', path: '/metadata/uid', value: original.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: deployment.metadata.resourceVersion },
  ]
  const set = (path, present, existed, value) => {
    if (present) patches.push({ op: 'add', path, value })
    else if (existed) patches.push({ op: 'remove', path })
  }
  const originalEnvironment = new Map(original.env.map(item => [item.name, item]))
  const currentEnvironment = new Map(currentEnv.map(item => [item.name, item]))
  const env = originalEnvNames.map(name =>
    changedEnvironment.includes(name)
      ? originalEnvironment.get(name)
      : currentEnvironment.get(name)
  )
  set(
    `/spec/template/spec/containers/${index}/env`,
    original.envPresent || env.length > 0,
    own(container, 'env'),
    env
  )
  set(
    `/spec/template/spec/containers/${index}/volumeMounts`,
    original.mountsPresent,
    own(container, 'volumeMounts'),
    original.mounts
  )
  set('/spec/template/spec/volumes', original.volumesPresent, own(pod, 'volumes'), original.volumes)
  return patches
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, originalPath] = process.argv.slice(2)
  const deployment = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (action === 'snapshot') process.stdout.write(JSON.stringify(snapshot(deployment)))
  else if (action === 'restore')
    process.stdout.write(
      JSON.stringify(restorePatch(JSON.parse(fs.readFileSync(originalPath, 'utf8')), deployment))
    )
  else if (action === 'verify') {
    const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'))
    const current = snapshot(deployment)
    if (JSON.stringify(current) !== JSON.stringify(original))
      throw new Error('configuration_not_restored')
  } else throw new Error('unknown_configuration_action')
}
