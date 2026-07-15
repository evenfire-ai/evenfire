/**
 * D3 (stateless-agents) §1.3 — fail-loud boot guard tests. The stateless
 * lifecycle must abort boot (never degrade silently) when the session db
 * configuration cannot guarantee durability, and must never accept the /tmp
 * fallback path.
 */
import { describe, expect, it } from 'vitest'
import {
  StatelessBootError,
  assertStatelessBootConfig,
  resolveSessionDbPathFrom,
} from '../statelessBootGuard'

const TMP_FALLBACK = '/tmp/clerum-state.db'

function bootInputs(overrides: Partial<Parameters<typeof assertStatelessBootConfig>[0]> = {}) {
  return {
    statelessLifecycle: true,
    sessionStoreModeRaw: 'sqlite',
    sessionDbDir: '/data/sessions',
    sessionDbPath: '',
    workspaceMemoryEnabled: false,
    workspacePath: '',
    ...overrides,
  }
}

describe('assertStatelessBootConfig', () => {
  it('passes with a PVC-backed session db dir', () => {
    expect(() => assertStatelessBootConfig(bootInputs())).not.toThrow()
  })

  it('passes with an explicit session db path', () => {
    expect(() =>
      assertStatelessBootConfig(bootInputs({ sessionDbDir: '', sessionDbPath: '/pvc/state.db' }))
    ).not.toThrow()
  })

  it('passes with a workspace-based path', () => {
    expect(() =>
      assertStatelessBootConfig(
        bootInputs({ sessionDbDir: '', workspaceMemoryEnabled: true, workspacePath: '/workspace' })
      )
    ).not.toThrow()
  })

  it('aborts when no PVC-backed session db dir resolves', () => {
    expect(() =>
      assertStatelessBootConfig(
        bootInputs({ sessionDbDir: '', sessionDbPath: '', workspaceMemoryEnabled: false })
      )
    ).toThrow(StatelessBootError)
  })

  it('aborts when workspace memory is enabled but the path is empty', () => {
    expect(() =>
      assertStatelessBootConfig(
        bootInputs({ sessionDbDir: '', workspaceMemoryEnabled: true, workspacePath: '  ' })
      )
    ).toThrow(StatelessBootError)
  })

  it('aborts on an unrecognized CLERUM_SESSION_STORE value instead of the silent memory fallback', () => {
    expect(() => assertStatelessBootConfig(bootInputs({ sessionStoreModeRaw: 'bogus' }))).toThrow(
      StatelessBootError
    )
    expect(() => assertStatelessBootConfig(bootInputs({ sessionStoreModeRaw: 'bogus' }))).toThrow(
      /not recognized/
    )
  })

  it('accepts every recognized store value', () => {
    for (const mode of ['memory', 'sqlite', 'dual']) {
      expect(() =>
        assertStatelessBootConfig(bootInputs({ sessionStoreModeRaw: mode }))
      ).not.toThrow()
    }
  })

  it('is a no-op when the stateless lifecycle is off (legacy boots unchanged)', () => {
    expect(() =>
      assertStatelessBootConfig(
        bootInputs({
          statelessLifecycle: false,
          sessionStoreModeRaw: 'bogus',
          sessionDbDir: '',
          sessionDbPath: '',
        })
      )
    ).not.toThrow()
  })
})

describe('resolveSessionDbPathFrom', () => {
  function pathInputs(overrides: Partial<Parameters<typeof resolveSessionDbPathFrom>[0]> = {}) {
    return {
      statelessLifecycle: false,
      sessionDbDir: '',
      sessionDbPath: '',
      workspaceMemoryEnabled: false,
      workspacePath: '',
      tmpFallbackPath: TMP_FALLBACK,
      ...overrides,
    }
  }

  it('prefers CLERUM_SESSION_DB_DIR over every other source', () => {
    expect(
      resolveSessionDbPathFrom(
        pathInputs({
          sessionDbDir: '/data/sessions',
          sessionDbPath: '/legacy/state.db',
          workspaceMemoryEnabled: true,
          workspacePath: '/workspace',
        })
      )
    ).toBe('/data/sessions/state.db')
  })

  it('falls back to the explicit CLERUM_SESSION_DB_PATH, then the workspace path', () => {
    expect(resolveSessionDbPathFrom(pathInputs({ sessionDbPath: '/legacy/state.db' }))).toBe(
      '/legacy/state.db'
    )
    expect(
      resolveSessionDbPathFrom(
        pathInputs({ workspaceMemoryEnabled: true, workspacePath: '/workspace' })
      )
    ).toBe('/workspace/state.db')
  })

  it('uses the tmp fallback only for legacy (non-stateless) boots', () => {
    expect(resolveSessionDbPathFrom(pathInputs())).toBe(TMP_FALLBACK)
  })

  it('NEVER accepts the /tmp fallback under the stateless lifecycle — it throws', () => {
    expect(() => resolveSessionDbPathFrom(pathInputs({ statelessLifecycle: true }))).toThrow(
      StatelessBootError
    )
  })

  it('stateless with a db dir resolves to ${dir}/state.db (no /tmp anywhere)', () => {
    const resolved = resolveSessionDbPathFrom(
      pathInputs({ statelessLifecycle: true, sessionDbDir: '/data/sessions' })
    )
    expect(resolved).toBe('/data/sessions/state.db')
    expect(resolved.startsWith('/tmp')).toBe(false)
  })
})
