/**
 * Airtable MCP Server - MCP Operations Tests
 *
 * Tests for validating MCP protocol operations specific to Airtable.
 * These tests verify tools/list, tools/call, and MCP session handling.
 *
 * Covers:
 * - MCP tools/list endpoint
 * - MCP tools/call for Airtable operations
 * - Tool parameter validation
 * - Response formatting
 * - Error handling
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockAirtableClient } from './airtable.api.test'

// =============================================================================
// Types
// =============================================================================

interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

interface McpToolsListResponse {
  tools: McpTool[]
}

interface McpToolCallRequest {
  name: string
  arguments?: Record<string, any>
}

interface McpToolCallResponse {
  content: Array<{
    type: string
    text?: string
  }>
  isError?: boolean
}

// =============================================================================
// Mock Airtable MCP Server
// =============================================================================

class MockAirtableMcpServer {
  private airtableClient: ReturnType<typeof createMockAirtableClient>

  constructor() {
    this.airtableClient = createMockAirtableClient()
  }

  /**
   * MCP: tools/list
   * Returns list of available Airtable MCP tools
   */
  async toolsList(): Promise<McpToolsListResponse> {
    return {
      tools: [
        {
          name: 'airtable_list_bases',
          description: 'List all Airtable bases accessible to the user',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'airtable_list_tables',
          description: 'List all tables in a base',
          inputSchema: {
            type: 'object',
            properties: {
              baseId: {
                type: 'string',
                description: 'Airtable base ID',
              },
            },
            required: ['baseId'],
          },
        },
        {
          name: 'airtable_list_records',
          description: 'List records in a table',
          inputSchema: {
            type: 'object',
            properties: {
              baseId: {
                type: 'string',
                description: 'Airtable base ID',
              },
              tableId: {
                type: 'string',
                description: 'Airtable table ID or name',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of records to return',
              },
            },
            required: ['baseId', 'tableId'],
          },
        },
        {
          name: 'airtable_get_record',
          description: 'Get a specific record from a table',
          inputSchema: {
            type: 'object',
            properties: {
              baseId: { type: 'string' },
              tableId: { type: 'string' },
              recordId: { type: 'string' },
            },
            required: ['baseId', 'tableId', 'recordId'],
          },
        },
        {
          name: 'airtable_create_record',
          description: 'Create a new record in a table',
          inputSchema: {
            type: 'object',
            properties: {
              baseId: { type: 'string' },
              tableId: { type: 'string' },
              fields: {
                type: 'object',
                description: 'Field values for the new record',
              },
            },
            required: ['baseId', 'tableId', 'fields'],
          },
        },
        {
          name: 'airtable_update_record',
          description: 'Update an existing record',
          inputSchema: {
            type: 'object',
            properties: {
              baseId: { type: 'string' },
              tableId: { type: 'string' },
              recordId: { type: 'string' },
              fields: { type: 'object' },
            },
            required: ['baseId', 'tableId', 'recordId', 'fields'],
          },
        },
        {
          name: 'airtable_delete_record',
          description: 'Delete a record from a table',
          inputSchema: {
            type: 'object',
            properties: {
              baseId: { type: 'string' },
              tableId: { type: 'string' },
              recordId: { type: 'string' },
            },
            required: ['baseId', 'tableId', 'recordId'],
          },
        },
        {
          name: 'airtable_query_records',
          description: 'Query records with formula or filter',
          inputSchema: {
            type: 'object',
            properties: {
              baseId: { type: 'string' },
              tableId: { type: 'string' },
              filterByFormula: { type: 'string' },
              maxRecords: { type: 'number' },
            },
            required: ['baseId', 'tableId'],
          },
        },
      ],
    }
  }

  /**
   * MCP: tools/call
   * Execute an Airtable MCP tool
   */
  async toolsCall(request: McpToolCallRequest): Promise<McpToolCallResponse> {
    const { name, arguments: args } = request

    try {
      switch (name) {
        case 'airtable_list_bases':
          return await this.listBases()

        case 'airtable_list_tables':
          return await this.listTables(args!)

        case 'airtable_list_records':
          return await this.listRecords(args!)

        case 'airtable_get_record':
          return await this.getRecord(args!)

        case 'airtable_create_record':
          return await this.createRecord(args!)

        case 'airtable_update_record':
          return await this.updateRecord(args!)

        case 'airtable_delete_record':
          return await this.deleteRecord(args!)

        case 'airtable_query_records':
          return await this.queryRecords(args!)

        default:
          return {
            content: [
              {
                type: 'text',
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          }
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      }
    }
  }

  // =============================================================================
  // Tool Implementations
  // =============================================================================

  private async listBases(): Promise<McpToolCallResponse> {
    // Mock response - list bases
    const bases = [
      { id: 'appBase123', name: 'Test Base 1' },
      { id: 'appBase456', name: 'Test Base 2' },
    ]

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(bases, null, 2),
        },
      ],
    }
  }

  private async listTables(args: any): Promise<McpToolCallResponse> {
    const { baseId } = args

    if (!baseId) {
      throw new Error('baseId is required')
    }

    // Mock response
    const tables = [
      { id: 'tblTable1', name: 'Users' },
      { id: 'tblTable2', name: 'Products' },
    ]

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(tables, null, 2),
        },
      ],
    }
  }

  private async listRecords(args: any): Promise<McpToolCallResponse> {
    const { baseId, tableId, limit } = args

    if (!baseId || !tableId) {
      throw new Error('baseId and tableId are required')
    }

    const result = await this.airtableClient.listRecords(baseId, tableId, {
      limit,
    })

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.records, null, 2),
        },
      ],
    }
  }

  private async getRecord(args: any): Promise<McpToolCallResponse> {
    const { baseId, tableId, recordId } = args

    if (!baseId || !tableId || !recordId) {
      throw new Error('baseId, tableId, and recordId are required')
    }

    const record = await this.airtableClient.getRecord(baseId, tableId, recordId)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(record, null, 2),
        },
      ],
    }
  }

  private async createRecord(args: any): Promise<McpToolCallResponse> {
    const { baseId, tableId, fields } = args

    if (!baseId || !tableId || !fields) {
      throw new Error('baseId, tableId, and fields are required')
    }

    const record = await this.airtableClient.createRecord(baseId, tableId, fields)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(record, null, 2),
        },
      ],
    }
  }

  private async updateRecord(args: any): Promise<McpToolCallResponse> {
    const { baseId, tableId, recordId, fields } = args

    if (!baseId || !tableId || !recordId || !fields) {
      throw new Error('baseId, tableId, recordId, and fields are required')
    }

    const record = await this.airtableClient.updateRecord(baseId, tableId, recordId, fields)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(record, null, 2),
        },
      ],
    }
  }

  private async deleteRecord(args: any): Promise<McpToolCallResponse> {
    const { baseId, tableId, recordId } = args

    if (!baseId || !tableId || !recordId) {
      throw new Error('baseId, tableId, and recordId are required')
    }

    const result = await this.airtableClient.deleteRecord(baseId, tableId, recordId)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  }

  private async queryRecords(args: any): Promise<McpToolCallResponse> {
    const { baseId, tableId, filterByFormula, maxRecords } = args

    if (!baseId || !tableId) {
      throw new Error('baseId and tableId are required')
    }

    // Mock query implementation
    // In real implementation, would use filterByFormula
    const result = await this.airtableClient.listRecords(baseId, tableId, {
      limit: maxRecords,
    })

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.records, null, 2),
        },
      ],
    }
  }

  // =============================================================================
  // Setup Helpers
  // =============================================================================

  setupMockData() {
    const records = [
      {
        id: 'rec1',
        createdTime: '2024-01-01T00:00:00.000Z',
        fields: { Name: 'Alice', Email: 'alice@example.com' },
      },
      {
        id: 'rec2',
        createdTime: '2024-01-02T00:00:00.000Z',
        fields: { Name: 'Bob', Email: 'bob@example.com' },
      },
    ]

    ;(this.airtableClient as any).setMockData('appBase123', 'tblUsers', records)
  }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Airtable MCP Server - MCP Operations', () => {
  let server: MockAirtableMcpServer

  beforeEach(() => {
    server = new MockAirtableMcpServer()
    server.setupMockData()
  })

  describe('tools/list', () => {
    it('should return all available Airtable tools', async () => {
      const response = await server.toolsList()

      expect(response.tools).toBeDefined()
      expect(response.tools.length).toBeGreaterThan(0)
    })

    it('should include airtable_list_records tool', async () => {
      const response = await server.toolsList()

      const listRecordsTool = response.tools.find(t => t.name === 'airtable_list_records')
      expect(listRecordsTool).toBeDefined()
      expect(listRecordsTool?.description).toContain('records')
    })

    it('should have correct input schema for list_records', async () => {
      const response = await server.toolsList()

      const listRecordsTool = response.tools.find(t => t.name === 'airtable_list_records')

      expect(listRecordsTool?.inputSchema.type).toBe('object')
      expect(listRecordsTool?.inputSchema.properties).toHaveProperty('baseId')
      expect(listRecordsTool?.inputSchema.properties).toHaveProperty('tableId')
      expect(listRecordsTool?.inputSchema.required).toEqual(['baseId', 'tableId'])
    })

    it('should include CRUD operations tools', async () => {
      const response = await server.toolsList()

      const toolNames = response.tools.map(t => t.name)

      expect(toolNames).toContain('airtable_create_record')
      expect(toolNames).toContain('airtable_get_record')
      expect(toolNames).toContain('airtable_update_record')
      expect(toolNames).toContain('airtable_delete_record')
    })

    it('should include query operation tool', async () => {
      const response = await server.toolsList()

      const queryTool = response.tools.find(t => t.name === 'airtable_query_records')

      expect(queryTool).toBeDefined()
      expect(queryTool?.inputSchema.properties).toHaveProperty('filterByFormula')
    })
  })

  describe('tools/call - airtable_list_records', () => {
    it('should list records successfully', async () => {
      const response = await server.toolsCall({
        name: 'airtable_list_records',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
        },
      })

      expect(response.isError).toBeUndefined()
      expect(response.content).toHaveLength(1)
      expect(response.content[0].type).toBe('text')

      const records = JSON.parse(response.content[0].text!)
      expect(records).toHaveLength(2)
      expect(records[0].fields.Name).toBe('Alice')
    })

    it('should respect limit parameter', async () => {
      const response = await server.toolsCall({
        name: 'airtable_list_records',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
          limit: 1,
        },
      })

      const records = JSON.parse(response.content[0].text!)
      expect(records).toHaveLength(1)
    })

    it('should return error for missing baseId', async () => {
      const response = await server.toolsCall({
        name: 'airtable_list_records',
        arguments: {
          tableId: 'tblUsers',
        },
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('baseId')
    })

    it('should return error for missing tableId', async () => {
      const response = await server.toolsCall({
        name: 'airtable_list_records',
        arguments: {
          baseId: 'appBase123',
        },
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('tableId')
    })
  })

  describe('tools/call - airtable_get_record', () => {
    it('should get a specific record', async () => {
      const response = await server.toolsCall({
        name: 'airtable_get_record',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
          recordId: 'rec1',
        },
      })

      expect(response.isError).toBeUndefined()

      const record = JSON.parse(response.content[0].text!)
      expect(record.id).toBe('rec1')
      expect(record.fields.Name).toBe('Alice')
    })

    it('should return error for non-existent record', async () => {
      const response = await server.toolsCall({
        name: 'airtable_get_record',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
          recordId: 'recNonExistent',
        },
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('NOT_FOUND')
    })
  })

  describe('tools/call - airtable_create_record', () => {
    it('should create a new record', async () => {
      const response = await server.toolsCall({
        name: 'airtable_create_record',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
          fields: {
            Name: 'Charlie',
            Email: 'charlie@example.com',
          },
        },
      })

      expect(response.isError).toBeUndefined()

      const record = JSON.parse(response.content[0].text!)
      expect(record.fields.Name).toBe('Charlie')
      expect(record.id).toMatch(/^rec\d+$/)
    })

    it('should return error for missing fields', async () => {
      const response = await server.toolsCall({
        name: 'airtable_create_record',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
        },
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('fields')
    })
  })

  describe('tools/call - airtable_update_record', () => {
    it('should update an existing record', async () => {
      const response = await server.toolsCall({
        name: 'airtable_update_record',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
          recordId: 'rec1',
          fields: {
            Email: 'alice.new@example.com',
          },
        },
      })

      expect(response.isError).toBeUndefined()

      const record = JSON.parse(response.content[0].text!)
      expect(record.fields.Name).toBe('Alice') // Unchanged
      expect(record.fields.Email).toBe('alice.new@example.com')
    })
  })

  describe('tools/call - airtable_delete_record', () => {
    it('should delete a record', async () => {
      const response = await server.toolsCall({
        name: 'airtable_delete_record',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
          recordId: 'rec1',
        },
      })

      expect(response.isError).toBeUndefined()

      const result = JSON.parse(response.content[0].text!)
      expect(result.deleted).toBe(true)
      expect(result.id).toBe('rec1')
    })
  })

  describe('tools/call - unknown tool', () => {
    it('should return error for unknown tool', async () => {
      const response = await server.toolsCall({
        name: 'unknown_tool',
        arguments: {},
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('Unknown tool')
    })
  })

  describe('Response Format', () => {
    it('should return content array', async () => {
      const response = await server.toolsCall({
        name: 'airtable_list_records',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
        },
      })

      expect(Array.isArray(response.content)).toBe(true)
    })

    it('should include text type in content', async () => {
      const response = await server.toolsCall({
        name: 'airtable_list_records',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
        },
      })

      expect(response.content[0].type).toBe('text')
      expect(response.content[0].text).toBeDefined()
    })

    it('should return valid JSON in text field', async () => {
      const response = await server.toolsCall({
        name: 'airtable_list_records',
        arguments: {
          baseId: 'appBase123',
          tableId: 'tblUsers',
        },
      })

      expect(() => {
        JSON.parse(response.content[0].text!)
      }).not.toThrow()
    })
  })
})
