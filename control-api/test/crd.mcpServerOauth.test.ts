import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// CRD-admission invariants for the OAuth mcp-server surface (U1). These are
// K8s-apiserver rules, not control-api code paths, so we assert the CRD YAML
// structurally. NOTE: CEL SEMANTICS (create-context passes / update-change
// fails / none→oauth passes) are enforced by the apiserver's CEL evaluator at
// admission time and cannot be executed here (no CEL evaluator is vendored).
// We assert the rule STRINGS are present and shaped as transition rules
// (has()-guarded on oldSelf). Semantic verification requires `kubectl
// --dry-run=server` against a live cluster.
const crdPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../charts/clerum-crds/crds/mcpserver.yaml'
)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc: any = parse(readFileSync(crdPath, 'utf8'))
const specSchema = doc.spec.versions[0].schema.openAPIV3Schema.properties.spec
const specRules: Array<{ rule: string; message: string }> = specSchema['x-kubernetes-validations']

describe('McpServer CRD — OAuth surface (U1)', () => {
  it("adds 'oauth' to spec.auth.type enum", () => {
    expect(specSchema.properties.auth.properties.type.enum).toContain('oauth')
  })

  it('defines spec.oauth with the required client fields', () => {
    const oauth = specSchema.properties.oauth
    expect(oauth.type).toBe('object')
    expect(oauth.required).toEqual(
      expect.arrayContaining(['id', 'provider', 'clientIdRef', 'clientSecretRef'])
    )
    for (const p of [
      'id',
      'provider',
      'clientIdRef',
      'clientSecretRef',
      'scopes',
      'backgroundAccess',
      'grantScope',
    ]) {
      expect(oauth.properties).toHaveProperty(p)
    }
  })

  it('grantScope is enum [user, context], default user, nested under spec.oauth', () => {
    const grantScope = specSchema.properties.oauth.properties.grantScope
    expect(grantScope.enum).toEqual(['user', 'context'])
    expect(grantScope.default).toBe('user')
  })

  it('provider enum lists exactly the adapters shipped today (U2 adds monday/clickup/vercel)', () => {
    expect(specSchema.properties.oauth.properties.provider.enum).toEqual([
      'salesforce',
      'slack',
      'notion',
      'microsoft-graph',
      'google',
      'monday',
      'clickup',
      'vercel',
    ])
  })

  it('couples auth.type==oauth with spec.oauth presence', () => {
    const rule = specRules.find(
      r => r.rule.includes("self.auth.type == 'oauth'") && r.rule.includes('has(self.oauth)')
    )
    expect(rule, 'oauth coupling rule present').toBeDefined()
  })

  it('forbids a static secretRef/secretKey on an oauth server', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes('has(self.oauth)') &&
        r.rule.includes('secretRef') &&
        r.rule.includes('secretKey')
    )
    expect(rule, 'no-static-credential rule present').toBeDefined()
  })

  it('makes grantScope/id/provider immutable via has()-guard transition rules (skipped on create, enforced on update)', () => {
    for (const field of ['grantScope', 'id', 'provider']) {
      const rule = specRules.find(
        r =>
          r.rule.includes(`oldSelf.oauth.${field}`) &&
          r.rule.includes(`self.oauth.${field}`) &&
          r.rule.includes('!has(oldSelf.oauth)')
      )
      expect(rule, `immutability rule for oauth.${field} present and oldSelf-guarded`).toBeDefined()
    }
  })
})
