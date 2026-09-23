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

  it('exposes source as an optional enum[remote, generic] carril discriminator (no default, not required)', () => {
    const oauth = specSchema.properties.oauth
    const source = oauth.properties.source
    expect(source.type).toBe('string')
    expect(source.enum).toEqual(['remote', 'generic'])
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

  // ---------------------------------------------------------------------------
  // S3.1 — the 'generic' self-hosted carril (source: 'generic'). Same
  // structural-assertion contract as the rest of this file: we parse the YAML
  // and assert the rule STRINGS and field shapes; no CEL evaluator is vendored.
  //
  // GUARD-SAFETY REASONING (why a generic UPDATE never CEL-ERRORs): every rule
  // that dereferences a generic-only field is double-source-VALUE-guarded — it
  // short-circuits on `self.oauth.source != 'generic'` (and, for transition
  // rules, `oldSelf.oauth.source != 'generic'`) BEFORE touching any generic
  // field, so it only evaluates the value block when the revision(s) are
  // actually generic. GENERIC-REQ then guarantees the required knobs are
  // present, so those accesses are safe. Symmetrically, the remote value blocks
  // (REMOTE-REQ, IMM-6) now short-circuit on `source != 'remote'`, so a
  // generic revision never falls into a remote dereference. This is the same
  // has()/value-guard discipline as the remote carril; SEMANTIC verification
  // (create passes / cross-carril flip fails / knob mutation fails) is
  // `kubectl --dry-run=server` at batch close, not here.
  // ---------------------------------------------------------------------------

  it('declares the generic-carril knob fields with the right types/enums', () => {
    const props = specSchema.properties.oauth.properties
    expect(props.tokenRequestFormat.type).toBe('string')
    expect(props.tokenRequestFormat.enum).toEqual(['form', 'json'])
    expect(props.tokenAuthMethod.type).toBe('string')
    expect(props.tokenAuthMethod.enum).toEqual(['body', 'basic'])
    expect(props.scopeSeparator.type).toBe('string')
    expect(props.scopeSeparator.enum).toEqual(['space', 'comma'])
    expect(props.sendScope.type).toBe('boolean')
    expect(props.usePkce.type).toBe('boolean')
    expect(props.includeResponseType.type).toBe('boolean')
    expect(props.refreshEndpoint.type).toBe('string')
    expect(props.refreshEndpoint.maxLength).toBe(2048)
    expect(props.extraAuthorizeParams.type).toBe('object')
    expect(props.extraAuthorizeParams.maxProperties).toBe(16)
    expect(props.extraAuthorizeParams.additionalProperties.type).toBe('string')
    expect(props.extraAuthorizeParams.additionalProperties.maxLength).toBe(1024)
    // No CRD default on any knob — the control-api install path writes every
    // knob explicitly, and a default would void the GENERIC-REQ presence check.
    for (const p of [
      'tokenRequestFormat',
      'tokenAuthMethod',
      'scopeSeparator',
      'sendScope',
      'usePkce',
      'includeResponseType',
      'refreshEndpoint',
      'extraAuthorizeParams',
    ]) {
      expect(props[p]).not.toHaveProperty('default')
    }
  })

  it('requires the generic client shape via CEL (GENERIC-REQ)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes("self.oauth.source != 'generic'") &&
        r.rule.includes('has(self.oauth.id)') &&
        r.rule.includes('has(self.oauth.authorizationEndpoint)') &&
        r.rule.includes('has(self.oauth.tokenEndpoint)') &&
        r.rule.includes('has(self.oauth.tokenRequestFormat)') &&
        r.rule.includes('has(self.oauth.tokenAuthMethod)') &&
        r.rule.includes('has(self.oauth.scopeSeparator)') &&
        r.rule.includes('has(self.oauth.sendScope)') &&
        r.rule.includes('has(self.oauth.supportsRefresh)') &&
        r.rule.includes('has(self.oauth.usePkce)') &&
        r.rule.includes('has(self.oauth.includeResponseType)')
    )
    expect(rule, 'GENERIC-REQ rule present').toBeDefined()
  })

  it('forbids remote-only fields on the generic carril (GENERIC-FORBID-REMOTE-FIELDS)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes("self.oauth.source != 'generic'") &&
        r.rule.includes('!has(self.oauth.clientMode)') &&
        r.rule.includes('!has(self.oauth.issuer)') &&
        r.rule.includes('!has(self.oauth.registrationEndpoint)') &&
        r.rule.includes('!has(self.oauth.issForCallback)') &&
        r.rule.includes('!has(self.oauth.bearerInBody)')
    )
    expect(rule, 'GENERIC-FORBID-REMOTE-FIELDS rule present').toBeDefined()
  })

  it('forbids generic-only knobs on the remote carril (REMOTE-FORBID-GENERIC-KNOBS)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes("self.oauth.source != 'remote'") &&
        r.rule.includes('!has(self.oauth.tokenRequestFormat)') &&
        r.rule.includes('!has(self.oauth.tokenAuthMethod)') &&
        r.rule.includes('!has(self.oauth.scopeSeparator)') &&
        r.rule.includes('!has(self.oauth.sendScope)') &&
        r.rule.includes('!has(self.oauth.usePkce)') &&
        r.rule.includes('!has(self.oauth.includeResponseType)') &&
        r.rule.includes('!has(self.oauth.refreshEndpoint)') &&
        r.rule.includes('!has(self.oauth.extraAuthorizeParams)')
    )
    expect(rule, 'REMOTE-FORBID-GENERIC-KNOBS rule present').toBeDefined()
  })

  it('pairs generic client_id/secret refs together (GENERIC-SECRET-PAIRING)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes("self.oauth.source != 'generic'") &&
        r.rule.includes('has(self.oauth.clientIdRef) == has(self.oauth.clientSecretRef)')
    )
    expect(rule, 'GENERIC-SECRET-PAIRING rule present').toBeDefined()
  })

  it('pins the source VALUE as immutable so the carril cannot flip in place (SOURCE-VALUE-IMM)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes('oldSelf.oauth.source == self.oauth.source') &&
        r.rule.includes('!has(oldSelf.oauth.source)') &&
        r.rule.includes('!has(self.oauth.source)') &&
        // Not IMM-5 (which pins presence via has()==has()).
        !r.rule.includes('has(oldSelf.oauth.source) == has(self.oauth.source)')
    )
    expect(rule, 'SOURCE-VALUE-IMM rule present').toBeDefined()
  })

  it('pins generic endpoints + knobs as immutable, double-guarded on source (GENERIC-IMM)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes("oldSelf.oauth.source != 'generic'") &&
        r.rule.includes("self.oauth.source != 'generic'") &&
        r.rule.includes(
          'oldSelf.oauth.authorizationEndpoint == self.oauth.authorizationEndpoint'
        ) &&
        r.rule.includes('oldSelf.oauth.tokenRequestFormat == self.oauth.tokenRequestFormat') &&
        r.rule.includes('oldSelf.oauth.usePkce == self.oauth.usePkce') &&
        r.rule.includes('oldSelf.oauth.includeResponseType == self.oauth.includeResponseType')
    )
    expect(rule, 'GENERIC-IMM rule present').toBeDefined()
    // Optional generic fields are presence-pinned + guarded value-equality.
    expect(rule?.rule).toContain(
      'has(oldSelf.oauth.refreshEndpoint) == has(self.oauth.refreshEndpoint)'
    )
    expect(rule?.rule).toContain(
      'has(oldSelf.oauth.extraAuthorizeParams) == has(self.oauth.extraAuthorizeParams)'
    )
  })

  it('pins the generic secret posture (ref pair) as immutable across UPDATE (GENERIC-SECRET-IMM)', () => {
    // Generic has no clientMode; public/confidential is encoded by ref presence.
    // GENERIC-SECRET-PAIRING only pins that within a revision — this transition
    // rule pins it across UPDATE (presence + value of both refs), the analogue of
    // clientMode's IMM-6 pin on remote. Anchor on the unique message.
    const rule = specRules.find(r =>
      r.message?.includes('generic spec.oauth clientIdRef/clientSecretRef')
    )
    expect(rule, 'GENERIC-SECRET-IMM rule present').toBeDefined()
    // double-source-value-guarded on generic (both revisions)
    expect(rule?.rule).toContain("oldSelf.oauth.source != 'generic'")
    expect(rule?.rule).toContain("self.oauth.source != 'generic'")
    // presence-equality of both refs
    expect(rule?.rule).toContain('has(oldSelf.oauth.clientIdRef) == has(self.oauth.clientIdRef)')
    expect(rule?.rule).toContain(
      'has(oldSelf.oauth.clientSecretRef) == has(self.oauth.clientSecretRef)'
    )
    // value-equality of the ref targets, presence-guarded
    expect(rule?.rule).toContain('oldSelf.oauth.clientIdRef.name == self.oauth.clientIdRef.name')
    expect(rule?.rule).toContain(
      'oldSelf.oauth.clientSecretRef.key == self.oauth.clientSecretRef.key'
    )
  })

  it('reuses authorizationEndpoint/tokenEndpoint/resource/supportsRefresh for REMOTE and GENERIC', () => {
    const props = specSchema.properties.oauth.properties
    for (const p of ['authorizationEndpoint', 'tokenEndpoint', 'resource', 'supportsRefresh']) {
      expect(props[p].description).toMatch(/REMOTE and GENERIC/)
    }
  })

  // --- MODIFIED rules changed correctly ------------------------------------

  it('narrows the slug for baked AND generic, exempting only remote (SLUG re-gate)', () => {
    const rule = specRules.find(r => r.rule.includes("self.oauth.id.matches('^[a-z0-9-]{1,63}$')"))
    expect(rule, 'slug rule present').toBeDefined()
    // The exemption is now VALUE-gated on remote (not mere source presence), so
    // generic falls through to the slug narrow.
    expect(rule?.rule).toContain("has(self.oauth.source) && self.oauth.source == 'remote'")
  })

  it('re-gates REMOTE-REQ on source == remote so generic is not caught (REMOTE-REQ)', () => {
    // Anchor on the message: the positive `has(self.oauth.clientMode)` substring
    // also appears (negated) in BAKED-FORBID-REMOTE-FIELDS, so a rule-only match
    // is order-dependent. The message is unique to REMOTE-REQ.
    const rule = specRules.find(r => r.message?.includes('remote spec.oauth requires'))
    expect(rule, 'REMOTE-REQ rule present').toBeDefined()
    expect(rule?.rule).toContain("self.oauth.source != 'remote'")
    // and it still requires the full remote shape only for the remote carril
    expect(rule?.rule).toContain('has(self.oauth.clientMode)')
    expect(rule?.rule).toContain('has(self.oauth.bearerInBody)')
  })

  it('double-guards IMM-6 on source == remote so a generic update short-circuits (IMM-6)', () => {
    const imm6 = specRules.find(
      r =>
        r.rule.includes(
          'oldSelf.oauth.authorizationEndpoint == self.oauth.authorizationEndpoint'
        ) && r.rule.includes('oldSelf.oauth.clientMode == self.oauth.clientMode')
    )
    expect(imm6, 'IMM-6 present').toBeDefined()
    expect(imm6?.rule).toContain("oldSelf.oauth.source != 'remote'")
    expect(imm6?.rule).toContain("self.oauth.source != 'remote'")
  })

  it('extends BAKED-FORBID-REMOTE-FIELDS with the generic knobs (BAKED-FORBID)', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes('!has(self.oauth.clientMode)') &&
        r.rule.includes('!has(self.oauth.authorizationEndpoint)') &&
        r.rule.includes('!has(self.oauth.supportsRefresh)') &&
        r.rule.includes('!has(self.oauth.tokenRequestFormat)') &&
        r.rule.includes('!has(self.oauth.extraAuthorizeParams)')
    )
    expect(rule, 'BAKED-FORBID-REMOTE-FIELDS now forbids generic knobs').toBeDefined()
  })

  // --- FROZEN invariants still hold ----------------------------------------

  it('keeps the provider enum frozen at exactly the 8 baked adapters', () => {
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

  it('leaves BAKED-REQ unchanged (id/provider/clientIdRef/clientSecretRef quartet)', () => {
    const bakedReq = specRules.find(
      r =>
        r.rule.includes('has(self.oauth.source)') &&
        r.rule.includes('has(self.oauth.id)') &&
        r.rule.includes('has(self.oauth.provider)') &&
        r.rule.includes('has(self.oauth.clientIdRef)') &&
        r.rule.includes('has(self.oauth.clientSecretRef)') &&
        !r.rule.includes("self.oauth.source == 'remote'")
    )
    expect(bakedReq, 'BAKED-REQ unchanged').toBeDefined()
    expect(bakedReq?.message).toMatch(/baked spec\.oauth \(no source\) requires/)
  })

  it('leaves REMOTE-FORBID-PROVIDER unchanged', () => {
    const rule = specRules.find(
      r =>
        r.rule.includes('!has(self.oauth.source)') &&
        r.rule.includes('!has(self.oauth.provider)') &&
        !r.rule.includes('has(self.oauth.clientMode)')
    )
    expect(rule, 'REMOTE-FORBID-PROVIDER unchanged').toBeDefined()
    expect(rule?.message).toMatch(/must not set provider/)
  })
})
