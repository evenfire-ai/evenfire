import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getMcpHostJwtStateFilePath,
  isInternalWorkflowArtifactName,
  loadPersistedRuntimeAuth,
  persistRuntimeAuthTokens,
  rereadRuntimeAccessTokenFromPersistedState,
  refreshRuntimeAuthFromPersistedState,
} from './mcpHostJwtState'
import type { McpHostRuntimeAuth } from './userApprovalRequester'

function makeJwt(
  exp: number,
  label: string,
  binding?: { hostRefs?: string[]; recipeNamespace?: string; recipeName?: string; iat?: number }
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp, label, ...binding })).toString('base64url')
  return `${header}.${payload}.sig`
}

describe('mcpHostJwtState', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps mcp-host JWT state in a private runtime auth directory, not /output', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(stateDir)

    const stateFile = getMcpHostJwtStateFilePath(stateDir)
    expect(stateFile).toBe(path.join(stateDir, 'approval-auth.json'))
    expect(stateFile).not.toContain(path.join('.clerum-state', 'approval-auth.json'))
  })

  it('persists rotated tokens under the private workflow auth state directory', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(stateDir)

    await persistRuntimeAuthTokens(
      {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
      },
      stateDir
    )

    const stateFile = getMcpHostJwtStateFilePath(stateDir)
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8'))).toEqual({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
    })
  })

  it('loads persisted tokens when they are fresher than the mounted secret values', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(outputDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const fallback: McpHostRuntimeAuth = {
      accessToken: makeJwt(nowSecs + 100, 'mounted-access'),
      refreshToken: makeJwt(nowSecs + 200, 'mounted-refresh'),
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const persistedAccess = makeJwt(nowSecs + 300, 'persisted-access', {
      hostRefs: ['mounted-host'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
    const persistedRefresh = makeJwt(nowSecs + 400, 'persisted-refresh')
    const stateFile = getMcpHostJwtStateFilePath(outputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: persistedAccess,
        refreshToken: persistedRefresh,
      }),
      'utf-8'
    )

    expect(loadPersistedRuntimeAuth(fallback, outputDir)).toMatchObject({
      accessToken: persistedAccess,
      refreshToken: persistedRefresh,
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
  })

  it('mutates a stale shared auth object from fresher persisted state', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(outputDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const auth: McpHostRuntimeAuth = {
      accessToken: makeJwt(nowSecs + 100, 'mounted-access', {
        hostRefs: ['chatllm'],
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
      }),
      refreshToken: makeJwt(nowSecs + 200, 'mounted-refresh'),
      mcpHostControlToken: makeJwt(nowSecs + 100, 'mounted-control', {
        hostRefs: ['chatllm'],
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
      }),
      baseUrl: 'http://gateway:8092',
      hostRef: 'chatllm',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const persistedAccess = makeJwt(nowSecs + 300, 'persisted-access', {
      hostRefs: ['chatllm'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
    const persistedRefresh = makeJwt(nowSecs + 400, 'persisted-refresh')
    const persistedControl = makeJwt(nowSecs + 300, 'persisted-control', {
      hostRefs: ['chatllm'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
    const stateFile = getMcpHostJwtStateFilePath(outputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: persistedAccess,
        refreshToken: persistedRefresh,
        mcpHostControlToken: persistedControl,
      }),
      'utf-8'
    )

    expect(refreshRuntimeAuthFromPersistedState(auth, outputDir)).toBe(true)
    expect(auth).toMatchObject({
      accessToken: persistedAccess,
      refreshToken: persistedRefresh,
      mcpHostControlToken: persistedControl,
      hostRef: 'chatllm',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
  })

  it('keeps mounted tokens when fresher persisted access-token claims change the runtime binding', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(outputDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const fallback: McpHostRuntimeAuth = {
      accessToken: makeJwt(nowSecs + 100, 'mounted-access', {
        hostRefs: ['mounted-host'],
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
      }),
      refreshToken: makeJwt(nowSecs + 200, 'mounted-refresh'),
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const persistedAccess = makeJwt(nowSecs + 300, 'persisted-access', {
      hostRefs: ['sandbox-recipes/persisted-recipe'],
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'persisted-recipe',
    })
    const persistedRefresh = makeJwt(nowSecs + 400, 'persisted-refresh')
    const stateFile = getMcpHostJwtStateFilePath(outputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: persistedAccess,
        refreshToken: persistedRefresh,
      }),
      'utf-8'
    )

    expect(loadPersistedRuntimeAuth(fallback, outputDir)).toMatchObject({
      accessToken: fallback.accessToken,
      refreshToken: fallback.refreshToken,
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
  })

  it('keeps mounted tokens when their issued-at is newer than persisted state', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(outputDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const binding = {
      hostRefs: ['mounted-host'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const fallback: McpHostRuntimeAuth = {
      accessToken: makeJwt(nowSecs + 100, 'mounted-access', { ...binding, iat: nowSecs }),
      refreshToken: makeJwt(nowSecs + 200, 'mounted-refresh', { iat: nowSecs }),
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const stateFile = getMcpHostJwtStateFilePath(outputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: makeJwt(nowSecs + 300, 'persisted-access', {
          ...binding,
          iat: nowSecs - 60,
        }),
        refreshToken: makeJwt(nowSecs + 400, 'persisted-refresh', { iat: nowSecs - 60 }),
      }),
      'utf-8'
    )

    expect(loadPersistedRuntimeAuth(fallback, outputDir)).toMatchObject({
      accessToken: fallback.accessToken,
      refreshToken: fallback.refreshToken,
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
  })

  it('keeps mounted tokens when fresher persisted tokens lack canonical binding claims', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(outputDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const fallback: McpHostRuntimeAuth = {
      accessToken: makeJwt(nowSecs + 100, 'mounted-access', {
        hostRefs: ['mounted-host'],
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
      }),
      refreshToken: makeJwt(nowSecs + 200, 'mounted-refresh'),
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const stateFile = getMcpHostJwtStateFilePath(outputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: makeJwt(nowSecs + 300, 'persisted-access-without-binding'),
        refreshToken: makeJwt(nowSecs + 400, 'persisted-refresh'),
      }),
      'utf-8'
    )

    expect(loadPersistedRuntimeAuth(fallback, outputDir)).toMatchObject({
      accessToken: fallback.accessToken,
      refreshToken: fallback.refreshToken,
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
  })

  it('keeps mounted tokens when persisted state is stale', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(outputDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const mountedAccess = makeJwt(nowSecs + 500, 'mounted-access')
    const mountedRefresh = makeJwt(nowSecs + 600, 'mounted-refresh')
    const fallback: McpHostRuntimeAuth = {
      accessToken: mountedAccess,
      refreshToken: mountedRefresh,
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const stateFile = getMcpHostJwtStateFilePath(outputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: makeJwt(nowSecs + 300, 'persisted-access'),
        refreshToken: makeJwt(nowSecs + 400, 'persisted-refresh'),
      }),
      'utf-8'
    )

    expect(loadPersistedRuntimeAuth(fallback, outputDir)).toMatchObject({
      accessToken: mountedAccess,
      refreshToken: mountedRefresh,
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
  })

  it('falls back to mounted tokens when persisted refresh token is already expired', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(outputDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const mountedAccess = makeJwt(nowSecs + 100, 'mounted-access')
    const mountedRefresh = makeJwt(nowSecs + 200, 'mounted-refresh')
    const fallback: McpHostRuntimeAuth = {
      accessToken: mountedAccess,
      refreshToken: mountedRefresh,
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const stateFile = getMcpHostJwtStateFilePath(outputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: makeJwt(nowSecs + 500, 'persisted-access'),
        refreshToken: makeJwt(nowSecs - 10, 'persisted-refresh-expired'),
      }),
      'utf-8'
    )

    expect(loadPersistedRuntimeAuth(fallback, outputDir)).toMatchObject({
      accessToken: mountedAccess,
      refreshToken: mountedRefresh,
    })
  })

  it('adopts only a newer valid same-binding access token without changing the token pair', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(stateDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const binding = {
      hostRefs: ['mounted-host'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const mountedAccess = makeJwt(nowSecs + 300, 'mounted-access', {
      ...binding,
      iat: nowSecs,
    })
    const mountedRefresh = makeJwt(nowSecs + 600, 'mounted-pair', { iat: nowSecs })
    const persistedAccess = makeJwt(nowSecs + 900, 'persisted-access', {
      ...binding,
      iat: nowSecs + 10,
    })
    const stateFile = getMcpHostJwtStateFilePath(stateDir)
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ accessToken: persistedAccess, refreshToken: 'fixture-pair-sentinel' }),
      'utf-8'
    )
    const stateBefore = fs.readFileSync(stateFile, 'utf-8')
    const auth: McpHostRuntimeAuth = {
      accessToken: mountedAccess,
      refreshToken: mountedRefresh,
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }

    expect(rereadRuntimeAccessTokenFromPersistedState(auth, stateDir)).toBe(true)
    expect(auth.accessToken).toBe(persistedAccess)
    expect(auth.refreshToken).toBe(mountedRefresh)
    expect(auth.hostRef).toBe('mounted-host')
    expect(auth.recipeNamespace).toBe('mcp-host')
    expect(auth.recipeName).toBe('standalone')
    expect(fs.readFileSync(stateFile, 'utf-8')).toBe(stateBefore)
  })

  it.each([
    ['missing state', undefined],
    ['malformed state', '{not-json'],
    ['missing binding', JSON.stringify({ accessToken: 'fixture-access-without-binding' })],
  ])('fails closed when the access-only state is %s', (_label, content) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(stateDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const binding = {
      hostRefs: ['mounted-host'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const mountedAccess = makeJwt(nowSecs + 300, 'mounted-access', { ...binding, iat: nowSecs })
    const mountedRefresh = makeJwt(nowSecs + 600, 'mounted-pair', { iat: nowSecs })
    const auth: McpHostRuntimeAuth = {
      accessToken: mountedAccess,
      refreshToken: mountedRefresh,
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    if (content !== undefined) {
      fs.writeFileSync(getMcpHostJwtStateFilePath(stateDir), content, 'utf-8')
    }

    expect(rereadRuntimeAccessTokenFromPersistedState(auth, stateDir)).toBe(false)
    expect(auth.accessToken).toBe(mountedAccess)
    expect(auth.refreshToken).toBe(mountedRefresh)
  })

  it.each([
    ['older access token', 200, -10, 'mounted-host'],
    ['expired access token', -10, 10, 'mounted-host'],
    ['different Host binding', 900, 10, 'other-host'],
    ['additional Host binding', 900, 10, 'mounted-host'],
  ])('does not adopt a %s', (_label, expOffset, iatOffset, host) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-jwt-state-'))
    tempDirs.push(stateDir)

    const nowSecs = Math.floor(Date.now() / 1000)
    const mountedBinding = {
      hostRefs: ['mounted-host'],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }
    const mountedAccess = makeJwt(nowSecs + 300, 'mounted-access', {
      ...mountedBinding,
      iat: nowSecs,
    })
    const mountedRefresh = makeJwt(nowSecs + 600, 'mounted-pair', { iat: nowSecs })
    const persistedAccess = makeJwt(nowSecs + Number(expOffset), 'candidate-access', {
      hostRefs:
        _label === 'additional Host binding'
          ? [String(host), 'secondary-host']
          : [String(host)],
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      iat: nowSecs + Number(iatOffset),
    })
    fs.writeFileSync(
      getMcpHostJwtStateFilePath(stateDir),
      JSON.stringify({ accessToken: persistedAccess, refreshToken: 'fixture-pair-sentinel' }),
      'utf-8'
    )
    const auth: McpHostRuntimeAuth = {
      accessToken: mountedAccess,
      refreshToken: mountedRefresh,
      baseUrl: 'http://gateway:8092',
      hostRef: 'mounted-host',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    }

    expect(rereadRuntimeAccessTokenFromPersistedState(auth, stateDir)).toBe(false)
    expect(auth.accessToken).toBe(mountedAccess)
    expect(auth.refreshToken).toBe(mountedRefresh)
  })

  it('marks the internal workflow state directory as non-artifact', () => {
    expect(isInternalWorkflowArtifactName('.clerum-state')).toBe(true)
    expect(isInternalWorkflowArtifactName('report.pdf')).toBe(false)
  })
})
