import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminHostArtifactsRouter } from '../src/routes/admin/hostArtifacts.js'

// Spy on console.warn to capture namespace audit logs
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

/**
 * Mock gateway that provides the K8s methods used by the host artifacts router:
 * - findPodByLabel    (resolve hostRef → pod name)
 * - listFilesInDirectory (list files in /tmp/clerum-output)
 * - readFileFromPod   (download a specific artifact)
 */
function createGateway(
  overrides: {
    findPodByLabel?: ReturnType<typeof vi.fn>
    listFilesInDirectory?: ReturnType<typeof vi.fn>
    readFileFromPod?: ReturnType<typeof vi.fn>
  } = {}
) {
  return {
    findPodByLabel:
      overrides.findPodByLabel ??
      vi.fn(async (_namespace: string, selector: string) => selector.split('=')[1] ?? null),
    listFilesInDirectory:
      overrides.listFilesInDirectory ??
      vi.fn(async () => 'report.pdf\t2048\t1711555200.0\ndata.xlsx\t512\t1711555300.0\n'),
    readFileFromPod: overrides.readFileFromPod ?? vi.fn(async () => Buffer.from('fake-content')),
  }
}

function makeApp(gateway: ReturnType<typeof createGateway>) {
  const app = express()
  app.use(express.json())
  app.use(createAdminHostArtifactsRouter(gateway as never))
  return app
}

// ── GET /admin/hosts/:hostRef/artifacts ──────────────────────────────────

describe('GET /admin/hosts/:hostRef/artifacts', () => {
  it('returns artifact list from pod (find -printf format)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(200)

    expect(res.body.hostRef).toBe('chatllm')
    expect(res.body.artifacts).toHaveLength(2)

    const pdf = res.body.artifacts.find((a: { name: string }) => a.name === 'report.pdf')
    expect(pdf).toBeDefined()
    expect(pdf.format).toBe('pdf')
    expect(pdf.sizeBytes).toBe(2048)

    const xlsx = res.body.artifacts.find((a: { name: string }) => a.name === 'data.xlsx')
    expect(xlsx).toBeDefined()
    expect(xlsx.format).toBe('xlsx')
  })

  it('returns artifact list from regular-file-name fallback (single column)', async () => {
    const execFn = vi.fn(async () => 'notes.md\nsummary.docx\n')
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(200)

    expect(res.body.artifacts).toHaveLength(2)
    // Fallback: sizeBytes is 0, createdAt is ""
    const md = res.body.artifacts.find((a: { name: string }) => a.name === 'notes.md')
    expect(md.format).toBe('md')
    expect(md.sizeBytes).toBe(0)
  })

  it('returns 404 when artifact listing cannot reach the host pod', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('Error from server (NotFound): pods "chatllm" not found')
    })
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(404)

    expect(res.body.error_code).toBe('pod_not_found')
    expect(res.body.hostRef).toBe('chatllm')
    expect(res.body.podName).toBe('chatllm')
  })

  it('returns 404 before exec when no labeled host pod resolves', async () => {
    const findPod = vi.fn(async () => null)
    const execFn = vi.fn(async () => 'report.pdf\t2048\t1711555200.0\n')
    const gateway = createGateway({ findPodByLabel: findPod, listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(404)

    expect(res.body.error_code).toBe('pod_not_found')
    expect(res.body.hostRef).toBe('chatllm')
    expect(res.body.podName).toBe('chatllm')
    expect(execFn).not.toHaveBeenCalled()
  })

  it('returns empty list when the artifact output directory is missing', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('No such file or directory: /tmp/clerum-output')
    })
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(200)

    expect(res.body.artifacts).toEqual([])
    expect(res.body.hostRef).toBe('chatllm')
  })

  it('returns 403 when artifact listing is rejected by exec policy', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('Exec rejected: symlink artifacts are not allowed')
    })
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(403)

    expect(res.body.error).toMatch(/exec policy/i)
  })

  it('returns 413 when artifact listing output exceeds the configured cap', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('Artifact listing too large to return: streamed bytes exceeded 1048576')
    })
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(413)

    expect(res.body.error).toMatch(/listing too large/i)
  })

  it('returns 502 when artifact listing fails for non-not-found infra errors', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('pods/exec forbidden by apiserver')
    })
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(502)

    expect(res.body.error).toMatch(/failed to list artifacts/i)
  })

  it('returns empty list when output directory is empty', async () => {
    const execFn = vi.fn(async () => '')
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(200)

    expect(res.body.artifacts).toEqual([])
  })

  it('filters out hidden files (dot-prefixed)', async () => {
    const execFn = vi.fn(async () => '.hidden\treport.pdf\t2048\t1711555200.0\n')
    const gateway = createGateway({ listFilesInDirectory: execFn })
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/chatllm/artifacts').expect(200)

    const names = res.body.artifacts.map((a: { name: string }) => a.name)
    expect(names).not.toContain('.hidden')
  })

  it('uses pod found by label selector when available', async () => {
    const findPod = vi.fn(async () => 'chatllm-pod-abc123')
    const execFn = vi.fn(async () => 'file.txt\t100\t1711555200.0\n')
    const gateway = createGateway({
      findPodByLabel: findPod,
      listFilesInDirectory: execFn,
    })
    const app = makeApp(gateway)

    await request(app).get('/admin/hosts/chatllm/artifacts').expect(200)

    // Should have tried label-based lookup first
    expect(findPod).toHaveBeenCalledWith('mcp-host', 'clerum.io/host=chatllm')
    // Should exec in the resolved pod
    expect(execFn).toHaveBeenCalledWith(
      'chatllm-pod-abc123',
      'mcp-host',
      undefined,
      '/tmp/clerum-output/'
    )
  })

  // ── Input validation ────────────────────────────────────────────────────

  it('rejects invalid hostRef (uppercase)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app).get('/admin/hosts/INVALID/artifacts').expect(400)

    expect(res.body.error).toMatch(/invalid host reference/i)
    expect(gateway.listFilesInDirectory).not.toHaveBeenCalled()
  })

  it('rejects hostRef with path traversal (dots and special chars)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    // Express normalizes /../ before routing, so "..%2F" won't reach the handler.
    // Instead, test that a hostRef containing dots (invalid per RFC1123) is rejected.
    await request(app).get('/admin/hosts/host..evil/artifacts').expect(400)

    expect(gateway.listFilesInDirectory).not.toHaveBeenCalled()
  })

  it('rejects hostRef with underscores', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app).get('/admin/hosts/my_host/artifacts').expect(400)
  })

  it('rejects hostRef starting with a hyphen', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app).get('/admin/hosts/-invalid/artifacts').expect(400)
  })
})

// ── GET /admin/hosts/:hostRef/artifacts/:artifactName/download ──────────

describe('GET /admin/hosts/:hostRef/artifacts/:artifactName/download', () => {
  it('downloads a PDF artifact with correct content type', async () => {
    const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0x80])
    const readFn = vi.fn(async () => pdfBytes)
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/report.pdf/download')
      .expect(200)

    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.headers['content-disposition']).toContain('report.pdf')
    expect(res.headers['x-clerum-redaction']).toBe('skipped:binary')
    expect(Buffer.from(res.body)).toEqual(pdfBytes)
  })

  it('preserves binary artifact bytes when raw secret-shaped content is present', async () => {
    const pdfBytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'utf-8'),
      Buffer.from([0x00, 0xff, 0x80]),
      Buffer.from('super-secret-value\n%%EOF', 'utf-8'),
    ])
    const readFn = vi.fn(async () => pdfBytes)
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/report.pdf/download')
      .expect(200)

    expect(res.headers['x-clerum-redaction']).toBe('skipped:binary')
    expect(Buffer.from(res.body)).toEqual(pdfBytes)
  })

  it('downloads a DOCX artifact with correct content type', async () => {
    const readFn = vi.fn(async () => Buffer.from('PK docx'))
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/doc.docx/download')
      .expect(200)

    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('downloads a Markdown artifact with text/markdown content type', async () => {
    const readFn = vi.fn(async () => Buffer.from('# Hello'))
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/notes.md/download')
      .expect(200)

    expect(res.headers['content-type']).toContain('text/markdown')
    expect(res.headers['x-clerum-redaction']).toBe('scanned')
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const readFn = vi.fn(async () => Buffer.from('binary data'))
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/data.bin/download')
      .expect(200)

    expect(res.headers['content-type']).toContain('application/octet-stream')
    expect(res.headers['x-clerum-redaction']).toBe('scanned')
  })

  it('returns 404 when artifact file does not exist', async () => {
    const readFn = vi.fn(async () => {
      throw new Error('File not found: /tmp/clerum-output/missing.pdf')
    })
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/missing.pdf/download')
      .expect(404)

    expect(res.body.error).toMatch(/not found/i)
  })

  it("returns 404 when pod exec fails with 'No such file'", async () => {
    const readFn = vi.fn(async () => {
      throw new Error('No such file or directory')
    })
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    await request(app).get('/admin/hosts/chatllm/artifacts/gone.xlsx/download').expect(404)
  })

  it('returns 404 with pod_not_found when artifact download cannot reach the host pod', async () => {
    const readFn = vi.fn(async () => {
      throw new Error('Error from server (NotFound): pods "chatllm" not found')
    })
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/report.pdf/download')
      .expect(404)

    expect(res.body.error_code).toBe('pod_not_found')
    expect(res.body.hostRef).toBe('chatllm')
    expect(res.body.podName).toBe('chatllm')
  })

  it('returns 403 when artifact download is rejected by exec policy', async () => {
    const readFn = vi.fn(async () => {
      throw new Error('Exec rejected: symlink artifacts are not allowed')
    })
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/leak.md/download')
      .expect(403)

    expect(res.body.error).toMatch(/exec policy/i)
  })

  it('returns 413 when artifact download exceeds the configured size cap', async () => {
    const readFn = vi.fn(async () => {
      throw new Error('Artifact too large to download: 52428801 bytes')
    })
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/huge.md/download')
      .expect(413)

    expect(res.body.error).toMatch(/too large/i)
  })

  it('returns 502 when artifact download fails for non-not-found infra errors', async () => {
    const readFn = vi.fn(async () => {
      throw new Error('apiserver rejected pods/exec')
    })
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/report.pdf/download')
      .expect(502)

    expect(res.body.error).toMatch(/failed to read artifact/i)
  })

  // ── Input validation ────────────────────────────────────────────────────

  it('rejects artifact names with path traversal (..)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/..%2F..%2Fetc%2Fpasswd/download')
      .expect(400)

    expect(res.body.error).toMatch(/invalid artifact name/i)
    expect(gateway.readFileFromPod).not.toHaveBeenCalled()
  })

  it('rejects artifact names with forward slashes', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    // Express will split on / so the route won't match, but let's verify
    // that a URL-encoded slash is also rejected
    await request(app).get('/admin/hosts/chatllm/artifacts/sub%2Ffile.pdf/download').expect(400)
  })

  it('rejects artifact names with backslashes', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app).get('/admin/hosts/chatllm/artifacts/sub%5Cfile.pdf/download').expect(400)
  })

  it('rejects invalid hostRef in download route', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/INVALID/artifacts/report.pdf/download')
      .expect(400)

    expect(res.body.error).toMatch(/invalid host reference/i)
  })

  it('sanitizes filename in Content-Disposition header', async () => {
    const readFn = vi.fn(async () => Buffer.from('data'))
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts/report%20(1).pdf/download')
      .expect(200)

    // Special characters should be replaced with underscores
    const disposition = res.headers['content-disposition'] as string
    expect(disposition).not.toContain('(')
    expect(disposition).toContain('report')
  })
})

// ── Namespace audit tests ──────────────────────────────────────────────────

describe('Host artifacts — namespace injection audit', () => {
  beforeEach(() => {
    warnSpy.mockClear()
  })

  it('audits ?namespace= query param on list endpoint', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app).get('/admin/hosts/chatllm/artifacts?namespace=evil-ns').expect(200)

    // Should have logged a SECURITY alert for the namespace injection attempt
    const securityCalls = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('namespace_injection')
    )
    expect(securityCalls.length).toBeGreaterThanOrEqual(1)
    const logEntry = JSON.parse(securityCalls[0][0])
    expect(logEntry.alert).toBe('SECURITY')
    expect(logEntry.vector).toBe('query-param')
    expect(logEntry.attempted_ns).toBe('evil-ns')
  })

  it('audits ?namespace= query param on download endpoint', async () => {
    const readFn = vi.fn(async () => Buffer.from('data'))
    const gateway = createGateway({ readFileFromPod: readFn })
    const app = makeApp(gateway)

    await request(app)
      .get('/admin/hosts/chatllm/artifacts/report.pdf/download?namespace=evil-ns')
      .expect(200)

    const securityCalls = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('namespace_injection')
    )
    expect(securityCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('still processes request normally despite namespace injection attempt', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    // Request succeeds — namespace is silently ignored
    const res = await request(app)
      .get('/admin/hosts/chatllm/artifacts?namespace=attacker-ns')
      .expect(200)

    expect(res.body.hostRef).toBe('chatllm')
    // Gateway still uses config.hostsNamespace, not the injected one
    expect(gateway.findPodByLabel).toHaveBeenCalledWith('mcp-host', 'clerum.io/host=chatllm')
  })
})
