/**
 * Airtable MCP Server - API Mock Tests
 *
 * Tests for mocking Airtable API interactions during testing.
 * These tests validate that we can properly mock Airtable API calls
 * without needing real Airtable credentials or API access.
 *
 * Covers:
 * - Airtable client mock
 * - API response mocking
 * - Error handling simulation
 * - Rate limiting behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// Types
// =============================================================================

interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, any>;
}

interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

interface AirtableError {
  type: string;
  message: string;
}

// =============================================================================
// Mock Airtable Client
// =============================================================================

class MockAirtableClient {
  private baseUrl = 'https://api.airtable.com/v0';
  private mockData: Map<string, AirtableRecord[]> = new Map();
  private mockErrors: Map<string, AirtableError> = new Map();
  private rateLimitUntil: number | null = null;

  /**
   * Set mock data for a table
   */
  setMockData(baseId: string, tableId: string, records: AirtableRecord[]) {
    const key = `${baseId}/${tableId}`;
    this.mockData.set(key, records);
  }

  /**
   * Set mock error for an operation
   */
  setMockError(baseId: string, tableId: string, error: AirtableError) {
    const key = `${baseId}/${tableId}`;
    this.mockErrors.set(key, error);
  }

  /**
   * Simulate rate limiting
   */
  setRateLimit(durationMs: number) {
    this.rateLimitUntil = Date.now() + durationMs;
  }

  /**
   * Clear all mocks
   */
  clearMocks() {
    this.mockData.clear();
    this.mockErrors.clear();
    this.rateLimitUntil = null;
  }

  /**
   * Mock list records operation
   */
  async listRecords(
    baseId: string,
    tableId: string,
    options?: { offset?: string; limit?: number }
  ): Promise<AirtableListResponse> {
    this.checkRateLimit();

    const key = `${baseId}/${tableId}`;

    // Check for mock error
    const error = this.mockErrors.get(key);
    if (error) {
      throw new Error(`Airtable API Error: ${error.type} - ${error.message}`);
    }

    // Get mock data
    let records = this.mockData.get(key) || [];

    // Apply pagination
    if (options?.limit) {
      records = records.slice(0, options.limit);
    }

    return {
      records,
      offset: records.length > 0 ? 'mock-offset' : undefined,
    };
  }

  /**
   * Mock get record operation
   */
  async getRecord(
    baseId: string,
    tableId: string,
    recordId: string
  ): Promise<AirtableRecord> {
    this.checkRateLimit();

    const key = `${baseId}/${tableId}`;
    const records = this.mockData.get(key) || [];

    const record = records.find(r => r.id === recordId);
    if (!record) {
      throw new Error('NOT_FOUND: Record not found');
    }

    return record;
  }

  /**
   * Mock create record operation
   */
  async createRecord(
    baseId: string,
    tableId: string,
    fields: Record<string, any>
  ): Promise<AirtableRecord> {
    this.checkRateLimit();

    const key = `${baseId}/${tableId}`;
    const records = this.mockData.get(key) || [];

    const newRecord: AirtableRecord = {
      id: `rec${Date.now()}`,
      createdTime: new Date().toISOString(),
      fields,
    };

    records.push(newRecord);
    this.mockData.set(key, records);

    return newRecord;
  }

  /**
   * Mock update record operation
   */
  async updateRecord(
    baseId: string,
    tableId: string,
    recordId: string,
    fields: Record<string, any>
  ): Promise<AirtableRecord> {
    this.checkRateLimit();

    const key = `${baseId}/${tableId}`;
    const records = this.mockData.get(key) || [];

    const index = records.findIndex(r => r.id === recordId);
    if (index === -1) {
      throw new Error('NOT_FOUND: Record not found');
    }

    records[index].fields = { ...records[index].fields, ...fields };
    return records[index];
  }

  /**
   * Mock delete record operation
   */
  async deleteRecord(
    baseId: string,
    tableId: string,
    recordId: string
  ): Promise<{ id: string; deleted: boolean }> {
    this.checkRateLimit();

    const key = `${baseId}/${tableId}`;
    const records = this.mockData.get(key) || [];

    const index = records.findIndex(r => r.id === recordId);
    if (index === -1) {
      throw new Error('NOT_FOUND: Record not found');
    }

    records.splice(index, 1);
    this.mockData.set(key, records);

    return { id: recordId, deleted: true };
  }

  /**
   * Check if rate limited
   */
  private checkRateLimit() {
    if (this.rateLimitUntil && Date.now() < this.rateLimitUntil) {
      throw new Error('RATE_LIMITED: Too many requests');
    }
    this.rateLimitUntil = null;
  }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Airtable API Mock', () => {
  let client: MockAirtableClient;

  beforeEach(() => {
    client = new MockAirtableClient();
  });

  afterEach(() => {
    client.clearMocks();
  });

  describe('Mock Data Setup', () => {
    it('should set mock data for a table', () => {
      const records: AirtableRecord[] = [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'Test', Value: 100 },
        },
      ];

      client.setMockData('appBase123', 'tblTable1', records);

      // Verify by calling listRecords
      const result = client.listRecords('appBase123', 'tblTable1');
      expect(result).resolves.toHaveProperty('records');
    });

    it('should set mock error for operations', async () => {
      const error: AirtableError = {
        type: 'AUTHENTICATION_REQUIRED',
        message: 'Invalid API key',
      };

      client.setMockError('appBase123', 'tblTable1', error);

      await expect(
        client.listRecords('appBase123', 'tblTable1')
      ).rejects.toThrow('AUTHENTICATION_REQUIRED');
    });

    it('should clear all mocks', () => {
      const records: AirtableRecord[] = [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'Test' },
        },
      ];

      client.setMockData('appBase123', 'tblTable1', records);
      client.clearMocks();

      // After clearing, should return empty array
      const result = client.listRecords('appBase123', 'tblTable1');
      expect(result).resolves.toEqual({ records: [] });
    });
  });

  describe('List Records', () => {
    beforeEach(() => {
      const records: AirtableRecord[] = [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'Alice', Age: 30 },
        },
        {
          id: 'rec2',
          createdTime: '2024-01-02T00:00:00.000Z',
          fields: { Name: 'Bob', Age: 25 },
        },
        {
          id: 'rec3',
          createdTime: '2024-01-03T00:00:00.000Z',
          fields: { Name: 'Charlie', Age: 35 },
        },
      ];

      client.setMockData('appBase123', 'tblUsers', records);
    });

    it('should list all records', async () => {
      const result = await client.listRecords('appBase123', 'tblUsers');

      expect(result.records).toHaveLength(3);
      expect(result.records[0].fields.Name).toBe('Alice');
      expect(result.records[1].fields.Name).toBe('Bob');
      expect(result.records[2].fields.Name).toBe('Charlie');
    });

    it('should respect limit parameter', async () => {
      const result = await client.listRecords('appBase123', 'tblUsers', {
        limit: 2,
      });

      expect(result.records).toHaveLength(2);
      expect(result.records[0].fields.Name).toBe('Alice');
      expect(result.records[1].fields.Name).toBe('Bob');
    });

    it('should return empty array for non-existent table', async () => {
      const result = await client.listRecords('appBase123', 'tblNonExistent');

      expect(result.records).toEqual([]);
    });

    it('should include offset in response', async () => {
      const result = await client.listRecords('appBase123', 'tblUsers');

      expect(result.offset).toBeDefined();
      expect(result.offset).toBe('mock-offset');
    });
  });

  describe('Get Record', () => {
    beforeEach(() => {
      const records: AirtableRecord[] = [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'Alice', Age: 30 },
        },
      ];

      client.setMockData('appBase123', 'tblUsers', records);
    });

    it('should get a specific record', async () => {
      const record = await client.getRecord('appBase123', 'tblUsers', 'rec1');

      expect(record.id).toBe('rec1');
      expect(record.fields.Name).toBe('Alice');
      expect(record.fields.Age).toBe(30);
    });

    it('should throw error for non-existent record', async () => {
      await expect(
        client.getRecord('appBase123', 'tblUsers', 'recNonExistent')
      ).rejects.toThrow('NOT_FOUND');
    });
  });

  describe('Create Record', () => {
    it('should create a new record', async () => {
      const fields = { Name: 'David', Age: 28 };

      const record = await client.createRecord('appBase123', 'tblUsers', fields);

      expect(record.id).toMatch(/^rec\d+$/);
      expect(record.createdTime).toBeDefined();
      expect(record.fields.Name).toBe('David');
      expect(record.fields.Age).toBe(28);
    });

    it('should add record to mock data', async () => {
      await client.createRecord('appBase123', 'tblUsers', { Name: 'Eve' });

      const result = await client.listRecords('appBase123', 'tblUsers');
      expect(result.records).toHaveLength(1);
      expect(result.records[0].fields.Name).toBe('Eve');
    });
  });

  describe('Update Record', () => {
    beforeEach(() => {
      const records: AirtableRecord[] = [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'Alice', Age: 30 },
        },
      ];

      client.setMockData('appBase123', 'tblUsers', records);
    });

    it('should update an existing record', async () => {
      const updated = await client.updateRecord(
        'appBase123',
        'tblUsers',
        'rec1',
        { Age: 31 }
      );

      expect(updated.fields.Age).toBe(31);
      expect(updated.fields.Name).toBe('Alice'); // Unchanged
    });

    it('should merge fields on update', async () => {
      await client.updateRecord('appBase123', 'tblUsers', 'rec1', {
        City: 'NYC',
      });

      const record = await client.getRecord('appBase123', 'tblUsers', 'rec1');
      expect(record.fields.Name).toBe('Alice');
      expect(record.fields.Age).toBe(30);
      expect(record.fields.City).toBe('NYC');
    });

    it('should throw error for non-existent record', async () => {
      await expect(
        client.updateRecord('appBase123', 'tblUsers', 'recNonExistent', {
          Name: 'Test',
        })
      ).rejects.toThrow('NOT_FOUND');
    });
  });

  describe('Delete Record', () => {
    beforeEach(() => {
      const records: AirtableRecord[] = [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'Alice' },
        },
        {
          id: 'rec2',
          createdTime: '2024-01-02T00:00:00.000Z',
          fields: { Name: 'Bob' },
        },
      ];

      client.setMockData('appBase123', 'tblUsers', records);
    });

    it('should delete a record', async () => {
      const result = await client.deleteRecord(
        'appBase123',
        'tblUsers',
        'rec1'
      );

      expect(result.id).toBe('rec1');
      expect(result.deleted).toBe(true);
    });

    it('should remove record from mock data', async () => {
      await client.deleteRecord('appBase123', 'tblUsers', 'rec1');

      const listResult = await client.listRecords('appBase123', 'tblUsers');
      expect(listResult.records).toHaveLength(1);
      expect(listResult.records[0].id).toBe('rec2');
    });

    it('should throw error for non-existent record', async () => {
      await expect(
        client.deleteRecord('appBase123', 'tblUsers', 'recNonExistent')
      ).rejects.toThrow('NOT_FOUND');
    });
  });

  describe('Rate Limiting', () => {
    it('should throw rate limit error when rate limited', async () => {
      client.setRateLimit(1000);

      await expect(
        client.listRecords('appBase123', 'tblUsers')
      ).rejects.toThrow('RATE_LIMITED');
    });

    it('should allow requests after rate limit expires', async () => {
      client.setRateLimit(10); // 10ms rate limit

      await expect(
        client.listRecords('appBase123', 'tblUsers')
      ).rejects.toThrow('RATE_LIMITED');

      // Wait for rate limit to expire
      await new Promise(resolve => setTimeout(resolve, 15));

      // Should work now
      await expect(
        client.listRecords('appBase123', 'tblUsers')
      ).resolves.toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should return authentication error', async () => {
      client.setMockError('appBase123', 'tblUsers', {
        type: 'AUTHENTICATION_REQUIRED',
        message: 'Invalid API key',
      });

      await expect(
        client.listRecords('appBase123', 'tblUsers')
      ).rejects.toThrow('AUTHENTICATION_REQUIRED');
    });

    it('should return permission error', async () => {
      client.setMockError('appBase123', 'tblUsers', {
        type: 'PERMISSION_DENIED',
        message: 'You do not have access',
      });

      await expect(
        client.listRecords('appBase123', 'tblUsers')
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    it('should return not found error', async () => {
      client.setMockError('appBase123', 'tblUsers', {
        type: 'NOT_FOUND',
        message: 'Table not found',
      });

      await expect(
        client.listRecords('appBase123', 'tblUsers')
      ).rejects.toThrow('NOT_FOUND');
    });
  });
});

// =============================================================================
// Vitest Mock Utilities
// =============================================================================

/**
 * Factory function to create a mock Airtable client for tests
 */
export function createMockAirtableClient(): MockAirtableClient {
  return new MockAirtableClient();
}

/**
 * Setup function to configure mock data for common test scenarios
 */
export function setupMockAirtableData(
  client: MockAirtableClient,
  scenario: 'empty' | 'single' | 'multiple'
) {
  switch (scenario) {
    case 'empty':
      client.setMockData('appBase123', 'tblTest', []);
      break;

    case 'single':
      client.setMockData('appBase123', 'tblTest', [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'Test Record' },
        },
      ]);
      break;

    case 'multiple':
      client.setMockData('appBase123', 'tblTest', [
        {
          id: 'rec1',
          createdTime: '2024-01-01T00:00:00.000Z',
          fields: { Name: 'First' },
        },
        {
          id: 'rec2',
          createdTime: '2024-01-02T00:00:00.000Z',
          fields: { Name: 'Second' },
        },
        {
          id: 'rec3',
          createdTime: '2024-01-03T00:00:00.000Z',
          fields: { Name: 'Third' },
        },
      ]);
      break;
  }
}
