import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestModelInjection } from '../../src/injection/model'
import { getPreviousOutputPromptMaxChars, renderPrompt } from '../../src/injection/prompt'
import { loadSoul } from '../../src/injection/soul'
import { createStaticRuntimeTokenProvider } from '../../src/runtime-token-provider/provider'
import { AUTH_RETRY_DELAY_MS } from '../../src/status-reporter/authRetry'

describe('renderPrompt()', () => {
  afterEach(() => {
    delete process.env.CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS
  })

  it('replaces {{step-id:output}} with previousOutputs value', () => {
    const result = renderPrompt('Input was: {{extract:output}}', {
      step: { id: 'transform' } as any,
      previousOutputs: { extract: 'raw data' },
    })
    expect(result).toBe(
      'Input was: <step-output id="extract" data-only="true">\nraw data\n</step-output>'
    )
  })

  it('escapes unresolved references (does not throw)', () => {
    const result = renderPrompt('{{missing-step:output}}', {
      step: { id: 'x' } as any,
      previousOutputs: {},
    })
    expect(result).toBe('{{missing-step:output}}')
  })

  it('replaces {{workflow:name}} with workflow name', () => {
    const result = renderPrompt('Workflow: {{workflow:name}}', {
      step: { id: 'x' } as any,
      previousOutputs: {},
      workflowName: 'my-workflow',
    })
    expect(result).toBe('Workflow: my-workflow')
  })

  it('handles multiple replacements in single template', () => {
    const result = renderPrompt('{{a:output}} + {{b:output}}', {
      step: { id: 'c' } as any,
      previousOutputs: { a: 'one', b: 'two' },
    })
    expect(result).toBe(
      '<step-output id="a" data-only="true">\none\n</step-output> + <step-output id="b" data-only="true">\ntwo\n</step-output>'
    )
  })

  it('handles object output (JSON serialized)', () => {
    const result = renderPrompt('Data: {{a:output}}', {
      step: { id: 'b' } as any,
      previousOutputs: { a: { key: 'value' } },
    })
    expect(result).toBe(
      'Data: <step-output id="a" data-only="true">\n{"key":"value"}\n</step-output>'
    )
  })

  it('uses the default 8192 character cap for previous output prompt interpolation', () => {
    const result = renderPrompt('{{a:output}}', {
      step: { id: 'b' } as any,
      previousOutputs: { a: 'x'.repeat(9000) },
    })

    expect(result).toContain(
      '<step-output id="a" data-only="true" truncated="true" original-chars="9000" preview-chars="8192">'
    )
    expect(result).toContain(`${'x'.repeat(8192)}\n</step-output>`)
  })

  it('honors configured previous output prompt cap', async () => {
    vi.resetModules()
    process.env.CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS = '1024'
    const { renderPrompt } = await import('../../src/injection/prompt')

    const result = renderPrompt('{{a:output}}', {
      step: { id: 'b' } as any,
      previousOutputs: { a: 'y'.repeat(1200) },
    })

    expect(result).toContain('preview-chars="1024"')
    expect(result).toContain(`${'y'.repeat(1024)}\n</step-output>`)
  })

  it('rejects invalid previous output prompt caps', () => {
    expect(() => getPreviousOutputPromptMaxChars('999999')).toThrow(
      /CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS/
    )
  })

  it('replaces {{soul:content}} when soul provided', () => {
    const result = renderPrompt('System: {{soul:content}}', {
      step: { id: 'x' } as any,
      previousOutputs: {},
      soul: 'You are a helpful assistant',
    })
    expect(result).toBe('System: You are a helpful assistant')
  })

  it('leaves {{soul:content}} when soul not provided', () => {
    const result = renderPrompt('System: {{soul:content}}', {
      step: { id: 'x' } as any,
      previousOutputs: {},
    })
    expect(result).toBe('System: {{soul:content}}')
  })

  it('handles empty template', () => {
    const result = renderPrompt('', {
      step: { id: 'x' } as any,
      previousOutputs: {},
    })
    expect(result).toBe('')
  })

  it('handles template with no placeholders', () => {
    const result = renderPrompt('plain text', {
      step: { id: 'x' } as any,
      previousOutputs: {},
    })
    expect(result).toBe('plain text')
  })

  it('handles null output value', () => {
    const result = renderPrompt('{{a:output}}', {
      step: { id: 'b' } as any,
      previousOutputs: { a: null },
    })
    expect(result).toBe('<step-output id="a" data-only="true">\nnull\n</step-output>')
  })

  it('handles numeric output value', () => {
    const result = renderPrompt('Count: {{a:output}}', {
      step: { id: 'b' } as any,
      previousOutputs: { a: 42 },
    })
    expect(result).toBe('Count: <step-output id="a" data-only="true">\n42\n</step-output>')
  })

  it("escapes unknown field (not 'output')", () => {
    const result = renderPrompt('{{a:error}}', {
      step: { id: 'b' } as any,
      previousOutputs: { a: 'data' },
    })
    expect(result).toBe('{{a:error}}')
  })
})

describe('requestModelInjection()', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const provider = (token = 'tok') => createStaticRuntimeTokenProvider({ wrcToken: token })

  it('POSTs to correct URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await requestModelInjection('http://wrc:8082', 'wf', provider(), {
      stepId: 's1',
      provider: 'openai',
      model: 'gpt-4',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wrc:8082/api/v1/workflow/wf/injections/model',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('includes stepId, provider, model in body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await requestModelInjection('http://wrc:8082', 'wf', provider(), {
      stepId: 's1',
      provider: 'zai',
      model: 'glm-4.7',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.stepId).toBe('s1')
    expect(body.provider).toBe('zai')
    expect(body.model).toBe('glm-4.7')
  })

  it('refuses a Codex step when grantRedeemable is absent even if WRC returned 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ configured: true, identityBound: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      requestModelInjection('http://wrc:8082', 'wf', provider(), {
        stepId: 's1',
        provider: 'codex-subscription',
        model: 'gpt-5.1',
      })
    ).rejects.toThrow('Codex grant is not redeemable')
  })

  it('executes an OpenAI step on 2xx even when grantRedeemable is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ configured: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      requestModelInjection('http://wrc:8082', 'wf', provider(), {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-4',
      })
    ).resolves.toBeUndefined()
  })

  it('executes an Anthropic step on 2xx without a Codex readiness field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      requestModelInjection('http://wrc:8082', 'wf', provider(), {
        stepId: 's1',
        provider: 'claude',
        model: 'claude-3',
      })
    ).resolves.toBeUndefined()
  })

  it('executes a Codex step only when WRC marks the grant redeemable', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ configured: true, identityBound: true, grantRedeemable: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      requestModelInjection('http://wrc:8082', 'wf', provider(), {
        stepId: 's1',
        provider: 'codex-subscription',
        model: 'gpt-5.1',
      })
    ).resolves.toBeUndefined()
  })

  it('throws when WRC returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'ISE' }))
    await expect(
      requestModelInjection('http://wrc:8082', 'wf', provider(), {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-4',
      })
    ).rejects.toThrow('Model injection failed')
  })

  it('sends Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await requestModelInjection('http://wrc:8082', 'wf', provider('my-token'), {
      stepId: 's1',
      provider: 'claude',
      model: 'claude-3',
    })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer my-token')
  })

  it('uses a fresh abort signal when retrying model injection after 401', async () => {
    vi.useFakeTimers()
    const provider = createStaticRuntimeTokenProvider({ wrcToken: 'jwt-a' })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const pending = requestModelInjection('http://wrc:8082', 'wf', provider, {
      stepId: 's1',
      provider: 'openai',
      model: 'gpt-4',
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
    await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
    expect(fetchMock.mock.calls[1][1].signal).toBeDefined()
    expect(fetchMock.mock.calls[1][1].signal).not.toBe(fetchMock.mock.calls[0][1].signal)
  })
})

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

describe('loadSoul()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads soul from /etc/workflow/souls/{ref}', async () => {
    const fs = await import('node:fs/promises')
    vi.mocked(fs.readFile).mockResolvedValue('You are a helpful analyst')
    const content = await loadSoul('analyst.md')
    expect(content).toBe('You are a helpful analyst')
    expect(fs.readFile).toHaveBeenCalledWith('/etc/workflow/souls/analyst.md', 'utf-8')
  })

  it('throws when soul file not found', async () => {
    const fs = await import('node:fs/promises')
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(loadSoul('missing.md')).rejects.toThrow('ENOENT')
  })

  it("rejects path traversal with '..'", async () => {
    await expect(loadSoul('../../etc/passwd')).rejects.toThrow('Invalid soul reference')
  })

  it('rejects null byte in storageRef', async () => {
    await expect(loadSoul('file\0.md')).rejects.toThrow('Invalid soul reference')
  })

  it('rejects absolute path that escapes base directory', async () => {
    await expect(loadSoul('/etc/shadow')).rejects.toThrow('Soul path escapes base directory')
  })
})
