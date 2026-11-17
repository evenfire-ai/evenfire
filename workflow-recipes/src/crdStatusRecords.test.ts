import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Issue #1349 — the WorkflowRecipe status schema is closed: a status field the
// CRD does not declare is pruned by the API server, so the controller's run
// records only persist when the shipped CRD declares them.

type SchemaNode = {
  type?: string
  format?: string
  properties?: Record<string, SchemaNode>
  additionalProperties?: SchemaNode
}

type CrdDocument = {
  spec: {
    versions: Array<{
      name: string
      served: boolean
      schema: { openAPIV3Schema: SchemaNode }
    }>
  }
}

function servedStatusSchema(): SchemaNode {
  const crdPath = resolve(__dirname, '../../charts/clerum-crds/crds/workflowrecipe.yaml')
  const crd = load(readFileSync(crdPath, 'utf8')) as CrdDocument
  const served = crd.spec.versions.filter(version => version.served)
  expect(served).toHaveLength(1)
  const status = served[0].schema.openAPIV3Schema.properties?.status
  expect(status).toBeDefined()
  return status!
}

describe('WorkflowRecipe CRD status records (issue #1349)', () => {
  it('declares the terminal run teardown record', () => {
    const status = servedStatusSchema()

    // Witness: this is the status node (an existing status field is there).
    expect(status.properties?.workloadInstances).toBeDefined()
    const record = status.properties?.terminalRunTeardown
    expect(record?.type).toBe('object')
    expect(record?.properties?.completedAt).toEqual(
      expect.objectContaining({ type: 'string', format: 'date-time' })
    )
    expect(record?.properties?.noSecretBearingWorkloads).toEqual(
      expect.objectContaining({ type: 'boolean' })
    )
  })

  it('declares the Secret ownership revocation record as a string map', () => {
    const status = servedStatusSchema()

    expect(status.properties?.workloadInstances).toBeDefined()
    const record = status.properties?.secretOwnershipRevocations
    expect(record?.type).toBe('object')
    expect(record?.additionalProperties?.type).toBe('string')
  })
})
