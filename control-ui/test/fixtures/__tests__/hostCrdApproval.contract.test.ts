import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import {
  defaultApprovalBlock,
  loadHostCrdApprovalSchema,
  pruneApprovalBlock,
} from '../hostCrdApproval'

const HOST_CRD = resolve(__dirname, '../../../../charts/clerum-crds/crds/host.yaml')

describe('Host CRD approval-schema fixtures', () => {
  it('current fixture equals the approval schema parsed from charts/clerum-crds/crds/host.yaml', () => {
    const crd = parse(readFileSync(HOST_CRD, 'utf8')) as {
      spec: { versions: { schema: { openAPIV3Schema: { properties: any } } }[] }
    }
    const approval = crd.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.approval
    const schema = loadHostCrdApprovalSchema('current')
    expect(schema.approvalProperties).toEqual(approval.properties)
    expect(schema.channelNames).toEqual(Object.keys(approval.properties.channels.properties))
  })

  it('current defaults allowModeChange true for telegram, slack, teams and false for email', () => {
    const schema = loadHostCrdApprovalSchema('current')
    expect(schema.allowModeChangeDefaults).toEqual({
      telegram: true,
      slack: true,
      teams: true,
      email: false,
    })
    expect(
      defaultApprovalBlock(
        { channels: { telegram: {}, email: {}, slack: { enabled: true } } },
        schema
      )
    ).toEqual({
      channels: {
        telegram: { allowModeChange: true },
        email: { allowModeChange: false },
        slack: { enabled: true, allowModeChange: true },
      },
    })
    // Absent channel blocks are not created.
    expect(defaultApprovalBlock({ defaultPolicy: 'cli_only' }, schema)).toEqual({
      defaultPolicy: 'cli_only',
    })
  })

  it('v0.12.1 prunes modeCeiling, shellClassifierModel, allowModeChange and teams', () => {
    const schema = loadHostCrdApprovalSchema('v0.12.1')
    expect(
      pruneApprovalBlock(
        {
          modeCeiling: 'auto',
          shellClassifierModel: 'x',
          tools: { a: true },
          channels: { teams: {}, telegram: { allowModeChange: true, enabled: true } },
        },
        schema
      )
    ).toEqual({ tools: { a: true }, channels: { telegram: { enabled: true } } })
    expect(schema.allowModeChangeDefaults).toEqual({})
  })

  it('current keeps every field it declares', () => {
    const schema = loadHostCrdApprovalSchema('current')
    const block = {
      defaultPolicy: 'designated_approvers',
      modeCeiling: 'auto',
      shellClassifierModel: 'x',
      tools: { a: true },
      channels: {
        telegram: { enabled: true, approvers: ['1'], allowModeChange: false },
        email: { enabled: true, approvers: ['a@b.c'], allowModeChange: true },
        slack: { enabled: false, approvers: [], allowModeChange: true },
        teams: { enabled: true, approvers: ['t'], allowModeChange: false },
      },
    }
    expect(pruneApprovalBlock(block, schema)).toEqual(block)
    expect(pruneApprovalBlock({ unknown: 1, channels: { nope: {} } }, schema)).toEqual({
      channels: {},
    })
  })

  it.each(['current', 'v0.12.1'] as const)('%s _source records the command and a sha256', v => {
    const { _source } = loadHostCrdApprovalSchema(v)
    expect(_source.command).toEqual(expect.any(String))
    expect(_source.command.length).toBeGreaterThan(0)
    expect(_source.sha256).toMatch(/^[0-9a-f]{64}$/)
    if (v === 'v0.12.1') {
      expect(_source.command).toContain('git show v0.12.1:charts/clerum-crds/crds/host.yaml')
    }
  })
})
