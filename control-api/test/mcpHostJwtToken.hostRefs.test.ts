import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../src/config.js'
import {
  ALL_MCP_HOST_CONTROL_SCOPES,
  MCP_HOST_CREDENTIAL_CAPABILITY,
  MCP_HOST_HCC_AUDIENCE,
  MCP_HOST_WORKFLOW_AUDIENCE,
  type McpHostAccessClaims,
  getMcpHostCallerKey,
  getMcpHostExpiredRefreshRateLimitKey,
  getMcpHostRefreshRateLimitKey,
  isHostRefAuthorized,
  issueMcpHostAccessJwt,
  issueMcpHostControlJwt,
  issueMcpHostRefreshJwt,
  verifyExpiredMcpHostRefreshJwtDetailed,
  verifyMcpHostAccessJwt,
  verifyMcpHostControlJwt,
  verifyMcpHostRefreshJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'

describe('mcpHostJwtToken — hostRefs JWT claim', () => {
  describe('issueMcpHostAccessJwt', () => {
    it('embeds hostRefs in the signed JWT payload', () => {
      const { token } = issueMcpHostAccessJwt('ns1', 'recipe1')
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.hostRefs).toEqual(['ns1/recipe1'])
    })

    it('defaults hostRefs to [ns/name] when not provided', () => {
      const { token } = issueMcpHostAccessJwt('sandbox-recipes', 'my-recipe')
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.hostRefs).toEqual(['sandbox-recipes/my-recipe'])
    })

    it('accepts explicit hostRefs override', () => {
      const refs = ['ns1/recipeA', 'ns2/recipeB']
      const { token } = issueMcpHostAccessJwt('ns1', 'recipeA', refs)
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.hostRefs).toEqual(refs)
    })
  })

  describe('issueMcpHostRefreshJwt', () => {
    it('embeds hostRefs in the signed JWT payload', () => {
      const { token } = issueMcpHostRefreshJwt('ns1', 'recipe1')
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.hostRefs).toEqual(['ns1/recipe1'])
    })

    it('accepts explicit hostRefs override', () => {
      const refs = ['ns1/recipeA']
      const { token } = issueMcpHostRefreshJwt('ns1', 'recipeA', refs)
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.hostRefs).toEqual(refs)
    })
  })

  describe('HCC-qualified credential lineage', () => {
    it('issues and verifies the existing access form with exact HCC authority claims', () => {
      const { token } = issueMcpHostAccessJwt(config.hostsNamespace, 'standalone', ['chatllm'], {
        hccCredential: { hostUid: 'host-uid-chatllm' },
      })
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.aud).toEqual([MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE])
      expect(decoded.host_uid).toBe('host-uid-chatllm')
      expect(decoded.mcpCapabilities).toEqual([MCP_HOST_CREDENTIAL_CAPABILITY])

      expect(verifyMcpHostAccessJwt(token)).toMatchObject({
        hostRefs: ['chatllm'],
        host_uid: 'host-uid-chatllm',
        mcpCapabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
      })
    })

    it('rejects workflow-only tokens that inject HCC-only claims', () => {
      const token = jwt.sign(
        {
          sub: `${config.hostsNamespace}/standalone`,
          recipeNamespace: config.hostsNamespace,
          recipeName: 'standalone',
          hostRefs: ['chatllm'],
          host_uid: 'forged-host-uid',
          mcpCapabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
          scope: 'workflow:approval:request',
          workflowControlScopes: [],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: MCP_HOST_WORKFLOW_AUDIENCE,
          jwtid: 'workflow-only-injected-hcc-claims',
          expiresIn: 300,
        }
      )

      expect(verifyMcpHostAccessJwt(token)).toBeNull()
    })

    it('rejects duplicate and third-party audience values even with a valid signature', () => {
      const base = {
        sub: `${config.hostsNamespace}/standalone`,
        recipeNamespace: config.hostsNamespace,
        recipeName: 'standalone',
        hostRefs: ['chatllm'],
        host_uid: 'host-uid-chatllm',
        mcpCapabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
        scope: 'workflow:approval:request',
        workflowControlScopes: [],
      }
      for (const audience of [
        [MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE, MCP_HOST_HCC_AUDIENCE],
        [MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE, 'unrelated-service'],
      ]) {
        const token = jwt.sign(base, config.adminJwtPrivateKey, {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience,
          jwtid: `bad-audience-${audience.length}-${audience.at(-1)}`,
          expiresIn: 300,
        })
        expect(verifyMcpHostAccessJwt(token)).toBeNull()
      }
    })
  })

  describe('getMcpHostRefreshRateLimitKey', () => {
    it('derives the rate-limit key only from a signed refresh JWT', () => {
      const { token } = issueMcpHostRefreshJwt('sandbox-recipes', 'rate-limited-recipe')

      expect(getMcpHostRefreshRateLimitKey(token)).toBe('sandbox-recipes/rate-limited-recipe')
    })

    it('keys HCC standalone refresh rate limits by canonical hostRef, not standalone sentinel', () => {
      const { token } = issueMcpHostRefreshJwt('mcp-host', 'standalone', ['chatllm'])

      expect(getMcpHostRefreshRateLimitKey(token)).toBe('mcp-host/host/chatllm')
    })

    it('rejects forged refresh claims without a valid RS256 signature', () => {
      const forged = jwt.sign(
        {
          sub: 'sandbox-recipes/victim-recipe',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'victim-recipe',
          hostRefs: ['sandbox-recipes/victim-recipe'],
          scope: 'workflow:approval:refresh',
        },
        'attacker-controlled-secret',
        {
          algorithm: 'HS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          expiresIn: 300,
          jwtid: 'forged-refresh-jti',
        }
      )

      expect(getMcpHostRefreshRateLimitKey(forged)).toBeNull()
      expect(getMcpHostExpiredRefreshRateLimitKey(forged)).toBeNull()
    })

    it('allows recently expired signed refresh JWTs only for reissue rate limiting', () => {
      const now = Math.floor(Date.now() / 1000)
      const token = jwt.sign(
        {
          sub: 'sandbox-recipes/reissue-recipe',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'reissue-recipe',
          hostRefs: ['sandbox-recipes/reissue-recipe'],
          scope: 'workflow:approval:refresh',
          iat: now - 30,
          exp: now - 10,
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          jwtid: 'recently-expired-refresh-jti',
        }
      )

      expect(getMcpHostRefreshRateLimitKey(token)).toBeNull()
      expect(getMcpHostExpiredRefreshRateLimitKey(token)).toBe('sandbox-recipes/reissue-recipe')
    })
  })

  describe('issueMcpHostControlJwt', () => {
    it('embeds mcp-host-control service type, fail-closed default scopes, and audience in the signed JWT payload', () => {
      const { token } = issueMcpHostControlJwt('ns1', 'recipe1')
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.hostRefs).toEqual(['ns1/recipe1'])
      expect(decoded.typ).toBe('service')
      expect(decoded.scopes).toEqual([])
      expect(decoded.scope).toBeUndefined()
      expect(decoded.aud).toBe('mcp-host')
    })

    it('supports reduced mcp-host-control scopes for future callers', () => {
      const { token } = issueMcpHostControlJwt('ns1', 'recipe1', undefined, {
        scopes: ['workflow:read'],
      })
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.scopes).toEqual(['workflow:read'])
    })

    it('supports explicitly empty mcp-host-control scopes for no workflow broker access', () => {
      const { token } = issueMcpHostControlJwt('ns1', 'recipe1', undefined, {
        scopes: [],
      })
      const decoded = jwt.decode(token) as Record<string, unknown>
      expect(decoded.scopes).toEqual([])
    })

    it('rejects explicit hostRefs above the bounded claim size', () => {
      const hostRefs = Array.from(
        { length: config.mcpHostJwtMaxHostRefs + 1 },
        (_, idx) => `ns/r-${idx}`
      )

      expect(() => issueMcpHostControlJwt('ns', 'recipe', hostRefs)).toThrow(
        'invalid mcp-host hostRefs'
      )
    })

    it('rejects overlong explicit hostRefs before signing', () => {
      const hostRef = `ns/${'a'.repeat(config.mcpHostJwtMaxHostRefLength)}`

      expect(() => issueMcpHostControlJwt('ns', 'recipe', [hostRef])).toThrow(
        'invalid mcp-host hostRefs'
      )
    })
  })

  describe('verifyMcpHostAccessJwt — hostRefs validation', () => {
    it('returns claims with hostRefs when token is valid', () => {
      const { token } = issueMcpHostAccessJwt('ns1', 'recipe1')
      const claims = verifyMcpHostAccessJwt(token)
      expect(claims).not.toBeNull()
      expect(claims!.hostRefs).toEqual(['ns1/recipe1'])
    })

    it('rejects token with empty hostRefs', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: [],
          scope: 'workflow:approval:request',
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          expiresIn: 300,
          jwtid: 'test-jti',
        }
      )
      const claims = verifyMcpHostAccessJwt(token)
      expect(claims).toBeNull()
    })

    it('rejects token without hostRefs field', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          scope: 'workflow:approval:request',
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          expiresIn: 300,
          jwtid: 'test-jti',
        }
      )
      const claims = verifyMcpHostAccessJwt(token)
      expect(claims).toBeNull()
    })

    it('rejects token with non-string hostRefs entries', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1', 123],
          scope: 'workflow:approval:request',
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          expiresIn: 300,
          jwtid: 'bad-hostrefs-access-jti',
        }
      )
      const claims = verifyMcpHostAccessJwt(token)
      expect(claims).toBeNull()
    })

    it('rejects token with too many hostRefs', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: Array.from(
            { length: config.mcpHostJwtMaxHostRefs + 1 },
            (_, idx) => `ns1/r-${idx}`
          ),
          scope: 'workflow:approval:request',
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          expiresIn: 300,
          jwtid: 'too-many-hostrefs-access-jti',
        }
      )
      const claims = verifyMcpHostAccessJwt(token)
      expect(claims).toBeNull()
    })

    it('rejects token with overlong hostRefs entries', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: [`ns1/${'a'.repeat(config.mcpHostJwtMaxHostRefLength)}`],
          scope: 'workflow:approval:request',
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          expiresIn: 300,
          jwtid: 'overlong-hostref-access-jti',
        }
      )
      const claims = verifyMcpHostAccessJwt(token)
      expect(claims).toBeNull()
    })
  })

  describe('verifyMcpHostRefreshJwt — hostRefs validation', () => {
    it('rejects token with non-string hostRefs entries', async () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1', 123],
          scope: 'workflow:approval:refresh',
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          expiresIn: 300,
          jwtid: 'bad-hostrefs-refresh-jti',
        }
      )
      const claims = await verifyMcpHostRefreshJwt(token)
      expect(claims).toBeNull()
    })

    it.each([
      {
        label: 'workflow-only audience with injected HCC claims',
        audience: MCP_HOST_WORKFLOW_AUDIENCE,
        recipeNamespace: config.hostsNamespace,
        recipeName: 'standalone',
        hostRefs: ['chatllm'],
        hostUid: 'host-uid-chatllm',
        capabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
      },
      {
        label: 'HCC audience without the bound Host UID',
        audience: [MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE],
        recipeNamespace: config.hostsNamespace,
        recipeName: 'standalone',
        hostRefs: ['chatllm'],
        hostUid: undefined,
        capabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
      },
      {
        label: 'HCC audience with a workflow recipe binding',
        audience: [MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE],
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'recipe-a',
        hostRefs: ['sandbox-recipes/recipe-a'],
        hostUid: 'host-uid-chatllm',
        capabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
      },
    ])('rejects $label', async candidate => {
      const token = jwt.sign(
        {
          sub: `${candidate.recipeNamespace}/${candidate.recipeName}`,
          recipeNamespace: candidate.recipeNamespace,
          recipeName: candidate.recipeName,
          hostRefs: candidate.hostRefs,
          scope: 'workflow:approval:refresh',
          workflowControlScopes: [],
          ...(candidate.hostUid ? { host_uid: candidate.hostUid } : {}),
          mcpCapabilities: candidate.capabilities,
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: candidate.audience,
          expiresIn: 300,
          jwtid: `invalid-hcc-refresh-${candidate.label}`,
        }
      )

      await expect(verifyMcpHostRefreshJwt(token)).resolves.toBeNull()
    })

    it('does not treat a control token as an access or refresh credential', async () => {
      const { token } = issueMcpHostControlJwt(config.hostsNamespace, 'standalone', ['chatllm'], {
        scopes: ['workflow:read'],
      })

      expect(verifyMcpHostAccessJwt(token)).toBeNull()
      await expect(verifyMcpHostRefreshJwt(token)).resolves.toBeNull()
    })
  })

  describe('verifyExpiredMcpHostRefreshJwtDetailed', () => {
    it('distinguishes expired-beyond-grace from opaque caller responses', async () => {
      const now = Math.floor(Date.now() / 1000)
      const token = jwt.sign(
        {
          sub: 'sandbox-recipes/too-old',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'too-old',
          hostRefs: ['sandbox-recipes/too-old'],
          scope: 'workflow:approval:refresh',
          exp: now - 6 * 60,
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          jwtid: 'too-old-refresh-jti',
        }
      )

      await expect(verifyExpiredMcpHostRefreshJwtDetailed(token)).resolves.toEqual({
        ok: false,
        reason: 'expired_beyond_reissue_grace',
      })
    })

    it('distinguishes verified-but-invalid refresh claims', async () => {
      const now = Math.floor(Date.now() / 1000)
      const token = jwt.sign(
        {
          sub: 'sandbox-recipes/wrong-scope',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'wrong-scope',
          hostRefs: ['sandbox-recipes/wrong-scope'],
          scope: 'workflow:approval:request',
          exp: now - 60,
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'workflow-approvals',
          jwtid: 'wrong-scope-refresh-jti',
        }
      )

      await expect(verifyExpiredMcpHostRefreshJwtDetailed(token)).resolves.toEqual({
        ok: false,
        reason: 'invalid_claims',
      })
    })
  })

  describe('getMcpHostCallerKey', () => {
    it('uses hostRefs[0] as canonical caller key over sub', () => {
      expect(
        getMcpHostCallerKey({
          sub: 'mcp-host/chatllm',
          hostRefs: ['chatllm', 'sandbox-recipes/secondary'],
        })
      ).toBe('chatllm')
    })

    it('rejects missing primary hostRef without falling back to sub or secondary hostRefs', () => {
      expect(() =>
        getMcpHostCallerKey({
          sub: 'mcp-host/chatllm',
          hostRefs: [' ', 'sandbox-recipes/secondary'],
        })
      ).toThrow('mcp-host JWT missing canonical hostRefs[0] caller binding')
    })
  })

  describe('isHostRefAuthorized', () => {
    it('returns true when target is in hostRefs', () => {
      const claims = {
        sub: 'ns1/recipe1',
        recipeNamespace: 'ns1',
        recipeName: 'recipe1',
        hostRefs: ['ns1/recipe1'],
        scope: 'workflow:approval:request' as const,
        workflowControlScopes: [],
        mcpCapabilities: [],
        iss: 'test',
        aud: 'test',
        jti: 'test-jti',
        exp: Math.floor(Date.now() / 1000) + 300,
      }
      expect(isHostRefAuthorized(claims, 'ns1', 'recipe1')).toBe(true)
    })

    it('returns false when target is NOT in hostRefs', () => {
      const claims: McpHostAccessClaims = {
        sub: 'ns1/recipe1',
        recipeNamespace: 'ns1',
        recipeName: 'recipe1',
        hostRefs: ['ns1/recipe1'],
        scope: 'workflow:approval:request',
        workflowControlScopes: [],
        mcpCapabilities: [],
        iss: 'test',
        aud: 'test',
        jti: 'test-jti',
        exp: Math.floor(Date.now() / 1000) + 300,
      }
      expect(isHostRefAuthorized(claims, 'ns2', 'other-recipe')).toBe(false)
    })

    it('supports multi-recipe hostRefs', () => {
      const claims: McpHostAccessClaims = {
        sub: 'ns1/recipe1',
        recipeNamespace: 'ns1',
        recipeName: 'recipe1',
        hostRefs: ['ns1/recipe1', 'ns2/recipe2'],
        scope: 'workflow:approval:request',
        workflowControlScopes: [],
        mcpCapabilities: [],
        iss: 'test',
        aud: 'test',
        jti: 'test-jti',
        exp: Math.floor(Date.now() / 1000) + 300,
      }
      expect(isHostRefAuthorized(claims, 'ns2', 'recipe2')).toBe(true)
      expect(isHostRefAuthorized(claims, 'ns3', 'recipe3')).toBe(false)
    })

    it('rejects wildcard patterns in hostRefs', () => {
      const claims: McpHostAccessClaims = {
        sub: 'ns1/recipe1',
        recipeNamespace: 'ns1',
        recipeName: 'recipe1',
        hostRefs: ['ns1/*'],
        scope: 'workflow:approval:request',
        workflowControlScopes: [],
        mcpCapabilities: [],
        iss: 'test',
        aud: 'test',
        jti: 'test-jti',
        exp: Math.floor(Date.now() / 1000) + 300,
      }
      expect(isHostRefAuthorized(claims, 'ns1', 'recipe1')).toBe(false)
    })
  })

  describe('verifyMcpHostControlJwt', () => {
    it('returns claims with mcp-host-control type, scopes, and audience when token is valid', () => {
      const { token } = issueMcpHostControlJwt('ns1', 'recipe1', ['ns1/recipe1', 'ns2/recipe2'], {
        scopes: [...ALL_MCP_HOST_CONTROL_SCOPES],
      })
      const claims = verifyMcpHostControlJwt(token)
      expect(claims).not.toBeNull()
      expect(claims!.typ).toBe('service')
      expect(claims!.scopes).toEqual(ALL_MCP_HOST_CONTROL_SCOPES)
      expect(claims!.aud).toBe('mcp-host')
      expect(claims!.hostRefs).toEqual(['ns1/recipe1', 'ns2/recipe2'])
    })

    it('rejects a new-format control token with a non-service type', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1'],
          typ: 'user',
          scopes: ['workflow:trigger'],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'bad-type-control-jti',
        }
      )
      expect(verifyMcpHostControlJwt(token)).toBeNull()
    })

    it('accepts a control token with empty scopes', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1'],
          typ: 'service',
          scopes: [],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'empty-scopes-control-jti',
        }
      )
      const claims = verifyMcpHostControlJwt(token)
      expect(claims).not.toBeNull()
      expect(claims!.scopes).toEqual([])
    })

    it('rejects a control token with unknown scopes', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1'],
          typ: 'service',
          scopes: ['workflow:delete'],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'unknown-scopes-control-jti',
        }
      )
      expect(verifyMcpHostControlJwt(token)).toBeNull()
    })

    it('rejects a control token with duplicate scopes', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1'],
          typ: 'service',
          scopes: ['workflow:trigger', 'workflow:trigger'],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'duplicate-scopes-control-jti',
        }
      )
      expect(verifyMcpHostControlJwt(token)).toBeNull()
    })

    it('rejects a control token with non-string hostRefs entries', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1', { ref: 'ns2/recipe2' }],
          typ: 'service',
          scopes: ['workflow:list'],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'bad-hostrefs-control-jti',
        }
      )
      expect(verifyMcpHostControlJwt(token)).toBeNull()
    })

    it('rejects a control token with too many hostRefs', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: Array.from(
            { length: config.mcpHostJwtMaxHostRefs + 1 },
            (_, idx) => `ns1/r-${idx}`
          ),
          typ: 'service',
          scopes: ['workflow:list'],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'too-many-hostrefs-control-jti',
        }
      )
      expect(verifyMcpHostControlJwt(token)).toBeNull()
    })

    it('rejects hybrid legacy tokens that also carry invalid scopes', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1'],
          scope: 'workflow:trigger',
          scopes: ['workflow:delete'],
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'hybrid-legacy-control-jti',
        }
      )
      expect(verifyMcpHostControlJwt(token)).toBeNull()
    })

    it('rejects signed legacy control tokens without service type and plural scopes', () => {
      const token = jwt.sign(
        {
          sub: 'ns1/recipe1',
          recipeNamespace: 'ns1',
          recipeName: 'recipe1',
          hostRefs: ['ns1/recipe1'],
          scope: 'workflow:trigger',
        },
        config.adminJwtPrivateKey,
        {
          algorithm: 'RS256',
          issuer: config.adminJwtIssuer,
          audience: 'mcp-host',
          expiresIn: 300,
          jwtid: 'legacy-control-jti',
        }
      )
      expect(verifyMcpHostControlJwt(token)).toBeNull()
    })

    it('rejects tampered control token payloads that try to escalate scopes', () => {
      const { token } = issueMcpHostControlJwt('ns1', 'recipe1', ['ns1/recipe1'], {
        scopes: ['workflow:read'],
      })
      const [header, payload, signature] = token.split('.')
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >
      decoded.scopes = ['workflow:list', 'workflow:read', 'workflow:trigger']
      const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url')

      expect(verifyMcpHostControlJwt(`${header}.${tamperedPayload}.${signature}`)).toBeNull()
    })
  })
})
