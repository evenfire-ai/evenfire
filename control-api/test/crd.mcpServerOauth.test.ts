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

  it('drops the block-level required and enforces the baked quartet via CEL (BAKED-REQ)', () => {
    const oauth = specSchema.properties.oauth
    expect(oauth.type).toBe('object')
    // The static block-level required is gone — requiredness is now carril-specific
    // (baked vs remote) and enforced by CEL, not by a single required list.
    expect(oauth.required).toBeUndefined()
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
    const bakedReq = specRules.find(
      r =>
        r.rule.includes('has(self.oauth.source)') &&
        r.rule.includes('has(self.oauth.id)') &&
        r.rule.includes('has(self.oauth.provider)') &&
        r.rule.includes('has(self.oauth.clientIdRef)') &&
        r.rule.includes('has(self.oauth.clientSecretRef)')
    )
    expect(bakedReq, 'BAKED-REQ rule present').toBeDefined()
  })

  it('exposes source as an optional enum[remote] carril discriminator (no default, not required)', () => {
    const oauth = specSchema.properties.oauth
    const source = oauth.properties.source
    expect(source.type).toBe('string')
    expect(source.enum).toEqual(['remote'])
    expect(source).not.toHaveProperty('default')
    // Never in a (now-absent) block-level required list.
    expect(oauth.required).toBeUndefined()
  })

  it('declares the remote-carril properties (clientMode enum [public, confidential])', () => {
    const props = specSchema.properties.oauth.properties
    for (const p of [
      'source',
      'clientMode',
      'authorizationEndpoint',
      'tokenEndpoint',
      'registrationEndpoint',
      'issuer',
      'resource',
      'issForCallback',
      'bearerInBody',
      'supportsRefresh',
    ]) {
      expect(props).toHaveProperty(p)
    }
    expect(props.clientMode.enum).toEqual(['public', 'confidential'])
    // bearerInBody/supportsRefresh must carry NO default (a default makes has()
    // always true and voids the REMOTE-REQ presence check).
    expect(props.bearerInBody).not.toHaveProperty('default')
    expect(props.supportsRefresh).not.toHaveProperty('default')
  })

  it('loosens oauth.id to maxLength 512 with no structural pattern, re-narrowed for baked by CEL', () => {
    const id = specSchema.properties.oauth.properties.id
    expect(id.maxLength).toBe(512)
    expect(id).not.toHaveProperty('pattern')
    const slugRule = specRules.find(
      r =>
        r.rule.includes("self.oauth.id.matches('^[a-z0-9-]{1,63}$')") &&
        r.rule.includes('has(self.oauth.source)')
    )
    expect(slugRule, 'baked-slug CEL rule present and gated on source').toBeDefined()
  })

  it('loosens oauth.scopes caps to maxItems 128 / items.maxLength 512 (large-AS installs)', () => {
    const scopes = specSchema.properties.oauth.properties.scopes
    expect(scopes.maxItems).toBe(128)
    expect(scopes.items.maxLength).toBe(512)
  })

  it('requires the remote client shape via CEL (REMOTE-REQ)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes('!has(self.oauth.source)') &&
        r.rule.includes('has(self.oauth.clientMode)') &&
        r.rule.includes('has(self.oauth.authorizationEndpoint)') &&
        r.rule.includes('has(self.oauth.tokenEndpoint)') &&
        r.rule.includes('has(self.oauth.issuer)') &&
        r.rule.includes('has(self.oauth.resource)') &&
        r.rule.includes('has(self.oauth.bearerInBody)') &&
        r.rule.includes('has(self.oauth.supportsRefresh)')
    )
    expect(rule, 'REMOTE-REQ rule present').toBeDefined()
  })

  it('forbids provider on the remote carril (REMOTE-FORBID-PROVIDER)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes('!has(self.oauth.source)') &&
        r.rule.includes('!has(self.oauth.provider)') &&
        !r.rule.includes('has(self.oauth.clientMode)')
    )
    expect(rule, 'REMOTE-FORBID-PROVIDER rule present').toBeDefined()
    expect(rule?.message).toMatch(/must not set provider/)
  })

  it('forbids remote-only fields on the baked carril (BAKED-FORBID-REMOTE-FIELDS)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes('has(self.oauth.source)') &&
        r.rule.includes('!has(self.oauth.clientMode)') &&
        r.rule.includes('!has(self.oauth.authorizationEndpoint)') &&
        r.rule.includes('!has(self.oauth.tokenEndpoint)') &&
        r.rule.includes('!has(self.oauth.registrationEndpoint)') &&
        r.rule.includes('!has(self.oauth.issuer)') &&
        r.rule.includes('!has(self.oauth.resource)') &&
        r.rule.includes('!has(self.oauth.issForCallback)') &&
        r.rule.includes('!has(self.oauth.bearerInBody)') &&
        r.rule.includes('!has(self.oauth.supportsRefresh)')
    )
    expect(rule, 'BAKED-FORBID-REMOTE-FIELDS rule present').toBeDefined()
  })

  it('has()-guards the id and provider value immutability rules against a remote UPDATE (IMM-2/IMM-4)', () => {
    const idRule = specRules.find(
      r =>
        r.rule.includes('oldSelf.oauth.id == self.oauth.id') &&
        r.rule.includes('!has(oldSelf.oauth.id)') &&
        r.rule.includes('!has(self.oauth.id)')
    )
    expect(idRule, 'id value immutability rule is coordinate-presence guarded').toBeDefined()
    const providerRule = specRules.find(
      r =>
        r.rule.includes('oldSelf.oauth.provider == self.oauth.provider') &&
        r.rule.includes('!has(oldSelf.oauth.provider)') &&
        r.rule.includes('!has(self.oauth.provider)')
    )
    expect(
      providerRule,
      'provider value immutability rule is coordinate-presence guarded'
    ).toBeDefined()
  })

  it('pins id presence (IMM-3), the carril (IMM-5) and remote endpoints (IMM-6) as immutable', () => {
    const imm3 = specRules.find(r => r.rule.includes('has(oldSelf.oauth.id) == has(self.oauth.id)'))
    expect(imm3, 'IMM-3 id-presence immutability present').toBeDefined()
    const imm5 = specRules.find(r =>
      r.rule.includes('has(oldSelf.oauth.source) == has(self.oauth.source)')
    )
    expect(imm5, 'IMM-5 carril immutability present').toBeDefined()
    const imm6 = specRules.find(
      r =>
        r.rule.includes(
          'oldSelf.oauth.authorizationEndpoint == self.oauth.authorizationEndpoint'
        ) && r.rule.includes('oldSelf.oauth.clientMode == self.oauth.clientMode')
    )
    expect(imm6, 'IMM-6 remote pinned-endpoint immutability present').toBeDefined()
    // IMM-6 also pins the discovery-derived quirks (bearerInBody, supportsRefresh)
    // so an update-RBAC actor cannot flip the fail-closed refresh decision (D-8).
    expect(imm6?.rule).toContain('oldSelf.oauth.bearerInBody == self.oauth.bearerInBody')
    expect(imm6?.rule).toContain('oldSelf.oauth.supportsRefresh == self.oauth.supportsRefresh')
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

  it('makes spec.contextRef immutable for oauth servers via oldSelf-guarded transition rule (M1)', () => {
    // M1 (@alfredolopez80, PR #317): contextRef is the authoritative
    // shared-identity coordinate for a grantScope:'context' oauth server, so
    // it must be pinned once oauth exists. oauth-guarded (!has(oldSelf.oauth)
    // short-circuit) so non-oauth servers can still be re-parented by WRC.
    // Presence-only assertion — CEL semantics are enforced by the apiserver
    // at admission (verify with `kubectl --dry-run=server`), not here.
    const rule = specRules.find(
      r =>
        r.rule.includes('self.contextRef == oldSelf.contextRef') &&
        r.rule.includes('!has(oldSelf.oauth)')
    )
    expect(rule, 'contextRef immutability rule present and oauth/oldSelf-guarded').toBeDefined()
    expect(rule?.message).toMatch(/contextRef is immutable/)
  })
})
