import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { K8S_CONTEXT } from '../workflowUi'

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function kubectlOut(args: string[], input?: string, timeout = 20_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout,
  })
}

export function kubectlJson<T>(args: string[], timeout = 10_000): T {
  return JSON.parse(kubectlOut(args, undefined, timeout)) as T
}

export function profilesSql(sql: string, timeout = 20_000): string {
  const pod = kubectlOut(
    [
      '-n',
      'control-plane',
      'get',
      'pod',
      '-l',
      'app=control-postgres',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    undefined,
    10_000
  ).trim()

  return kubectlOut(
    [
      '-n',
      'control-plane',
      'exec',
      pod,
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-tA',
      '-c',
      sql,
    ],
    undefined,
    timeout
  ).trim()
}

export function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function cleanupWorkflowRuntimeResources(namespace: string, recipeName: string): void {
  const resourceTypes = ['pod', 'deployment', 'service', 'secret', 'configmap', 'pvc']

  for (const resourceType of resourceTypes) {
    const raw = kubectlOut(['-n', namespace, 'get', resourceType, '-o', 'json'], undefined, 10_000)
    const parsed = JSON.parse(raw) as {
      items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }>
    }
    const names = (parsed.items ?? [])
      .filter(item => {
        const name = item.metadata?.name ?? ''
        const recipeLabel = item.metadata?.labels?.['clerum.io/recipe'] ?? ''
        return (
          name.startsWith(`${recipeName}-`) ||
          name.startsWith(`wf-${recipeName}-`) ||
          recipeLabel === recipeName ||
          recipeLabel.startsWith(`${recipeName}-`)
        )
      })
      .map(item => item.metadata?.name)
      .filter((name): name is string => Boolean(name))

    if (names.length === 0) continue

    kubectlOut(
      [
        '-n',
        namespace,
        'delete',
        resourceType,
        ...names,
        '--ignore-not-found=true',
        '--wait=false',
      ],
      undefined,
      30_000
    )
  }
}

function quadrantRuntimeResourceNames(namespace: string, resourceType: string): string[] {
  const raw = kubectlOut(['-n', namespace, 'get', resourceType, '-o', 'json'], undefined, 10_000)
  const parsed = JSON.parse(raw) as {
    items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }>
  }

  return (parsed.items ?? [])
    .filter(item => {
      const name = item.metadata?.name ?? ''
      const recipeLabel = item.metadata?.labels?.['clerum.io/recipe'] ?? ''
      return (
        name.startsWith('e2e-quadrant-') ||
        name.startsWith('wf-e2e-quadrant-') ||
        recipeLabel.startsWith('e2e-quadrant-')
      )
    })
    .map(item => item.metadata?.name)
    .filter((name): name is string => Boolean(name))
}

export function cleanupWorkflowQuadrantRuntimeResidues(namespace: string): void {
  const resourceTypes = ['pod', 'deployment', 'service', 'secret', 'configmap', 'pvc']

  for (const resourceType of resourceTypes) {
    const names = quadrantRuntimeResourceNames(namespace, resourceType)
    if (names.length === 0) continue

    kubectlOut(
      [
        '-n',
        namespace,
        'delete',
        resourceType,
        ...names,
        '--ignore-not-found=true',
        '--wait=false',
      ],
      undefined,
      30_000
    )
  }
}

export async function waitForNoWorkflowQuadrantRuntimeResidues(namespace: string): Promise<void> {
  const resourceTypes = ['pod', 'deployment', 'service', 'secret', 'configmap', 'pvc']

  for (let attempt = 0; attempt < 30; attempt += 1) {
    cleanupWorkflowQuadrantRuntimeResidues(namespace)
    const remaining = resourceTypes.flatMap(resourceType =>
      quadrantRuntimeResourceNames(namespace, resourceType)
    )
    if (remaining.length === 0) return
    await waitMs(1000)
  }
}

export async function waitForNoWorkflowPods(namespace: string, recipeName: string): Promise<void> {
  let emptyStreak = 0

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const raw = kubectlOut(
      ['-n', namespace, 'get', 'pods', '-l', 'clerum.io/managed-by=wrc', '-o', 'json'],
      undefined,
      10_000
    )
    const parsed = JSON.parse(raw) as {
      items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }>
    }
    const pods = (parsed.items ?? [])
      .filter(item => {
        const podName = item.metadata?.name ?? ''
        const recipeLabel = item.metadata?.labels?.['clerum.io/recipe'] ?? ''
        return (
          podName.startsWith(`${recipeName}-`) ||
          recipeLabel === recipeName ||
          recipeLabel.startsWith(`${recipeName}-`)
        )
      })
      .map(item => item.metadata?.name)
      .filter((podName): podName is string => Boolean(podName))

    if (pods.length > 0) {
      emptyStreak = 0
      kubectlOut(
        ['-n', namespace, 'delete', 'pod', ...pods, '--ignore-not-found=true', '--wait=false'],
        undefined,
        30_000
      )
    } else {
      emptyStreak += 1
      if (attempt >= 12 && emptyStreak >= 5) return
    }

    await waitMs(1000)
  }
}

export function expectDeploymentReady(namespace: string, deployment: string): void {
  const ready = kubectlOut(
    [
      '-n',
      namespace,
      'get',
      'deploy',
      deployment,
      '-o',
      'jsonpath={.status.readyReplicas}/{.spec.replicas}',
    ],
    undefined,
    10_000
  ).trim()

  expect(ready).toBe('1/1')
}
