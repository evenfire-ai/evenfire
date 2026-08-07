/**
 * MongoDB MCP Server - MCP Operations Tests
 *
 * Tests for validating MCP protocol operations specific to MongoDB.
 * These tests verify tools/list, tools/call, and MCP session handling.
 *
 * Covers:
 * - MCP tools/list endpoint
 * - MCP tools/call for MongoDB operations
 * - Tool parameter validation
 * - Response formatting
 * - Error handling
 * - Read-only mode enforcement
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockMongoClient, setupMockMongoData } from './mongodb.connection.test'

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
// Mock MongoDB MCP Server
// =============================================================================

class MockMongoMcpServer {
  private mongoClient: ReturnType<typeof createMockMongoClient>
  private readOnlyMode: boolean = true

  constructor() {
    this.mongoClient = createMockMongoClient()
  }

  /**
   * Initialize connection
   */
  async initialize(connectionString: string): Promise<void> {
    await this.mongoClient.connect(connectionString)
  }

  /**
   * Set read-only mode
   */
  setReadOnlyMode(readOnly: boolean): void {
    this.readOnlyMode = readOnly
  }

  /**
   * MCP: tools/list
   * Returns list of available MongoDB MCP tools
   */
  async toolsList(): Promise<McpToolsListResponse> {
    return {
      tools: [
        {
          name: 'mongodb_find',
          description: 'Find documents in a collection using a query filter',
          inputSchema: {
            type: 'object',
            properties: {
              database: {
                type: 'string',
                description: 'Database name',
              },
              collection: {
                type: 'string',
                description: 'Collection name',
              },
              filter: {
                type: 'object',
                description: 'Query filter',
              },
              projection: {
                type: 'object',
                description: 'Projection to limit returned fields',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of documents to return',
              },
              sort: {
                type: 'object',
                description: 'Sort specification',
              },
            },
            required: ['database', 'collection'],
          },
        },
        {
          name: 'mongodb_aggregate',
          description: 'Execute an aggregation pipeline',
          inputSchema: {
            type: 'object',
            properties: {
              database: { type: 'string' },
              collection: { type: 'string' },
              pipeline: {
                type: 'array',
                description: 'Aggregation pipeline stages',
              },
            },
            required: ['database', 'collection', 'pipeline'],
          },
        },
        {
          name: 'mongodb_count',
          description: 'Count documents in a collection',
          inputSchema: {
            type: 'object',
            properties: {
              database: { type: 'string' },
              collection: { type: 'string' },
              filter: { type: 'object' },
            },
            required: ['database', 'collection'],
          },
        },
        {
          name: 'mongodb_distinct',
          description: 'Get distinct values for a field',
          inputSchema: {
            type: 'object',
            properties: {
              database: { type: 'string' },
              collection: { type: 'string' },
              field: { type: 'string' },
              filter: { type: 'object' },
            },
            required: ['database', 'collection', 'field'],
          },
        },
        {
          name: 'mongodb_insert_one',
          description: 'Insert a single document into a collection',
          inputSchema: {
            type: 'object',
            properties: {
              database: { type: 'string' },
              collection: { type: 'string' },
              document: {
                type: 'object',
                description: 'Document to insert',
              },
            },
            required: ['database', 'collection', 'document'],
          },
        },
        {
          name: 'mongodb_update_one',
          description: 'Update a single document',
          inputSchema: {
            type: 'object',
            properties: {
              database: { type: 'string' },
              collection: { type: 'string' },
              filter: { type: 'object' },
              update: { type: 'object' },
            },
            required: ['database', 'collection', 'filter', 'update'],
          },
        },
        {
          name: 'mongodb_delete_one',
          description: 'Delete a single document',
          inputSchema: {
            type: 'object',
            properties: {
              database: { type: 'string' },
              collection: { type: 'string' },
              filter: { type: 'object' },
            },
            required: ['database', 'collection', 'filter'],
          },
        },
        {
          name: 'mongodb_list_collections',
          description: 'List all collections in a database',
          inputSchema: {
            type: 'object',
            properties: {
              database: { type: 'string' },
            },
            required: ['database'],
          },
        },
        {
          name: 'mongodb_list_databases',
          description: 'List all databases on the server',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }
  }

  /**
   * MCP: tools/call
   * Execute a MongoDB MCP tool
   */
  async toolsCall(request: McpToolCallRequest): Promise<McpToolCallResponse> {
    const { name, arguments: args } = request

    try {
      switch (name) {
        case 'mongodb_find':
          return await this.find(args!)

        case 'mongodb_aggregate':
          return await this.aggregate(args!)

        case 'mongodb_count':
          return await this.count(args!)

        case 'mongodb_distinct':
          return await this.distinct(args!)

        case 'mongodb_insert_one':
          return await this.insertOne(args!)

        case 'mongodb_update_one':
          return await this.updateOne(args!)

        case 'mongodb_delete_one':
          return await this.deleteOne(args!)

        case 'mongodb_list_collections':
          return await this.listCollections(args!)

        case 'mongodb_list_databases':
          return await this.listDatabases()

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

  private async find(args: any): Promise<McpToolCallResponse> {
    const { database, collection, filter = {}, projection, limit, sort } = args

    // Validate required parameters
    if (!database || !collection) {
      return {
        content: [
          {
            type: 'text',
            text: 'Missing required parameters: database and collection are required',
          },
        ],
        isError: true,
      }
    }

    const documents = await this.mongoClient.find(collection, {
      filter,
      projection,
      limit,
      sort,
    })

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(documents, null, 2),
        },
      ],
    }
  }

  private async aggregate(args: any): Promise<McpToolCallResponse> {
    const { database, collection, pipeline } = args

    // Validate required parameters
    if (!database || !collection || !pipeline) {
      return {
        content: [
          {
            type: 'text',
            text: 'Missing required parameters: database, collection, and pipeline are required',
          },
        ],
        isError: true,
      }
    }

    const documents = await this.mongoClient.aggregate(collection, pipeline)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(documents, null, 2),
        },
      ],
    }
  }

  private async count(args: any): Promise<McpToolCallResponse> {
    const { database, collection, filter = {} } = args

    const count = await this.mongoClient.count(collection, filter)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count }, null, 2),
        },
      ],
    }
  }

  private async distinct(args: any): Promise<McpToolCallResponse> {
    const { database, collection, field, filter = {} } = args

    // Simplified distinct implementation
    const documents = await this.mongoClient.find(collection, { filter })
    const distinctValues = Array.from(new Set(documents.map(doc => doc[field])))

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(distinctValues, null, 2),
        },
      ],
    }
  }

  private async insertOne(args: any): Promise<McpToolCallResponse> {
    this.enforceReadOnly('insert_one')

    const { database, collection, document } = args

    const result = await this.mongoClient.insertOne(collection, document)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  }

  private async updateOne(args: any): Promise<McpToolCallResponse> {
    this.enforceReadOnly('update_one')

    const { database, collection, filter, update } = args

    const result = await this.mongoClient.updateOne(collection, filter, update)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  }

  private async deleteOne(args: any): Promise<McpToolCallResponse> {
    this.enforceReadOnly('delete_one')

    const { database, collection, filter } = args

    const result = await this.mongoClient.deleteOne(collection, filter)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  }

  private async listCollections(args: any): Promise<McpToolCallResponse> {
    const { database } = args

    // Mock response
    const collections = ['users', 'products', 'orders']

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(collections, null, 2),
        },
      ],
    }
  }

  private async listDatabases(): Promise<McpToolCallResponse> {
    // Mock response
    const databases = ['admin', 'config', 'test']

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(databases, null, 2),
        },
      ],
    }
  }

  // =============================================================================
  // Helpers
  // =============================================================================

  private enforceReadOnly(operation: string): void {
    if (this.readOnlyMode) {
      throw new Error(`Write operation '${operation}' blocked in read-only mode`)
    }
  }

  // =============================================================================
  // Setup Helpers
  // =============================================================================

  setupMockData() {
    setupMockMongoData(this.mongoClient, 'multiple')

    // Override for MongoDB specific tests
    const documents = [
      { _id: '1', name: 'Alice', age: 30, department: 'Engineering' },
      { _id: '2', name: 'Bob', age: 25, department: 'Sales' },
      { _id: '3', name: 'Charlie', age: 35, department: 'Engineering' },
      { _id: '4', name: 'Diana', age: 28, department: 'Marketing' },
    ]

    ;(this.mongoClient as any).setCollectionData('users', documents)
  }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('MongoDB MCP Server - MCP Operations', () => {
  let server: MockMongoMcpServer

  beforeEach(async () => {
    server = new MockMongoMcpServer()
    await server.initialize('mongodb://localhost:27017/test')
    server.setupMockData()
  })

  describe('tools/list', () => {
    it('should return all available MongoDB tools', async () => {
      const response = await server.toolsList()

      expect(response.tools).toBeDefined()
      expect(response.tools.length).toBeGreaterThan(0)
    })

    it('should include mongodb_find tool', async () => {
      const response = await server.toolsList()

      const findTool = response.tools.find(t => t.name === 'mongodb_find')
      expect(findTool).toBeDefined()
      expect(findTool?.description).toContain('Find')
    })

    it('should include mongodb_aggregate tool', async () => {
      const response = await server.toolsList()

      const aggregateTool = response.tools.find(t => t.name === 'mongodb_aggregate')
      expect(aggregateTool).toBeDefined()
    })

    it('should include write operation tools', async () => {
      const response = await server.toolsList()

      const toolNames = response.tools.map(t => t.name)

      expect(toolNames).toContain('mongodb_insert_one')
      expect(toolNames).toContain('mongodb_update_one')
      expect(toolNames).toContain('mongodb_delete_one')
    })

    it('should have database and collection as required for find', async () => {
      const response = await server.toolsList()

      const findTool = response.tools.find(t => t.name === 'mongodb_find')

      expect(findTool?.inputSchema.required).toContain('database')
      expect(findTool?.inputSchema.required).toContain('collection')
    })
  })

  describe('tools/call - mongodb_find', () => {
    it('should find documents successfully', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          database: 'test',
          collection: 'users',
          filter: { department: 'Engineering' },
        },
      })

      expect(response.isError).toBeUndefined()

      const documents = JSON.parse(response.content[0].text!)
      expect(documents).toHaveLength(2)
      expect(documents[0].department).toBe('Engineering')
    })

    it('should support limit parameter', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          database: 'test',
          collection: 'users',
          limit: 2,
        },
      })

      const documents = JSON.parse(response.content[0].text!)
      expect(documents).toHaveLength(2)
    })

    it('should support sort parameter', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          database: 'test',
          collection: 'users',
          sort: { age: 1 },
        },
      })

      const documents = JSON.parse(response.content[0].text!)
      expect(documents[0].age).toBe(25) // Bob (youngest)
      expect(documents[3].age).toBe(35) // Charlie (oldest)
    })

    it('should return error for missing database', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          collection: 'users',
        },
      })

      expect(response.isError).toBe(true)
    })
  })

  describe('tools/call - mongodb_aggregate', () => {
    it('should execute aggregation pipeline', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_aggregate',
        arguments: {
          database: 'test',
          collection: 'users',
          pipeline: [{ $match: { department: 'Engineering' } }],
        },
      })

      expect(response.isError).toBeUndefined()

      const documents = JSON.parse(response.content[0].text!)
      expect(documents.length).toBeGreaterThan(0)
    })

    it('should support multiple pipeline stages', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_aggregate',
        arguments: {
          database: 'test',
          collection: 'users',
          pipeline: [{ $match: { age: { $gte: 30 } } }, { $sort: { age: -1 } }, { $limit: 2 }],
        },
      })

      const documents = JSON.parse(response.content[0].text!)
      expect(documents).toHaveLength(2)
    })
  })

  describe('tools/call - mongodb_count', () => {
    it('should count documents', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_count',
        arguments: {
          database: 'test',
          collection: 'users',
        },
      })

      expect(response.isError).toBeUndefined()

      const result = JSON.parse(response.content[0].text!)
      expect(result.count).toBe(4)
    })

    it('should count with filter', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_count',
        arguments: {
          database: 'test',
          collection: 'users',
          filter: { department: 'Engineering' },
        },
      })

      const result = JSON.parse(response.content[0].text!)
      expect(result.count).toBe(2)
    })
  })

  describe('Read-Only Mode Enforcement', () => {
    beforeEach(() => {
      server.setReadOnlyMode(true)
    })

    it('should block insert operations in read-only mode', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_insert_one',
        arguments: {
          database: 'test',
          collection: 'users',
          document: { name: 'Test', age: 25 },
        },
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('read-only mode')
    })

    it('should block update operations in read-only mode', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_update_one',
        arguments: {
          database: 'test',
          collection: 'users',
          filter: { name: 'Alice' },
          update: { $set: { age: 31 } },
        },
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('read-only mode')
    })

    it('should block delete operations in read-only mode', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_delete_one',
        arguments: {
          database: 'test',
          collection: 'users',
          filter: { name: 'Alice' },
        },
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('read-only mode')
    })

    it('should allow find operations in read-only mode', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          database: 'test',
          collection: 'users',
        },
      })

      expect(response.isError).toBeUndefined()
    })

    it('should allow aggregate operations in read-only mode', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_aggregate',
        arguments: {
          database: 'test',
          collection: 'users',
          pipeline: [],
        },
      })

      expect(response.isError).toBeUndefined()
    })
  })

  describe('Write Operations (when read-only disabled)', () => {
    beforeEach(() => {
      server.setReadOnlyMode(false)
    })

    it('should insert a document', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_insert_one',
        arguments: {
          database: 'test',
          collection: 'users',
          document: { name: 'Eve', age: 27, department: 'Sales' },
        },
      })

      expect(response.isError).toBeUndefined()

      const result = JSON.parse(response.content[0].text!)
      expect(result.insertedId).toBeDefined()
    })

    it('should update a document', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_update_one',
        arguments: {
          database: 'test',
          collection: 'users',
          filter: { name: 'Alice' },
          update: { $set: { age: 31 } },
        },
      })

      expect(response.isError).toBeUndefined()

      const result = JSON.parse(response.content[0].text!)
      expect(result.matchedCount).toBe(1)
    })

    it('should delete a document', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_delete_one',
        arguments: {
          database: 'test',
          collection: 'users',
          filter: { name: 'Alice' },
        },
      })

      expect(response.isError).toBeUndefined()

      const result = JSON.parse(response.content[0].text!)
      expect(result.deletedCount).toBe(1)
    })
  })

  describe('Response Format', () => {
    it('should return content array', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          database: 'test',
          collection: 'users',
        },
      })

      expect(Array.isArray(response.content)).toBe(true)
    })

    it('should include text type in content', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          database: 'test',
          collection: 'users',
        },
      })

      expect(response.content[0].type).toBe('text')
      expect(response.content[0].text).toBeDefined()
    })

    it('should return valid JSON in text field', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          database: 'test',
          collection: 'users',
        },
      })

      expect(() => JSON.parse(response.content[0].text!)).not.toThrow()
    })
  })

  describe('Error Handling', () => {
    it('should return error for unknown tool', async () => {
      const response = await server.toolsCall({
        name: 'unknown_tool',
        arguments: {},
      })

      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('Unknown tool')
    })

    it('should handle missing required parameters', async () => {
      const response = await server.toolsCall({
        name: 'mongodb_find',
        arguments: {
          // Missing required 'database' and 'collection'
        },
      })

      expect(response.isError).toBe(true)
    })
  })
})
