import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// Parses charts/clerum-crds/crds/host.yaml the same way
// crd.secretReferenceCoverage.test.ts does. The approval mode ceiling is an
// admission enum, and allowModeChange exists only on the three channel objects
// the control-api schema accepts.
const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')
const hostYamlPath = resolve(crdsDir, 'host.yaml')

const APPROVAL_MODES = ['manual', 'auto', 'allow_all'] as const
const MODE_CHANNELS = ['telegram', 'email', 'slack', 'teams'] as const

type AllowModeChangeHit = { path: string; type: unknown }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function approvalProperties(document: unknown): Record<string, unknown> {
  const versions = asRecord(asRecord(document)?.spec)?.versions
  if (!Array.isArray(versions)) throw new Error('host.yaml has no spec.versions')
  const stored = versions.find(version => asRecord(version)?.storage === true) ?? versions[0]
  const openApi = asRecord(asRecord(asRecord(stored)?.schema)?.openAPIV3Schema)
  const specProperties = asRecord(asRecord(asRecord(openApi?.properties)?.spec)?.properties)
  const approval = asRecord(asRecord(specProperties?.approval)?.properties)
  if (!approval) throw new Error('host.yaml has no spec.approval properties')
  return approval
}

function collectAllowModeChange(
  node: unknown,
  path = '',
  hits: AllowModeChangeHit[] = []
): AllowModeChangeHit[] {
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectAllowModeChange(child, `${path}[${index}]`, hits))
    return hits
  }
  const record = asRecord(node)
  if (!record) return hits
  for (const [key, value] of Object.entries(record)) {
    const next = path ? `${path}.${key}` : key
    if (key === 'allowModeChange') {
      hits.push({ path: next, type: asRecord(value)?.type })
    }
    collectAllowModeChange(value, next, hits)
  }
  return hits
}

describe('host.yaml approval mode schema', () => {
  const raw = readFileSync(hostYamlPath, 'utf8')
  const document = parse(raw)
  const approval = approvalProperties(document)

  it('modeCeiling is exactly manual, auto, and allow_all', () => {
    expect(asRecord(approval.modeCeiling)?.enum).toEqual([...APPROVAL_MODES])
  })

  it('allowModeChange is a boolean under telegram, email, slack and teams', () => {
    const channels = asRecord(asRecord(approval.channels)?.properties)
    expect(channels && Object.keys(channels).sort()).toEqual([...MODE_CHANNELS].sort())

    const hits = collectAllowModeChange(document, '')
    const channelOf = (path: string) => {
      const match =
        /approval\.properties\.channels\.properties\.(telegram|email|slack|teams)\.properties\.allowModeChange$/.exec(
          path
        )
      return match?.[1]
    }
    expect(hits.map(hit => channelOf(hit.path)).sort()).toEqual([...MODE_CHANNELS].sort())
    for (const hit of hits) {
      expect(hit.type).toBe('boolean')
      expect(channelOf(hit.path)).toBeDefined()
    }
  })

  // The apiserver fills these defaults into any channel block that omits the
  // field, so they must match mcp-host's readChannelCap defaults. A `true` on
  // email would open the forgeable From-address channel whenever a block exists.
  it('allowModeChange defaults to off on email and on for the other channels', () => {
    const channels = asRecord(asRecord(approval.channels)?.properties)
    const defaults = Object.fromEntries(
      MODE_CHANNELS.map(channel => [
        channel,
        asRecord(asRecord(asRecord(channels?.[channel])?.properties)?.allowModeChange)?.default,
      ])
    )
    expect(defaults).toEqual({ telegram: true, email: false, slack: true, teams: true })
  })

  it('marks the new approval fields with the CRD-first rollout note', () => {
    const start = raw.indexOf('\n                approval:')
    const end = raw.indexOf('\n                desktop:')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const approvalBlock = raw.slice(start, end)
    expect(approvalBlock).toContain('ROLLOUT ORDER — CRD FIRST')
    expect(approvalBlock).toContain('modeCeiling')
    expect(approvalBlock).toContain('allowModeChange')
  })
})
