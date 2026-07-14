import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  INTERNAL_TOOLS,
  INTERNAL_TOOL_PREFIX,
  enforceQuota,
  getDirectorySize,
  resolveInternalTools,
} from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolDefinition } from '../types'

// ─── Test Output Directory ──────────────────────────────────────────

let testOutputDir: string

beforeEach(() => {
  testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-test-'))
})

afterEach(() => {
  fs.rmSync(testOutputDir, { recursive: true, force: true })
})

// ─── Helpers ────────────────────────────────────────────────────────

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

// ─── Registry ───────────────────────────────────────────────────────

describe('Internal tools registry', () => {
  it('exports exactly 12 tools', () => {
    // 4 generate_* (markdown/pdf/docx/xlsx) + 3 generate_* (pptx/chart/dashboard)
    // + list/read/trigger workflow + 2 context_files_* (list/read) = 12.
    expect(INTERNAL_TOOLS).toHaveLength(12)
  })

  // #592: the catalog always contains the context-files tools, but
  // resolveInternalTools() only EXPOSES them when a SharedFileSystem is mounted
  // (CLERUM_CONTEXT_FILES_MOUNTS). Recipe runtimes (and SFS-less Hosts) never
  // mount one, so they must not see those two dead tools.
  it('resolveInternalTools includes context_files tools ONLY when a SFS is mounted', () => {
    const mountedEnv = {
      CLERUM_CONTEXT_FILES_MOUNTS: JSON.stringify([
        {
          name: 'team-mission',
          namespace: 'mcp-host',
          mountPath: '/cf/tm',
          pvcName: 'sfs-x-files',
        },
      ]),
    } as NodeJS.ProcessEnv
    const mountedNames = resolveInternalTools(mountedEnv).map(t => t.name)
    expect(mountedNames).toContain('clerum__context_files_list')
    expect(mountedNames).toContain('clerum__context_files_read')
    expect(resolveInternalTools(mountedEnv)).toHaveLength(12)

    for (const emptyEnv of [
      {},
      { CLERUM_CONTEXT_FILES_MOUNTS: '' },
      {
        CLERUM_CONTEXT_FILES_MOUNTS: '[]',
      },
    ] as NodeJS.ProcessEnv[]) {
      const names = resolveInternalTools(emptyEnv).map(t => t.name)
      expect(names).not.toContain('clerum__context_files_list')
      expect(names).not.toContain('clerum__context_files_read')
      expect(resolveInternalTools(emptyEnv)).toHaveLength(10)
    }
  })

  it('all tool names start with clerum__ prefix', () => {
    for (const tool of INTERNAL_TOOLS) {
      expect(tool.name).toMatch(new RegExp(`^${INTERNAL_TOOL_PREFIX}`))
    }
  })

  it('all tools have required fields', () => {
    for (const tool of INTERNAL_TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('registers the workflow trigger wrapper with the broker trigger schema', () => {
    const tool = findTool('clerum__trigger_workflow')

    expect(tool.description).toContain('Request approval and trigger a workflow recipe')
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['namespace', 'name'],
    })
  })

  it('registers the workflow read wrapper with the broker read schema', () => {
    const tool = findTool('clerum__read_workflow')

    expect(tool.description).toContain('Get workflow metadata')
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['namespace', 'name'],
    })
  })
})

// ─── workflow broker tools ────────────────────────────────────────────

describe('workflow broker internal tools', () => {
  const ORIGINAL_GATEWAY = process.env.MCP_HOST_GATEWAY_URL
  const ORIGINAL_TOKEN = process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
  const ORIGINAL_TOKEN_FILE = process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    process.env.MCP_HOST_GATEWAY_URL = 'http://gateway:8092'
    process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = 'workflow-control-token'
    delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (ORIGINAL_GATEWAY === undefined) {
      delete process.env.MCP_HOST_GATEWAY_URL
    } else {
      process.env.MCP_HOST_GATEWAY_URL = ORIGINAL_GATEWAY
    }
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
    } else {
      process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = ORIGINAL_TOKEN
    }
    if (ORIGINAL_TOKEN_FILE === undefined) {
      delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE
    } else {
      process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE = ORIGINAL_TOKEN_FILE
    }
  })

  it('calls the workflow read broker route through the host gateway', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ namespace: 'sandbox-recipes', name: 'target-recipe' }),
    } as Response)

    const tool = findTool('clerum__read_workflow')
    const result = await tool.execute(
      { namespace: 'sandbox-recipes', name: 'target-recipe' },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(JSON.parse(result.content ?? '{}')).toMatchObject({
      namespace: 'sandbox-recipes',
      name: 'target-recipe',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/target-recipe',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer workflow-control-token',
        }),
      })
    )
  })

  it('passes approval target context through the workflow list gateway route', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ namespace: 'sandbox-recipes', name: 'target-recipe' }],
        count: 1,
      }),
    } as Response)

    const tool = findTool('clerum__list_workflows')
    const result = await tool.execute(
      { targetUserId: '00000000-0000-4000-8000-000000000001' },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(JSON.parse(result.content ?? '{}')).toMatchObject({
      items: [{ namespace: 'sandbox-recipes', name: 'target-recipe' }],
      count: 1,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflows?targetUserId=00000000-0000-4000-8000-000000000001',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer workflow-control-token',
        }),
      })
    )
  })
})

// ─── generate_markdown ──────────────────────────────────────────────

describe('clerum__generate_markdown', () => {
  it('creates a .md file with provided content', async () => {
    const tool = findTool('clerum__generate_markdown')
    const result = await tool.execute(
      { filename: 'test-report.md', content: '# Hello\n\nWorld' },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact).toBeDefined()
    expect(result.artifact!.format).toBe('md')
    expect(result.artifact!.name).toBe('test-report.md')
    expect(result.artifact!.sizeBytes).toBeGreaterThan(0)

    const content = fs.readFileSync(result.artifact!.path, 'utf-8')
    expect(content).toBe('# Hello\n\nWorld')
  })

  it('auto-appends .md extension if missing', async () => {
    const tool = findTool('clerum__generate_markdown')
    const result = await tool.execute({ filename: 'notes', content: 'test' }, testOutputDir)

    expect(result.success).toBe(true)
    expect(result.artifact!.name).toBe('notes.md')
  })

  it('sanitizes dangerous filenames', async () => {
    const tool = findTool('clerum__generate_markdown')
    const result = await tool.execute(
      { filename: '../../../etc/passwd.md', content: 'hack' },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact!.name).not.toContain('/')
    expect(result.artifact!.name).not.toContain('..')
  })

  it('creates output directory if it does not exist', async () => {
    const tool = findTool('clerum__generate_markdown')
    const nestedDir = path.join(testOutputDir, 'deep', 'nested')
    const result = await tool.execute({ filename: 'test.md', content: 'ok' }, nestedDir)

    expect(result.success).toBe(true)
    expect(fs.existsSync(result.artifact!.path)).toBe(true)
  })

  it('handles empty content', async () => {
    const tool = findTool('clerum__generate_markdown')
    const result = await tool.execute({ filename: 'empty.md', content: '' }, testOutputDir)

    expect(result.success).toBe(true)
    expect(result.artifact!.sizeBytes).toBe(0)
  })
})

// ─── generate_pdf ───────────────────────────────────────────────────

describe('clerum__generate_pdf', () => {
  it('creates a valid PDF file', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute(
      {
        filename: 'report.pdf',
        title: 'Test Report',
        body: '# Section 1\nThis is body text.\n## Subsection\nMore text here.',
      },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact).toBeDefined()
    expect(result.artifact!.format).toBe('pdf')
    expect(result.artifact!.name).toBe('report.pdf')
    expect(result.artifact!.sizeBytes).toBeGreaterThan(100)

    // Verify PDF magic bytes
    const buffer = fs.readFileSync(result.artifact!.path)
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
  })

  it('auto-appends .pdf extension', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute({ filename: 'output', body: 'Hello world' }, testOutputDir)

    expect(result.success).toBe(true)
    expect(result.artifact!.name).toBe('output.pdf')
  })

  it('handles long multi-page content', async () => {
    const tool = findTool('clerum__generate_pdf')
    const longBody = Array(200).fill('This is a line of text for testing pagination.').join('\n')
    const result = await tool.execute(
      { filename: 'long.pdf', title: 'Long Document', body: longBody },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact!.sizeBytes).toBeGreaterThan(500)
  })

  it('works without title', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute(
      { filename: 'no-title.pdf', body: 'Just body text' },
      testOutputDir
    )

    expect(result.success).toBe(true)
  })

  it('handles heading-only content', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute(
      { filename: 'headings.pdf', body: '# H1\n## H2\n# Another H1' },
      testOutputDir
    )

    expect(result.success).toBe(true)
  })
})

// ─── generate_docx ──────────────────────────────────────────────────

describe('clerum__generate_docx', () => {
  it('creates a valid DOCX file', async () => {
    const tool = findTool('clerum__generate_docx')
    const result = await tool.execute(
      {
        filename: 'report.docx',
        title: 'Test Report',
        body: '# Section 1\nParagraph text.\n## Subsection\n- Bullet item\n- Another bullet',
      },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact).toBeDefined()
    expect(result.artifact!.format).toBe('docx')
    expect(result.artifact!.name).toBe('report.docx')
    expect(result.artifact!.sizeBytes).toBeGreaterThan(100)

    // DOCX files are ZIP archives — check PK magic bytes
    const buffer = fs.readFileSync(result.artifact!.path)
    expect(buffer[0]).toBe(0x50) // P
    expect(buffer[1]).toBe(0x4b) // K
  })

  it('auto-appends .docx extension', async () => {
    const tool = findTool('clerum__generate_docx')
    const result = await tool.execute({ filename: 'doc', body: 'Hello' }, testOutputDir)

    expect(result.success).toBe(true)
    expect(result.artifact!.name).toBe('doc.docx')
  })

  it('works without title', async () => {
    const tool = findTool('clerum__generate_docx')
    const result = await tool.execute(
      { filename: 'no-title.docx', body: 'Just body text' },
      testOutputDir
    )

    expect(result.success).toBe(true)
  })

  it('handles bullet points', async () => {
    const tool = findTool('clerum__generate_docx')
    const result = await tool.execute(
      { filename: 'bullets.docx', body: '- Item 1\n- Item 2\n- Item 3' },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact!.sizeBytes).toBeGreaterThan(100)
  })
})

// ─── generate_xlsx ──────────────────────────────────────────────────

describe('clerum__generate_xlsx', () => {
  it('creates a valid XLSX file with headers and data', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'data.xlsx',
        sheets: [
          {
            name: 'Sheet1',
            rows: [
              ['Name', 'Age', 'Score'],
              ['Alice', 30, 95.5],
              ['Bob', 25, 87.2],
            ],
          },
        ],
      },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact).toBeDefined()
    expect(result.artifact!.format).toBe('xlsx')
    expect(result.artifact!.name).toBe('data.xlsx')
    expect(result.artifact!.sizeBytes).toBeGreaterThan(100)

    // XLSX files are ZIP archives
    const buffer = fs.readFileSync(result.artifact!.path)
    expect(buffer[0]).toBe(0x50)
    expect(buffer[1]).toBe(0x4b)
  })

  it('auto-appends .xlsx extension', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'spreadsheet',
        sheets: [{ name: 'Data', rows: [['A'], [1]] }],
      },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact!.name).toBe('spreadsheet.xlsx')
  })

  it('supports multiple sheets', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'multi.xlsx',
        sheets: [
          {
            name: 'Revenue',
            rows: [
              ['Q1', 'Q2'],
              [100, 200],
            ],
          },
          {
            name: 'Costs',
            rows: [
              ['Q1', 'Q2'],
              [50, 75],
            ],
          },
        ],
      },
      testOutputDir
    )

    expect(result.success).toBe(true)
    expect(result.artifact!.sizeBytes).toBeGreaterThan(100)
  })

  it('returns error for empty sheets array', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute({ filename: 'empty.xlsx', sheets: [] }, testOutputDir)

    expect(result.success).toBe(false)
    expect(result.error).toContain('non-empty array')
  })

  it('returns error for missing sheets', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute({ filename: 'bad.xlsx' }, testOutputDir)

    expect(result.success).toBe(false)
  })
})

// ─── StepMcpRouter integration ──────────────────────────────────────

describe('StepMcpRouter with internal tools', () => {
  it('registers internal tools and includes them in getFilteredTools', () => {
    const router = new StepMcpRouter(() => {
      throw new Error('unused')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)

    const tools = router.getFilteredTools()
    const internalNames = tools
      .map((t: { name: string }) => t.name)
      .filter((n: string) => n.startsWith(INTERNAL_TOOL_PREFIX))

    expect(internalNames).toHaveLength(12)
    expect(internalNames).toContain('clerum__generate_chart')
    expect(internalNames).toContain('clerum__generate_markdown')
    expect(internalNames).toContain('clerum__generate_pdf')
    expect(internalNames).toContain('clerum__generate_docx')
    expect(internalNames).toContain('clerum__generate_xlsx')
    expect(internalNames).toContain('clerum__generate_pptx')
    expect(internalNames).toContain('clerum__generate_dashboard')
    expect(internalNames).toContain('clerum__list_workflows')
    expect(internalNames).toContain('clerum__read_workflow')
    expect(internalNames).toContain('clerum__trigger_workflow')
    expect(internalNames).toContain('clerum__context_files_list')
    expect(internalNames).toContain('clerum__context_files_read')
  })

  it('dispatches internal tool calls locally', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('unused')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)

    const { result, record } = await router.callTool('clerum__generate_markdown', {
      filename: 'router-test.md',
      content: '# From Router',
    })

    expect(result.isError).toBe(false)
    expect(record.serverName).toBe('clerum')
    expect(record.toolName).toBe('generate_markdown')
    expect(record.durationMs).toBeGreaterThanOrEqual(0)

    // Verify file was actually created
    const filePath = path.join(testOutputDir, 'router-test.md')
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# From Router')
  })

  it('internal tools coexist with MCP tools in allowedTools filter', () => {
    const router = new StepMcpRouter(() => {
      throw new Error('unused')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)

    const filtered = router.getFilteredTools({
      include: ['clerum__generate_pdf', 'clerum__generate_xlsx'],
    })

    expect(filtered).toHaveLength(2)
    expect(filtered.map((t: { name: string }) => t.name)).toEqual([
      'clerum__generate_pdf',
      'clerum__generate_xlsx',
    ])
  })
})

// ─── Quota enforcement ──────────────────────────────────────────────

describe('Output quota enforcement', () => {
  const ORIGINAL_QUOTA = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB

  afterEach(() => {
    if (ORIGINAL_QUOTA === undefined) {
      delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
    } else {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = ORIGINAL_QUOTA
    }
  })

  describe('getDirectorySize', () => {
    it('returns 0 for a non-existent directory', () => {
      expect(getDirectorySize(path.join(testOutputDir, 'nonexistent'))).toBe(0)
    })

    it('returns 0 for an empty directory', () => {
      expect(getDirectorySize(testOutputDir)).toBe(0)
    })

    it('sums sizes of files at the top level', () => {
      fs.writeFileSync(path.join(testOutputDir, 'a.txt'), 'x'.repeat(100))
      fs.writeFileSync(path.join(testOutputDir, 'b.txt'), 'y'.repeat(200))
      expect(getDirectorySize(testOutputDir)).toBe(300)
    })

    it('sums sizes recursively across subdirectories', () => {
      fs.mkdirSync(path.join(testOutputDir, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(testOutputDir, 'top.txt'), 'a'.repeat(50))
      fs.writeFileSync(path.join(testOutputDir, 'sub', 'nested.txt'), 'b'.repeat(75))
      expect(getDirectorySize(testOutputDir)).toBe(125)
    })
  })

  describe('enforceQuota', () => {
    it('allows writes below the default (50 MB) limit', () => {
      delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
      expect(() => enforceQuota(testOutputDir, 1024)).not.toThrow()
    })

    it('throws when projected size would exceed the default limit', () => {
      delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
      // 51 MB projected write with an empty dir -> over 50 MB default
      expect(() => enforceQuota(testOutputDir, 51 * 1024 * 1024)).toThrow(/Output quota exceeded/)
    })

    it('respects CLERUM_WORKFLOW_OUTPUT_QUOTA_MB env var', () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1' // 1 MB cap
      expect(() => enforceQuota(testOutputDir, 512 * 1024)).not.toThrow()
      expect(() => enforceQuota(testOutputDir, 2 * 1024 * 1024)).toThrow(/Output quota exceeded/)
    })

    it('falls back to default when env var is not a positive integer', () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = 'garbage'
      expect(() => enforceQuota(testOutputDir, 1024)).not.toThrow()
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '0'
      expect(() => enforceQuota(testOutputDir, 1024)).not.toThrow()
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '-5'
      expect(() => enforceQuota(testOutputDir, 1024)).not.toThrow()
    })

    it('counts existing files toward the quota', () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1' // 1 MB cap
      // Write 900 KB already on disk
      fs.writeFileSync(path.join(testOutputDir, 'existing.bin'), Buffer.alloc(900 * 1024))
      // Another 200 KB would push us over
      expect(() => enforceQuota(testOutputDir, 200 * 1024)).toThrow(/Output quota exceeded/)
      // 50 KB still fits
      expect(() => enforceQuota(testOutputDir, 50 * 1024)).not.toThrow()
    })
  })

  describe('clerum__generate_markdown quota', () => {
    it('throws and does not write when content exceeds quota', async () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1' // 1 MB cap
      const tool = findTool('clerum__generate_markdown')
      const huge = 'x'.repeat(2 * 1024 * 1024) // 2 MB
      const result = await tool.execute({ filename: 'huge.md', content: huge }, testOutputDir)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Output quota exceeded/)
      expect(fs.existsSync(path.join(testOutputDir, 'huge.md'))).toBe(false)
    })

    it('writes successfully when under quota', async () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1'
      const tool = findTool('clerum__generate_markdown')
      const result = await tool.execute({ filename: 'ok.md', content: '# small' }, testOutputDir)

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(testOutputDir, 'ok.md'))).toBe(true)
    })
  })

  describe('clerum__generate_pdf quota', () => {
    it('throws and does not write when pdf size exceeds quota', async () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1' // 1 MB cap
      // Pre-fill the directory so any non-trivial PDF trips the quota.
      fs.writeFileSync(path.join(testOutputDir, 'filler.bin'), Buffer.alloc(1024 * 1024))

      const tool = findTool('clerum__generate_pdf')
      const result = await tool.execute(
        {
          filename: 'over.pdf',
          title: 'Over Quota',
          body: 'content',
        },
        testOutputDir
      )

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Output quota exceeded/)
      expect(fs.existsSync(path.join(testOutputDir, 'over.pdf'))).toBe(false)
    })
  })

  describe('clerum__generate_docx quota', () => {
    it('throws and does not write when docx size exceeds quota', async () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1'
      fs.writeFileSync(path.join(testOutputDir, 'filler.bin'), Buffer.alloc(1024 * 1024))

      const tool = findTool('clerum__generate_docx')
      const result = await tool.execute(
        { filename: 'over.docx', title: 'Over', body: 'content' },
        testOutputDir
      )

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Output quota exceeded/)
      expect(fs.existsSync(path.join(testOutputDir, 'over.docx'))).toBe(false)
    })
  })

  describe('clerum__generate_xlsx quota', () => {
    it('throws and does not write when xlsx size exceeds quota', async () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1'
      fs.writeFileSync(path.join(testOutputDir, 'filler.bin'), Buffer.alloc(1024 * 1024))

      const tool = findTool('clerum__generate_xlsx')
      const result = await tool.execute(
        {
          filename: 'over.xlsx',
          sheets: [{ name: 'S1', rows: [['a'], [1]] }],
        },
        testOutputDir
      )

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Output quota exceeded/)
      expect(fs.existsSync(path.join(testOutputDir, 'over.xlsx'))).toBe(false)
    })

    it('writes successfully when under quota', async () => {
      process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '50'
      const tool = findTool('clerum__generate_xlsx')
      const result = await tool.execute(
        {
          filename: 'ok.xlsx',
          sheets: [
            {
              name: 'S1',
              rows: [
                ['h1', 'h2'],
                [1, 2],
              ],
            },
          ],
        },
        testOutputDir
      )

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(testOutputDir, 'ok.xlsx'))).toBe(true)
    })
  })
})
