import type * as k8s from '@kubernetes/client-node'

/**
 * Apply documented apps/v1 defaulting onto a desired Deployment. Unlike
 * `asApiserverService`, this is not a recorded-blob overlay: it fills fields
 * the apiserver would default-fill, leaving every HCC-authored value intact.
 * Container `imagePullPolicy` follows kube `DefaultImagePullPolicy` (Always
 * for `:latest` / untagged; IfNotPresent otherwise). Refresh this function
 * when a live `kubectl get deploy -o json` reveals a default the fixture
 * does not model (PR G §8).
 */
const SERVER_TIME = new Date('2026-04-01T00:00:00.000Z')
const SERVER_UID = '11111111-2222-3333-4444-555555555555'
const SERVER_RESOURCE_VERSION = '1776125'

export function asApiserverDeployment(desired: k8s.V1Deployment): k8s.V1Deployment {
  const live = structuredClone(desired)
  applyServerOwnedMetadata(live)
  applyDeploymentSpecDefaults(live.spec)
  return live
}

function applyServerOwnedMetadata(deployment: k8s.V1Deployment): void {
  const name = deployment.metadata?.name ?? 'unnamed'
  const namespace = deployment.metadata?.namespace ?? 'default'
  deployment.metadata = {
    ...deployment.metadata,
    annotations: {
      ...deployment.metadata?.annotations,
      'deployment.kubernetes.io/revision':
        deployment.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '1',
    },
    creationTimestamp: SERVER_TIME,
    generation: 1,
    managedFields: [
      {
        apiVersion: 'apps/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: { 'f:spec': { 'f:template': {} } },
        manager: 'kube-apiserver',
        operation: 'Update',
        time: SERVER_TIME,
      },
    ],
    resourceVersion: SERVER_RESOURCE_VERSION,
    uid: SERVER_UID,
    selfLink: `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
  }
  deployment.status = {
    observedGeneration: 1,
    replicas: deployment.spec?.replicas ?? 1,
    readyReplicas: 0,
    updatedReplicas: 0,
    unavailableReplicas: deployment.spec?.replicas ?? 1,
    conditions: [],
  }
}

function applyDeploymentSpecDefaults(spec: k8s.V1Deployment['spec']): void {
  if (!spec) return
  if (spec.replicas === undefined) spec.replicas = 1
  if (spec.progressDeadlineSeconds === undefined) spec.progressDeadlineSeconds = 600
  if (spec.revisionHistoryLimit === undefined) spec.revisionHistoryLimit = 10
  if (spec.minReadySeconds === undefined) spec.minReadySeconds = 0
  if (spec.paused === undefined) spec.paused = false
  if (!spec.strategy) {
    spec.strategy = {
      type: 'RollingUpdate',
      rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' },
    }
  }

  const template = spec.template
  if (!template) return
  if (template.metadata && template.metadata.creationTimestamp === undefined) {
    template.metadata.creationTimestamp = SERVER_TIME
  }
  applyPodSpecDefaults(template.spec)
}

function applyPodSpecDefaults(podSpec: k8s.V1PodSpec | undefined): void {
  if (!podSpec) return
  if (podSpec.restartPolicy === undefined) podSpec.restartPolicy = 'Always'
  if (podSpec.dnsPolicy === undefined) podSpec.dnsPolicy = 'ClusterFirst'
  if (podSpec.schedulerName === undefined) podSpec.schedulerName = 'default-scheduler'
  if (podSpec.terminationGracePeriodSeconds === undefined) {
    podSpec.terminationGracePeriodSeconds = 30
  }
  if (podSpec.enableServiceLinks === undefined) podSpec.enableServiceLinks = true
  if (podSpec.preemptionPolicy === undefined) podSpec.preemptionPolicy = 'PreemptLowerPriority'
  if (!podSpec.serviceAccountName) podSpec.serviceAccountName = 'default'
  if (podSpec.serviceAccount === undefined) podSpec.serviceAccount = podSpec.serviceAccountName

  for (const container of [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])]) {
    applyContainerDefaults(container)
  }
  for (const volume of podSpec.volumes ?? []) applyVolumeDefaults(volume)
}

function applyContainerDefaults(container: k8s.V1Container): void {
  if (container.imagePullPolicy === undefined) {
    container.imagePullPolicy = defaultImagePullPolicy(container.image)
  }
  if (container.terminationMessagePath === undefined) {
    container.terminationMessagePath = '/dev/termination-log'
  }
  if (container.terminationMessagePolicy === undefined) {
    container.terminationMessagePolicy = 'File'
  }
  for (const port of container.ports ?? []) {
    if (port.protocol === undefined) port.protocol = 'TCP'
  }
  applyProbeDefaults(container.startupProbe)
  applyProbeDefaults(container.livenessProbe)
  applyProbeDefaults(container.readinessProbe)
  for (const env of container.env ?? []) {
    if (env.valueFrom?.fieldRef && env.valueFrom.fieldRef.apiVersion === undefined) {
      env.valueFrom.fieldRef.apiVersion = 'v1'
    }
  }
}

function applyProbeDefaults(probe: k8s.V1Probe | undefined): void {
  if (!probe) return
  if (probe.initialDelaySeconds === undefined) probe.initialDelaySeconds = 0
  if (probe.timeoutSeconds === undefined) probe.timeoutSeconds = 1
  if (probe.periodSeconds === undefined) probe.periodSeconds = 10
  if (probe.successThreshold === undefined) probe.successThreshold = 1
  if (probe.failureThreshold === undefined) probe.failureThreshold = 3
  if (probe.httpGet && probe.httpGet.scheme === undefined) probe.httpGet.scheme = 'HTTP'
}

/**
 * Mirror kube `DefaultImagePullPolicy` / `tags.Latest`: Always when the
 * reference has no tag or the tag is `latest`; IfNotPresent for any other
 * tag or a digest. This is not a full docker-reference parser.
 */
function defaultImagePullPolicy(image: string | undefined): 'Always' | 'IfNotPresent' {
  if (!image) return 'Always'
  if (image.includes('@')) return 'IfNotPresent'
  const slash = image.lastIndexOf('/')
  const name = slash === -1 ? image : image.slice(slash + 1)
  const colon = name.lastIndexOf(':')
  if (colon === -1) return 'Always'
  return name.slice(colon + 1) === 'latest' ? 'Always' : 'IfNotPresent'
}

function applyVolumeDefaults(volume: k8s.V1Volume): void {
  if (volume.secret && volume.secret.defaultMode === undefined) volume.secret.defaultMode = 420
  if (volume.secret && volume.secret.optional === undefined) volume.secret.optional = false
  if (volume.configMap && volume.configMap.defaultMode === undefined) {
    volume.configMap.defaultMode = 420
  }
  if (volume.configMap && volume.configMap.optional === undefined) volume.configMap.optional = false
  if (volume.downwardAPI && volume.downwardAPI.defaultMode === undefined) {
    volume.downwardAPI.defaultMode = 420
  }
  if (volume.projected && volume.projected.defaultMode === undefined) {
    volume.projected.defaultMode = 420
  }
  if (volume.persistentVolumeClaim && volume.persistentVolumeClaim.readOnly === undefined) {
    volume.persistentVolumeClaim.readOnly = false
  }
}
