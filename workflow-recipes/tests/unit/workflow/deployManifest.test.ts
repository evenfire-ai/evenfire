import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

function readRepo(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf8')
}

describe('workflow-recipes deployment manifest', () => {
  it('sources runtime workflow limits from the shared control-api ConfigMap', () => {
    const manifest = readRepo('deploy/base/control-plane/workflow-recipes.yaml')

    for (const key of [
      'CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE',
      'CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS',
    ]) {
      expect(manifest).toMatch(
        new RegExp(
          [
            `- name: ${key}`,
            '\\s+valueFrom:',
            '\\s+configMapKeyRef:',
            '\\s+name: control-api-config',
            `\\s+key: ${key}`,
          ].join('\\n')
        )
      )
    }
  })

  // Guard for risk R3 in docs/architecture/registry-pull-secret-recipe-workloads.md.
  // WRC decides whether to attach the platform image-pull credential by comparing the
  // workload image host against its OWN CLERUM_REGISTRY_URL, while control-api mints and
  // writes that credential from its copy. When the two disagree — or WRC's is simply
  // unset, which `isPlatformRegistryImage` treats as "no platform registry" — control-api
  // still writes the Secret and returns 201, but WRC never emits `imagePullSecrets`, so
  // recipe pods sit in ImagePullBackOff while McpServer installs keep working (control-api
  // writes that reference itself). Projecting the ONE key that defines the URL makes the
  // divergence unrepresentable; a literal here would silently reintroduce it.
  it('sources the registry URL from the same control-api ConfigMap key, never a literal', () => {
    const manifest = readRepo('deploy/base/control-plane/workflow-recipes.yaml')

    expect(manifest).toMatch(
      new RegExp(
        [
          '- name: CLERUM_REGISTRY_URL',
          '\\s+valueFrom:',
          '\\s+configMapKeyRef:',
          '\\s+name: control-api-config',
          '\\s+key: CLERUM_REGISTRY_URL',
          // The base ConfigMap ships no such key (only overlays set it), so a hard
          // reference would CreateContainerConfigError on a plain `deploy/base` install.
          '\\s+optional: true',
        ].join('\\n')
      )
    )

    // Exactly one declaration, and not a hardcoded second copy of the URL.
    expect(manifest.match(/- name: CLERUM_REGISTRY_URL$/gm)?.length).toBe(1)
    expect(manifest).not.toMatch(/- name: CLERUM_REGISTRY_URL\n\s+value:/)
  })

  it('does not let the minikube overlay redeclare the registry URL it already inherits', () => {
    const patch = readRepo('deploy/overlays/minikube/patches/registry-env.yaml')

    expect(patch).not.toMatch(/- name: CLERUM_REGISTRY_URL$/m)
  })
})
