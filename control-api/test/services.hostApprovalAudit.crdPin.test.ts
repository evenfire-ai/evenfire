/**
 * DEFAULT_POLICIES (the audit's copy of the Host CRD `defaultPolicy` enum) must
 * equal the enum of the CRD fixture control-ui records
 * (control-ui/test/fixtures/wire/host-crd-approval.current.json).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_POLICIES, FIELD_ENUMS } from '../src/services/hostApprovalAudit.js'

const CRD = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../control-ui/test/fixtures/wire/host-crd-approval.current.json'),
    'utf8'
  )
) as { approvalProperties: { defaultPolicy: { enum: string[] }; modeCeiling: { enum: string[] } } }

describe('DEFAULT_POLICIES', () => {
  it('equals the defaultPolicy enum of the Host CRD fixture', () => {
    const crdEnum = CRD.approvalProperties.defaultPolicy.enum
    expect(crdEnum.length).toBeGreaterThanOrEqual(3)
    expect([...DEFAULT_POLICIES].sort()).toEqual([...crdEnum].sort())
  })

  it('the shortening rule keeps the same enums for defaultPolicy and modeCeiling', () => {
    expect([...(FIELD_ENUMS.defaultPolicy ?? [])].sort()).toEqual(
      [...CRD.approvalProperties.defaultPolicy.enum].sort()
    )
    expect([...(FIELD_ENUMS.modeCeiling ?? [])].sort()).toEqual(
      [...CRD.approvalProperties.modeCeiling.enum].sort()
    )
  })
})
