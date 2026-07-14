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
})
