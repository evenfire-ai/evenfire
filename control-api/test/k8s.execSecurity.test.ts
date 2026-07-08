import { describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_EXEC_NAMESPACES,
  ALLOWED_READ_DIRS,
  ExecOutputLimitError,
  K8sGateway,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_LISTING_BYTES,
  buildListFilesWithMetadataCommand,
  buildListRegularFileNamesCommand,
  buildSafeReadFileCommand,
  validateExecParams,
} from '../src/k8s.js'

// ── Module-level constants ──────────────────────────────────────────────

describe('ALLOWED_EXEC_NAMESPACES', () => {
  it('contains exactly the namespaces with pods/exec RBAC coverage', () => {
    expect(ALLOWED_EXEC_NAMESPACES).toBeInstanceOf(Set)
    expect([...ALLOWED_EXEC_NAMESPACES].sort()).toEqual(['mcp-host', 'sandbox-recipes'])
  })
})

describe('ALLOWED_READ_DIRS', () => {
  it('contains exactly the two expected directory prefixes', () => {
    expect(ALLOWED_READ_DIRS).toEqual(['/tmp/clerum-output/', '/output/'])
  })
})

// ── validateExecParams — namespace validation ───────────────────────────

describe('validateExecParams — namespace rejection', () => {
  it('rejects kube-system namespace', () => {
    expect(() => validateExecParams('kube-system', '/tmp/clerum-output/file.pdf')).toThrow(
      /namespace is not in the exec allowlist/
    )
  })

  it('rejects control-plane namespace', () => {
    expect(() => validateExecParams('control-plane', '/tmp/clerum-output/file.pdf')).toThrow(
      /namespace is not in the exec allowlist/
    )
  })

  it('rejects default namespace', () => {
    expect(() => validateExecParams('default', '/tmp/clerum-output/file.pdf')).toThrow(
      /namespace is not in the exec allowlist/
    )
  })

  it('rejects channels namespace', () => {
    expect(() => validateExecParams('channels', '/tmp/clerum-output/file.pdf')).toThrow(
      /namespace is not in the exec allowlist/
    )
  })

  it('rejects empty namespace', () => {
    expect(() => validateExecParams('', '/tmp/clerum-output/file.pdf')).toThrow(
      /namespace is not in the exec allowlist/
    )
  })

  it('error message does not leak allowlist contents', () => {
    expect(() => validateExecParams('evil-ns', '/tmp/clerum-output/x')).not.toThrow(/mcp-host/)
  })
})

// ── validateExecParams — path validation ────────────────────────────────

describe('validateExecParams — path rejection', () => {
  it('rejects /etc/passwd', () => {
    expect(() => validateExecParams('mcp-host', '/etc/passwd')).toThrow(
      /path is not under an allowed directory/
    )
  })

  it('rejects /etc/shadow', () => {
    expect(() => validateExecParams('mcp-host', '/etc/shadow')).toThrow(
      /path is not under an allowed directory/
    )
  })

  it('rejects /var/run/secrets', () => {
    expect(() =>
      validateExecParams('mcp-host', '/var/run/secrets/kubernetes.io/serviceaccount/token')
    ).toThrow(/is not under an allowed directory/)
  })

  it('rejects /home/user/file', () => {
    expect(() => validateExecParams('mcp-host', '/home/user/file')).toThrow(
      /path is not under an allowed directory/
    )
  })

  it('rejects root directory /', () => {
    expect(() => validateExecParams('mcp-host', '/')).toThrow(
      /path is not under an allowed directory/
    )
  })

  it('rejects /tmp/ (parent of allowed dir)', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/')).toThrow(
      /path is not under an allowed directory/
    )
  })

  it('rejects /tmp/clerum-output without trailing slash (prefix mismatch)', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output')).toThrow()
  })

  it('rejects /output without trailing slash (prefix mismatch)', () => {
    expect(() => validateExecParams('mcp-host', '/output')).toThrow()
  })

  it('rejects empty path', () => {
    expect(() => validateExecParams('mcp-host', '')).toThrow(/Exec rejected: empty path/)
  })

  it('error message does not leak allowed directory paths', () => {
    expect(() => validateExecParams('mcp-host', '/evil/path')).not.toThrow(/\/tmp\/clerum-output\//)
  })
})

// ── validateExecParams — path traversal protection ──────────────────────

describe('validateExecParams — path traversal rejection', () => {
  it('rejects /tmp/clerum-output/../etc/passwd', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output/../etc/passwd')).toThrow(
      /path traversal detected/
    )
  })

  it('rejects /output/../../etc/shadow', () => {
    expect(() => validateExecParams('mcp-host', '/output/../../etc/shadow')).toThrow(
      /path traversal detected/
    )
  })

  it('rejects path with .. in middle', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output/sub/../secret')).toThrow(
      /path traversal detected/
    )
  })

  it('path traversal checked before prefix (even with valid prefix)', () => {
    // /tmp/clerum-output/.. passes the prefix check but has ..
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output/..')).toThrow()
  })

  it('rejects null byte injection', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output/\x00/etc/passwd')).toThrow(
      /null byte/
    )
  })
})

// ── validateExecParams — allowed combinations ───────────────────────────

describe('validateExecParams — allowed combinations', () => {
  const allowedNamespaces = [...ALLOWED_EXEC_NAMESPACES]
  const allowedPaths = [
    '/tmp/clerum-output/file.pdf',
    '/tmp/clerum-output/report.xlsx',
    '/tmp/clerum-output/subdir/file.md',
    '/output/result.json',
    '/output/deep/nested/file.txt',
  ]

  it('does not throw for any allowed namespace + path combination', () => {
    for (const ns of allowedNamespaces) {
      for (const path of allowedPaths) {
        expect(() => validateExecParams(ns, path)).not.toThrow()
      }
    }
  })

  it('allows /tmp/clerum-output/ directory listing', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output/')).not.toThrow()
  })

  it('allows /output/ directory listing', () => {
    expect(() => validateExecParams('sandbox-recipes', '/output/')).not.toThrow()
  })

  it('rejects mcp-server namespace until a caller and pods/exec RBAC binding exist', () => {
    expect(() => validateExecParams('mcp-server', '/tmp/clerum-output/data.bin')).toThrow(
      /namespace is not in the exec allowlist/
    )
  })
})

// ── validateExecParams — combined namespace + path rejection ─────────────

describe('validateExecParams — both wrong', () => {
  it('reports namespace error first when both namespace and path are invalid', () => {
    expect(() => validateExecParams('evil-ns', '/etc/passwd')).toThrow(
      /namespace is not in the exec allowlist/
    )
  })
})

// ── validateExecParams — boundary conditions ────────────────────────────

describe('validateExecParams — boundary conditions', () => {
  it('rejects path that starts like allowed dir but deviates', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output-evIL/file')).toThrow()
  })

  it('rejects path with /outputX (not /output/)', () => {
    expect(() => validateExecParams('mcp-host', '/outputX/file')).toThrow()
  })

  it('allows deeply nested paths under /tmp/clerum-output/', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output/a/b/c/d/e/f/g')).not.toThrow()
  })

  it('allows paths with special characters in filename', () => {
    expect(() => validateExecParams('mcp-host', '/tmp/clerum-output/report (1).pdf')).not.toThrow()
  })
})

// ── safe read command construction ──────────────────────────────────────

describe('buildSafeReadFileCommand', () => {
  it('passes the file path as an argv argument, not interpolated shell source', () => {
    const maliciousName = '/tmp/clerum-output/report.pdf; cat /etc/passwd'

    const command = buildSafeReadFileCommand(maliciousName)

    expect(command.slice(0, 4)).toEqual(['sh', '-c', expect.any(String), 'clerum-read-artifact'])
    expect(command[4]).toBe(maliciousName)
    expect(command[5]).toBe(String(MAX_ARTIFACT_BYTES))
    expect(command[2]).not.toContain(maliciousName)
  })

  it('opens and revalidates the resolved artifact before emitting bytes', () => {
    const script = buildSafeReadFileCommand('/tmp/clerum-output/leak')[2]

    expect(script).toContain('readlink -f')
    expect(script).toContain('/tmp/clerum-output/*|/output/*')
    expect(script).toContain('resolved path is not under an allowed directory')
    expect(script).toContain('[ -L "$path" ]')
    expect(script).toContain('symlink artifacts are not allowed')
    expect(script.indexOf('[ -L "$path" ]')).toBeLessThan(script.indexOf('resolved="$(readlink -f'))
    expect(script).toContain('stat -Lc \'%d:%i:%s\' -- "$resolved"')
    expect(script).toContain('exec 3< "$resolved"')
    expect(script).toContain('readlink -f -- "/proc/$$/fd/3"')
    expect(script).toContain('opened artifact is not under an allowed directory')
    expect(script).toContain('artifact changed during validation')
    expect(script).toContain('size="${opened_meta##*:}"')
    expect(script).toContain('Artifact too large to download')
    expect(script).toMatch(/cat <&3/)
  })
})

// ── safe list command construction ──────────────────────────────────────

describe('artifact listing commands', () => {
  function makeGatewayWithExecRaw(execRaw: (...args: unknown[]) => Promise<string>): K8sGateway {
    const gateway = Object.create(K8sGateway.prototype) as K8sGateway
    Object.defineProperty(gateway, 'execRaw', { value: execRaw })
    return gateway
  }

  it('uses find -type f for the metadata path', () => {
    expect(buildListFilesWithMetadataCommand('/tmp/clerum-output/')).toEqual([
      'find',
      '/tmp/clerum-output/',
      '-maxdepth',
      '1',
      '-type',
      'f',
      '-printf',
      '%f\\t%s\\t%T@\\n',
    ])
  })

  it('uses a regular-file-only BusyBox fallback instead of ls', () => {
    const command = buildListRegularFileNamesCommand('/tmp/clerum-output/')

    expect(command).toEqual([
      'find',
      '/tmp/clerum-output/',
      '-maxdepth',
      '1',
      '-type',
      'f',
      '-exec',
      'basename',
      '{}',
      ';',
    ])
    expect(command).not.toContain('ls')
  })

  it('caps metadata listing output from pod exec', async () => {
    const execRaw = vi.fn(async () => 'report.md\t10\t1711555200.0\n')
    const gateway = makeGatewayWithExecRaw(execRaw)

    await expect(
      gateway.listFilesInDirectory('pod-1', 'mcp-host', undefined, '/tmp/clerum-output/')
    ).resolves.toContain('report.md')

    expect(execRaw).toHaveBeenCalledWith(
      'pod-1',
      'mcp-host',
      undefined,
      buildListFilesWithMetadataCommand('/tmp/clerum-output/'),
      MAX_ARTIFACT_LISTING_BYTES,
      'Artifact listing too large to return'
    )
  })

  it('caps BusyBox fallback listing output from pod exec', async () => {
    const execRaw = vi
      .fn()
      .mockRejectedValueOnce(new Error('find: unrecognized: -printf'))
      .mockResolvedValueOnce('report.md\n')
    const gateway = makeGatewayWithExecRaw(execRaw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(
        gateway.listFilesInDirectory('pod-1', 'mcp-host', undefined, '/tmp/clerum-output/')
      ).resolves.toContain('report.md')
    } finally {
      warnSpy.mockRestore()
    }

    expect(execRaw).toHaveBeenNthCalledWith(
      2,
      'pod-1',
      'mcp-host',
      undefined,
      buildListRegularFileNamesCommand('/tmp/clerum-output/'),
      MAX_ARTIFACT_LISTING_BYTES,
      'Artifact listing too large to return'
    )
  })

  it('does not fall back when the metadata listing exceeds the cap', async () => {
    const execRaw = vi.fn(async () => {
      throw new ExecOutputLimitError(
        MAX_ARTIFACT_LISTING_BYTES,
        'Artifact listing too large to return'
      )
    })
    const gateway = makeGatewayWithExecRaw(execRaw)

    await expect(
      gateway.listFilesInDirectory('pod-1', 'mcp-host', undefined, '/tmp/clerum-output/')
    ).rejects.toThrow(/artifact listing too large/i)

    expect(execRaw).toHaveBeenCalledTimes(1)
  })
})
