import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The McpServer status schema is structural without
 * x-kubernetes-preserve-unknown-fields, so the apiserver prunes a status field
 * the CRD does not declare. HCC's applied-credentials record only persists when
 * the CRD declares it (L1a).
 */
describe('McpServer CRD status schema', () => {
  it('T-A1.13 declares status.appliedCredentialsRevision as a string', () => {
    const crd = readFileSync(
      path.join(__dirname, '../../charts/clerum-crds/crds/mcpserver.yaml'),
      'utf8'
    )
    const status = crd.split('\n            status:\n              type: object\n')[1]
    expect(status).toBeTruthy()
    const statusProperties = status?.split('\n      additionalPrinterColumns:')[0] ?? ''
    expect(statusProperties).toMatch(/\n {16}appliedCredentialsRevision:\n {18}type: string\n/)
    expect(statusProperties).not.toContain('x-kubernetes-preserve-unknown-fields')
  })
})
