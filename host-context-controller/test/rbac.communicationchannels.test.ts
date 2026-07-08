import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as YAML from 'yaml'

describe('host-context-controller-channels-runtime Role includes communicationchannels (#281)', () => {
  it('grants get/list/watch on communicationchannels.clerum.io', () => {
    const rbacPath = path.resolve(__dirname, '../../deploy/base/channels/rbac.yaml')
    const text = fs.readFileSync(rbacPath, 'utf-8')
    const docs = YAML.parseAllDocuments(text).map(d => d.toJSON())
    const role = docs.find(
      (d: any) =>
        d?.kind === 'Role' && d?.metadata?.name === 'host-context-controller-channels-runtime'
    )
    expect(role).toBeDefined()
    const rule = (
      role.rules as Array<{ apiGroups?: string[]; resources?: string[]; verbs?: string[] }>
    ).find(
      r => r.apiGroups?.includes('clerum.io') && r.resources?.includes('communicationchannels')
    )
    expect(rule).toBeDefined()
    // Strict equality — the test must catch privilege-escalation regressions
    // (e.g. adding `create`/`update`/`delete`). CC CRUD belongs to control-api,
    // not HCC.
    expect(rule!.verbs?.slice().sort()).toEqual(['get', 'list', 'watch'])
  })

  it('grants only the Secret verbs needed for per-host channel-reader runtime auth', () => {
    const rbacPath = path.resolve(__dirname, '../../deploy/base/channels/rbac.yaml')
    const text = fs.readFileSync(rbacPath, 'utf-8')
    const docs = YAML.parseAllDocuments(text).map(d => d.toJSON())
    const role = docs.find(
      (d: any) =>
        d?.kind === 'Role' && d?.metadata?.name === 'host-context-controller-channels-runtime'
    )
    expect(role).toBeDefined()
    const rule = (
      role.rules as Array<{ apiGroups?: string[]; resources?: string[]; verbs?: string[] }>
    ).find(r => r.apiGroups?.includes('') && r.resources?.includes('secrets'))
    expect(rule).toBeDefined()
    expect(rule!.verbs?.slice().sort()).toEqual([
      'create',
      'delete',
      'get',
      'list',
      'update',
      'watch',
    ])
    expect(rule!.verbs).not.toContain('patch')
  })
})
