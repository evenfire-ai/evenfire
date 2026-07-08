import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../../../agent/cronScheduler'
import { MessageQueue } from '../../../queue/messageQueue'
import type { NativeToolConfig } from '../../interfaces'
import { DefaultPromptBuilder, TOOL_DISCOVERY_TEXT } from '../../reasoning/promptBuilder'
import { JsonTransformTool } from '../jsonTransform'
import { NativeToolRegistry } from '../nativeToolRegistry'

describe('JsonTransformTool', () => {
  const tool = new JsonTransformTool()

  it('should parse valid JSON', async () => {
    const result = await tool.execute({
      input: '{"name": "test", "count": 42}',
      operation: 'parse',
    })
    expect(result.is_error).toBe(false)
    const parsed = JSON.parse(result.content)
    expect(parsed.name).toBe('test')
  })

  it('should return error for malformed JSON', async () => {
    const result = await tool.execute({
      input: 'not valid json {',
      operation: 'parse',
    })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Error parsing JSON')
  })

  it('should extract nested values by dot-path', async () => {
    const result = await tool.execute({
      input: '{"data": {"items": [{"name": "first"}]}}',
      operation: 'get',
      path: 'data.items.0.name',
    })
    expect(result.is_error).toBe(false)
    // getByPath returns "first" (string), returned directly without JSON.stringify
    expect(result.content).toBe('first')
  })
})

describe('NativeToolRegistry', () => {
  const config: NativeToolConfig = {
    workspacePath: '/tmp',
    shellTimeout: 5000,
    toolTimeout: 60000,
    toolProgressInterval: 30000,
    httpAllowlist: [],
    envAllowlist: ['PATH'],
    memoryMaxSize: 1048576,
  }

  const workflowEnvKeys = [
    'MCP_HOST_GATEWAY_URL',
    'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
    'MCP_HOST_RUNTIME_ACCESS_TOKEN',
    'MCP_HOST_RUNTIME_REFRESH_TOKEN',
  ] as const
  type WorkflowEnvKey = (typeof workflowEnvKeys)[number]
  const originalWorkflowEnv = new Map<string, string | undefined>()

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of workflowEnvKeys) {
      const original = originalWorkflowEnv.get(key)
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
    originalWorkflowEnv.clear()
  })

  function setWorkflowProcessEnv(values: Partial<Record<WorkflowEnvKey, string>>) {
    for (const key of workflowEnvKeys) {
      if (!originalWorkflowEnv.has(key)) originalWorkflowEnv.set(key, process.env[key])
      const value = values[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  it('should register native tools without workspace or cron scheduler', () => {
    const registry = new NativeToolRegistry(config, 'test-conv')
    const defs = registry.listDefinitions()

    // #592: clerum__context_files_* are gated on a mounted SharedFileSystem
    // (CLERUM_CONTEXT_FILES_MOUNTS); none is set here, so they are not exposed.
    expect(defs).toHaveLength(14)
    const names = defs.map(d => d.name).sort()
    expect(names).toEqual([
      'clerum__generate_chart',
      'clerum__generate_dashboard',
      'clerum__generate_docx',
      'clerum__generate_markdown',
      'clerum__generate_pdf',
      'clerum__generate_pptx',
      'clerum__generate_xlsx',
      'clerum__get_capabilities',
      'file_read',
      'file_write',
      'http_request',
      'json_transform',
      'shell_exec',
      'system_info',
    ])
    expect(registry.get('workflow_trigger')).toBeNull()
    expect(registry.get('clerum__list_workflows')).toBeNull()
  })

  it('registers GFS tools only when runtime GFS access is present', () => {
    const key = 'MCP_HOST_GFS_TOKEN'
    const prev = process.env[key]
    process.env[key] = 'gfs-access'
    try {
      const names = new NativeToolRegistry(config, 'test-conv').listDefinitions().map(d => d.name)
      expect(names).toContain('clerum__gfs_accessible')
      expect(names).toContain('clerum__gfs_list')
      expect(names).toContain('clerum__gfs_read')
      expect(names).toContain('clerum__gfs_write')
    } finally {
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
    const namesNoGfs = new NativeToolRegistry(config, 'test-conv')
      .listDefinitions()
      .map(d => d.name)
    expect(namesNoGfs).not.toContain('clerum__gfs_accessible')
  })

  it('exposes clerum__context_files_* ONLY when a SharedFileSystem is mounted (#592 capability gate)', () => {
    const prev = process.env.CLERUM_CONTEXT_FILES_MOUNTS
    process.env.CLERUM_CONTEXT_FILES_MOUNTS = JSON.stringify([
      {
        name: 'team-mission',
        namespace: 'mcp-host',
        mountPath: '/context-files/team-mission',
        pvcName: 'sfs-abc-files',
      },
    ])
    try {
      const registry = new NativeToolRegistry(config, 'test-conv')
      const names = registry.listDefinitions().map(d => d.name)
      // With a mount present the context-files tools ARE exposed...
      expect(names).toContain('clerum__context_files_list')
      expect(names).toContain('clerum__context_files_read')
    } finally {
      if (prev === undefined) delete process.env.CLERUM_CONTEXT_FILES_MOUNTS
      else process.env.CLERUM_CONTEXT_FILES_MOUNTS = prev
    }
    // ...and absent again with no mount (the default the other tests assert).
    const namesNoMount = new NativeToolRegistry(config, 'test-conv')
      .listDefinitions()
      .map(d => d.name)
    expect(namesNoMount).not.toContain('clerum__context_files_list')
    expect(namesNoMount).not.toContain('clerum__context_files_read')
  })

  it('should register native tools with cron scheduler (no workspace)', () => {
    const queue = new MessageQueue()
    const cronScheduler = new CronScheduler(queue)
    const registry = new NativeToolRegistry(config, 'test-conv', cronScheduler)
    const defs = registry.listDefinitions()

    expect(defs).toHaveLength(15)
    const names = defs.map(d => d.name).sort()
    expect(names).toEqual([
      'clerum__generate_chart',
      'clerum__generate_dashboard',
      'clerum__generate_docx',
      'clerum__generate_markdown',
      'clerum__generate_pdf',
      'clerum__generate_pptx',
      'clerum__generate_xlsx',
      'clerum__get_capabilities',
      'cron_manage',
      'file_read',
      'file_write',
      'http_request',
      'json_transform',
      'shell_exec',
      'system_info',
    ])
    cronScheduler.stop()
  })

  // F3/F4 (dynamic-tool-loading): the 3 bridge tools (clerum__tool_search /
  // tool_describe / tool_call) are gated on BOTH an McpManager being wired AND
  // the static feature flag. Default OFF must be byte-identical to today.
  describe('dynamic-tool-loading bridge gating', () => {
    const BRIDGE_TOOLS = ['clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call']
    // Minimal McpManager stub: the bridge tools only need getAllTools().
    const mcpManagerStub = { getAllTools: () => [] } as unknown as ConstructorParameters<
      typeof NativeToolRegistry
    >[10]

    function buildRegistry(dynamicToolsEnabled: boolean): NativeToolRegistry {
      return new NativeToolRegistry(
        config,
        'test-conv',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mcpManagerStub,
        dynamicToolsEnabled
      )
    }

    function bridgeToolNames(registry: NativeToolRegistry): string[] {
      return registry
        .listDefinitions()
        .map(d => d.name)
        .filter(name => BRIDGE_TOOLS.includes(name))
    }

    it('flag OFF ⇒ bridge tools NOT registered AND guidance NOT emitted (byte-identical to today)', () => {
      const registry = buildRegistry(false)
      // No bridge tools in tools[] even though an McpManager is wired.
      expect(bridgeToolNames(registry)).toEqual([])
      // Both prompt paths gate the discovery guidance on the presence of
      // clerum__tool_search; with the flag OFF that tool is absent, so neither
      // path emits TOOL_DISCOVERY_TEXT.
      const prompt = new DefaultPromptBuilder().buildSystemPrompt(registry.listDefinitions())
        .content as string
      expect(prompt).not.toContain(TOOL_DISCOVERY_TEXT)
    })

    it('flag ON ⇒ all 3 bridge tools registered and discovery guidance emitted', () => {
      const registry = buildRegistry(true)
      expect(bridgeToolNames(registry).sort()).toEqual([...BRIDGE_TOOLS].sort())
      const prompt = new DefaultPromptBuilder().buildSystemPrompt(registry.listDefinitions())
        .content as string
      expect(prompt).toContain(TOOL_DISCOVERY_TEXT)
    })
  })

  it('registers workflow tools only when the mcpHost control env contract is present', () => {
    setWorkflowProcessEnv({
      MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
      MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'workflow-token',
      MCP_HOST_RUNTIME_ACCESS_TOKEN: 'runtime-access',
      MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
    })

    const registry = new NativeToolRegistry(config, 'test-conv', undefined, undefined, undefined)
    const defs = registry.listDefinitions()
    const names = defs.map(d => d.name).sort()

    expect(defs).toHaveLength(18)
    expect(names).toEqual([
      'clerum__generate_chart',
      'clerum__generate_dashboard',
      'clerum__generate_docx',
      'clerum__generate_markdown',
      'clerum__generate_pdf',
      'clerum__generate_pptx',
      'clerum__generate_xlsx',
      'clerum__get_capabilities',
      'file_read',
      'file_write',
      'http_request',
      'json_transform',
      'shell_exec',
      'system_info',
      'workflow_health',
      'workflow_list',
      'workflow_status',
      'workflow_trigger',
    ])
    expect(registry.get('workflow_trigger')?.requiresApproval()).toBe(true)
    expect(registry.get('workflow_list')?.requiresApproval()).toBe(false)
    expect(registry.get('clerum__trigger_workflow')).toBeNull()
  })

  it('does not expose workflow_trigger when runtime approval env is absent', () => {
    setWorkflowProcessEnv({
      MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
      MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'workflow-token',
    })

    const registry = new NativeToolRegistry(config, 'test-conv', undefined, undefined, undefined)
    const defs = registry.listDefinitions()
    const names = defs.map(d => d.name).sort()

    expect(defs).toHaveLength(17)
    expect(names).toEqual([
      'clerum__generate_chart',
      'clerum__generate_dashboard',
      'clerum__generate_docx',
      'clerum__generate_markdown',
      'clerum__generate_pdf',
      'clerum__generate_pptx',
      'clerum__generate_xlsx',
      'clerum__get_capabilities',
      'file_read',
      'file_write',
      'http_request',
      'json_transform',
      'shell_exec',
      'system_info',
      'workflow_health',
      'workflow_list',
      'workflow_status',
    ])
    expect(registry.get('workflow_trigger')).toBeNull()
  })

  it('derives workflow chat targets from rpc source context without exposing target schema fields', () => {
    setWorkflowProcessEnv({
      MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
      MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'workflow-token',
      MCP_HOST_RUNTIME_ACCESS_TOKEN: 'runtime-access',
      MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
    })

    const registry = new NativeToolRegistry(config, 'test-conv', undefined, {
      content: 'List my workflow recipes and required inputs',
      channelType: 'rpc',
      channelId: 'chatllm',
      sender: '00000000-0000-4000-8000-000000000001',
      timestamp: '2026-05-26T12:00:00.000Z',
      messageId: 'message-1',
      threadId: 'thread-1',
      hostRef: 'chatllm',
      metadata: { teamId: '00000000-0000-4000-8000-0000000000aa' },
    })

    const schemas = registry
      .listDefinitions()
      .filter(def => def.name.startsWith('workflow_'))
      .map(def => def.parameters)
    const serialized = JSON.stringify(schemas)
    expect(serialized).not.toContain('targetUserId')
    expect(serialized).not.toContain('targetTeamId')
    expect(registry.get('workflow_trigger')?.requiresApproval()).toBe(true)
  })

  it('does not expose workflow tools to provider-originated messages without verified identity context', () => {
    setWorkflowProcessEnv({
      MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
      MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'workflow-token',
      MCP_HOST_RUNTIME_ACCESS_TOKEN: 'runtime-access',
      MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
    })

    const registry = new NativeToolRegistry(config, 'test-conv', undefined, {
      content: 'List my workflow recipes',
      channelType: 'telegram',
      channelId: 'tg-chat-1',
      sender: '123456',
      timestamp: '2026-05-28T12:00:00.000Z',
      messageId: 'telegram:tg-chat-1:42',
      hostRef: 'chatllm',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerEventId: 'telegram:tg-chat-1:42',
      },
    })

    const names = registry.listDefinitions().map(d => d.name)
    expect(names).not.toContain('workflow_list')
    expect(names).not.toContain('workflow_status')
    expect(names).not.toContain('workflow_health')
    expect(names).not.toContain('workflow_trigger')
  })

  it('exposes provider-originated workflow tools only with resolved caller context and hidden target fields', () => {
    setWorkflowProcessEnv({
      MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
      MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'workflow-token',
      MCP_HOST_RUNTIME_ACCESS_TOKEN: 'runtime-access',
      MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
    })

    const registry = new NativeToolRegistry(
      config,
      'test-conv',
      undefined,
      {
        content: 'Run my workflow',
        channelType: 'telegram',
        channelId: 'tg-chat-1',
        sender: '123456',
        timestamp: '2026-05-28T12:00:00.000Z',
        messageId: 'telegram:tg-chat-1:42',
        hostRef: 'chatllm',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: 'tg-chat-1',
          providerEventId: 'telegram:tg-chat-1:42',
        },
      },
      undefined,
      undefined,
      {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'telegram:tg-chat-1:123456',
        originChannelType: 'telegram',
      }
    )

    const schemas = registry
      .listDefinitions()
      .filter(def => def.name.startsWith('workflow_'))
      .map(def => def.parameters)
    const serialized = JSON.stringify(schemas)
    expect(serialized).not.toContain('targetUserId')
    expect(serialized).not.toContain('targetTeamId')
    expect(serialized).not.toContain('namespace')
    expect(registry.get('workflow_list')).not.toBeNull()
    expect(registry.get('workflow_status')).not.toBeNull()
    expect(registry.get('workflow_health')).not.toBeNull()
    expect(registry.get('workflow_trigger')?.requiresApproval()).toBe(false)
  })

  it('ignores dynamic ConfigStore overrides for workflow broker URL and token', async () => {
    setWorkflowProcessEnv({
      MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
      MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'workflow-token',
      MCP_HOST_RUNTIME_ACCESS_TOKEN: 'runtime-access',
      MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], count: 0 }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const registry = new NativeToolRegistry(
      config,
      'test-conv',
      undefined,
      undefined,
      undefined,
      () => ({
        MCP_HOST_GATEWAY_URL: 'https://attacker.example',
        MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'attacker-token',
      })
    )

    const result = await registry.get('workflow_list')?.execute({})

    expect(result?.is_error).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflows',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer workflow-token',
        }),
      })
    )
  })
})
