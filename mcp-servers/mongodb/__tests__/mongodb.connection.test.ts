/**
 * MongoDB MCP Server - Connection Mock Tests
 *
 * Tests for mocking MongoDB connection and operations during testing.
 * These tests validate that we can properly mock MongoDB interactions
 * without needing real MongoDB instances or connection strings.
 *
 * Covers:
 * - MongoDB connection mock
 * - Query operations (find, aggregate)
 * - Write operations (insert, update, delete)
 * - Connection pooling simulation
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Types
// =============================================================================

interface MongoDocument {
  _id: string;
  [key: string]: any;
}

interface MongoQuery {
  filter?: Record<string, any>;
  projection?: Record<string, number | boolean | object>;
  sort?: Record<string, number>;
  limit?: number;
  skip?: number;
}

interface MongoAggregatePipeline {
  $match?: Record<string, any>;
  $group?: Record<string, any>;
  $project?: Record<string, any>;
  $sort?: Record<string, number>;
  $limit?: number;
}

interface MongoError {
  code: number;
  message: string;
}

// =============================================================================
// Mock MongoDB Client
// =============================================================================

class MockMongoClient {
  private isConnected: boolean = false;
  private collections: Map<string, MongoDocument[]> = new Map();
  private mockErrors: Map<string, MongoError> = new Map();
  private queryLog: Array<{ operation: string; collection: string; query: any }> =
    [];

  /**
   * Simulate connecting to MongoDB
   */
  async connect(connectionString: string): Promise<void> {
    // Simulate connection delay
    await new Promise(resolve => setTimeout(resolve, 10));

    if (!connectionString || !connectionString.startsWith('mongodb')) {
      throw new Error('Invalid connection string format');
    }

    this.isConnected = true;
  }

  /**
   * Simulate disconnecting from MongoDB
   */
  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  /**
   * Check if connected
   */
  connected(): boolean {
    return this.isConnected;
  }

  /**
   * Set mock data for a collection
   */
  setCollectionData(collectionName: string, documents: MongoDocument[]): void {
    this.collections.set(collectionName, documents);
  }

  /**
   * Set mock error for an operation
   */
  setMockError(collectionName: string, error: MongoError): void {
    this.mockErrors.set(collectionName, error);
  }

  /**
   * Clear all mocks and logs
   */
  clearMocks(): void {
    this.collections.clear();
    this.mockErrors.clear();
    this.queryLog = [];
  }

  /**
   * Get query log
   */
  getQueryLog(): Array<{ operation: string; collection: string; query: any }> {
    return [...this.queryLog];
  }

  /**
   * Mock find operation
   */
  async find(collectionName: string, query: MongoQuery): Promise<MongoDocument[]> {
    this.checkConnected();
    this.logQuery('find', collectionName, query);

    this.checkError(collectionName);

    let documents = this.collections.get(collectionName) || [];

    // Apply filter
    if (query.filter) {
      documents = this.applyFilter(documents, query.filter);
    }

    // Apply sort
    if (query.sort) {
      documents = this.applySort(documents, query.sort);
    }

    // Apply skip
    if (query.skip) {
      documents = documents.slice(query.skip);
    }

    // Apply limit
    if (query.limit) {
      documents = documents.slice(0, query.limit);
    }

    // Apply projection
    if (query.projection) {
      documents = this.applyProjection(documents, query.projection);
    }

    return documents;
  }

  /**
   * Mock aggregate operation
   */
  async aggregate(
    collectionName: string,
    pipeline: MongoAggregatePipeline[]
  ): Promise<any[]> {
    this.checkConnected();
    this.logQuery('aggregate', collectionName, pipeline);

    this.checkError(collectionName);

    let documents = this.collections.get(collectionName) || [];

    // Apply pipeline stages
    for (const stage of pipeline) {
      if (stage.$match) {
        documents = this.applyFilter(documents, stage.$match);
      }
      if (stage.$group) {
        documents = this.applyGroup(documents, stage.$group);
      }
      if (stage.$project) {
        documents = this.applyProjection(documents, stage.$project);
      }
      if (stage.$sort) {
        documents = this.applySort(documents, stage.$sort);
      }
      if (stage.$limit) {
        documents = documents.slice(0, stage.$limit);
      }
    }

    return documents;
  }

  /**
   * Mock insert operation
   */
  async insertOne(collectionName: string, document: any): Promise<{ insertedId: string }> {
    this.checkConnected();
    this.logQuery('insertOne', collectionName, document);

    this.checkError(collectionName);

    const newDocument: MongoDocument = {
      _id: this.generateId(),
      ...document,
    };

    const collection = this.collections.get(collectionName) || [];
    collection.push(newDocument);
    this.collections.set(collectionName, collection);

    return { insertedId: newDocument._id };
  }

  /**
   * Mock update operation
   */
  async updateOne(
    collectionName: string,
    filter: Record<string, any>,
    update: Record<string, any>
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    this.checkConnected();
    this.logQuery('updateOne', collectionName, { filter, update });

    this.checkError(collectionName);

    const collection = this.collections.get(collectionName) || [];
    const index = collection.findIndex(doc => this.matchesFilter(doc, filter));

    if (index === -1) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    // Apply $set operations
    if (update.$set) {
      collection[index] = { ...collection[index], ...update.$set };
    }

    return { matchedCount: 1, modifiedCount: 1 };
  }

  /**
   * Mock delete operation
   */
  async deleteOne(
    collectionName: string,
    filter: Record<string, any>
  ): Promise<{ deletedCount: number }> {
    this.checkConnected();
    this.logQuery('deleteOne', collectionName, filter);

    this.checkError(collectionName);

    const collection = this.collections.get(collectionName) || [];
    const index = collection.findIndex(doc => this.matchesFilter(doc, filter));

    if (index === -1) {
      return { deletedCount: 0 };
    }

    collection.splice(index, 1);
    this.collections.set(collectionName, collection);

    return { deletedCount: 1 };
  }

  /**
   * Mock count operation
   */
  async count(collectionName: string, filter?: Record<string, any>): Promise<number> {
    this.checkConnected();
    this.logQuery('count', collectionName, { filter });

    this.checkError(collectionName);

    let documents = this.collections.get(collectionName) || [];

    if (filter) {
      documents = this.applyFilter(documents, filter);
    }

    return documents.length;
  }

  // =============================================================================
  // Helper Methods
  // =============================================================================

  private checkConnected(): void {
    if (!this.isConnected) {
      throw new Error('MongoNotConnectedError: Client is not connected');
    }
  }

  private checkError(collectionName: string): void {
    const error = this.mockErrors.get(collectionName);
    if (error) {
      throw new Error(`MongoError: ${error.code} - ${error.message}`);
    }
  }

  private logQuery(operation: string, collection: string, query: any): void {
    this.queryLog.push({ operation, collection, query });
  }

  private applyFilter(documents: MongoDocument[], filter: Record<string, any>): MongoDocument[] {
    return documents.filter(doc => this.matchesFilter(doc, filter));
  }

  private matchesFilter(doc: MongoDocument, filter: Record<string, any>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      const docValue = doc[key];

      if (value === null) {
        if (docValue !== null) return false;
      } else if (typeof value === 'object' && value !== null) {
        // MongoDB query operators
        if (value.$regex) {
          // Regex match
          const regex = new RegExp(value.$regex, value.$options || '');
          if (!regex.test(docValue)) return false;
        } else if (value.$in) {
          // $in operator
          if (!value.$in.includes(docValue)) return false;
        } else if (value.$gte !== undefined) {
          // $gte (greater than or equal)
          if (!(docValue >= value.$gte)) return false;
        } else if (value.$gt !== undefined) {
          // $gt (greater than)
          if (!(docValue > value.$gt)) return false;
        } else if (value.$lte !== undefined) {
          // $lte (less than or equal)
          if (!(docValue <= value.$lte)) return false;
        } else if (value.$lt !== undefined) {
          // $lt (less than)
          if (!(docValue < value.$lt)) return false;
        } else if (value.$ne !== undefined) {
          // $ne (not equal)
          if (docValue === value.$ne) return false;
        } else {
          // Nested object
          return false;
        }
      } else if (value !== docValue) {
        return false;
      }
    }
    return true;
  }

  private applySort(documents: MongoDocument[], sort: Record<string, number>): MongoDocument[] {
    return [...documents].sort((a, b) => {
      for (const [key, direction] of Object.entries(sort)) {
        const aVal = a[key];
        const bVal = b[key];

        // direction: 1 = ascending, -1 = descending
        if (aVal < bVal) return direction === 1 ? -1 : 1;
        if (aVal > bVal) return direction === 1 ? 1 : -1;
      }
      return 0;
    });
  }

  private applyProjection(
    documents: MongoDocument[],
    projection: Record<string, number | boolean | object>
  ): MongoDocument[] {
    return documents.map(doc => {
      const projected: any = { _id: doc._id };

      for (const [key, value] of Object.entries(projection)) {
        if (value === 1 || value === true) {
          projected[key] = doc[key];
        } else if (value === 0 || value === false) {
          // Exclude field (already not in projected object)
        }
      }

      return projected;
    });
  }

  private applyGroup(documents: MongoDocument[], group: Record<string, any>): any[] {
    // Simplified $group implementation
    const groups: Map<string, any> = new Map();

    for (const doc of documents) {
      // Calculate group key based on _id field
      let groupKey: string;
      if (typeof group._id === 'string' && group._id.startsWith('$')) {
        // _id is a field reference like '$city'
        const fieldName = group._id.substring(1);
        groupKey = String(doc[fieldName] || 'null');
      } else {
        // _id is a literal value or expression
        groupKey = JSON.stringify(group._id);
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          _id: groupKey === 'null' ? group._id : (group._id.startsWith?.('$') ? doc[group._id.substring(1)] : groupKey),
        });
      }

      const groupDoc = groups.get(groupKey)!;

      // Handle $sum, $avg, etc.
      for (const [key, value] of Object.entries(group)) {
        if (key === '_id') continue;

        if (typeof value === 'object' && value.$sum !== undefined) {
          if (!groupDoc[key]) groupDoc[key] = 0;

          if (typeof value.$sum === 'number') {
            // $sum: 1 means count documents
            groupDoc[key] += value.$sum;
          } else if (typeof value.$sum === 'string' && value.$sum.startsWith('$')) {
            // $sum: '$fieldName' means sum the field values
            const fieldName = value.$sum.substring(1);
            groupDoc[key] += doc[fieldName] || 0;
          }
        }
      }
    }

    return Array.from(groups.values());
  }

  private generateId(): string {
    return `ObjectId(${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)})`;
  }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('MongoDB Connection Mock', () => {
  let client: MockMongoClient;

  beforeEach(() => {
    client = new MockMongoClient();
  });

  afterEach(() => {
    client.clearMocks();
  });

  describe('Connection Management', () => {
    it('should connect successfully with valid connection string', async () => {
      await client.connect('mongodb://localhost:27017/test');

      expect(client.connected()).toBe(true);
    });

    it('should connect with mongodb+srv:// connection string', async () => {
      await client.connect(
        'mongodb+srv://user:pass@cluster.mongodb.net/test'
      );

      expect(client.connected()).toBe(true);
    });

    it('should reject invalid connection string', async () => {
      await expect(
        client.connect('invalid://connection-string')
      ).rejects.toThrow('Invalid connection string format');
    });

    it('should reject empty connection string', async () => {
      await expect(client.connect('')).rejects.toThrow(
        'Invalid connection string format'
      );
    });

    it('should disconnect successfully', async () => {
      await client.connect('mongodb://localhost:27017/test');
      await client.disconnect();

      expect(client.connected()).toBe(false);
    });

    it('should not allow operations when disconnected', async () => {
      await expect(
        client.find('test', {})
      ).rejects.toThrow('MongoNotConnectedError');
    });
  });

  describe('Collection Data Management', () => {
    beforeEach(async () => {
      await client.connect('mongodb://localhost:27017/test');
    });

    it('should set collection data', async () => {
      const documents = [
        { _id: '1', name: 'Alice', age: 30 },
        { _id: '2', name: 'Bob', age: 25 },
      ];

      client.setCollectionData('users', documents);

      const result = await client.find('users', {});
      expect(result).toHaveLength(2);
    });

    it('should clear all mocks', async () => {
      client.setCollectionData('users', [{ _id: '1', name: 'Alice' }]);
      client.setMockError('users', { code: 1, message: 'Test error' });

      client.clearMocks();

      const result = await client.find('users', {});
      expect(result).toHaveLength(0);
    });
  });

  describe('Query Logging', () => {
    beforeEach(async () => {
      await client.connect('mongodb://localhost:27017/test');
      client.setCollectionData('users', [
        { _id: '1', name: 'Alice' },
        { _id: '2', name: 'Bob' },
      ]);
    });

    it('should log find queries', async () => {
      await client.find('users', { filter: { name: 'Alice' } });

      const log = client.getQueryLog();
      expect(log).toHaveLength(1);
      expect(log[0].operation).toBe('find');
      expect(log[0].collection).toBe('users');
    });

    it('should log multiple queries', async () => {
      await client.find('users', { filter: { name: 'Alice' } });
      await client.count('users');
      await client.insertOne('users', { name: 'Charlie' });

      const log = client.getQueryLog();
      expect(log).toHaveLength(3);
    });

    it('should clear log on clearMocks', async () => {
      await client.find('users', {});
      client.clearMocks();

      const log = client.getQueryLog();
      expect(log).toHaveLength(0);
    });
  });
});

describe('MongoDB Query Operations', () => {
  let client: MockMongoClient;

  beforeEach(async () => {
    client = new MockMongoClient();
    await client.connect('mongodb://localhost:27017/test');

    const documents = [
      { _id: '1', name: 'Alice', age: 30, city: 'NYC', status: 'active' },
      { _id: '2', name: 'Bob', age: 25, city: 'LA', status: 'active' },
      { _id: '3', name: 'Charlie', age: 35, city: 'NYC', status: 'inactive' },
      { _id: '4', name: 'David', age: 28, city: 'SF', status: 'active' },
    ];

    client.setCollectionData('users', documents);
  });

  describe('Find Operations', () => {
    it('should find all documents', async () => {
      const result = await client.find('users', {});

      expect(result).toHaveLength(4);
    });

    it('should filter documents', async () => {
      const result = await client.find('users', {
        filter: { city: 'NYC' },
      });

      expect(result).toHaveLength(2);
      expect(result.every(doc => doc.city === 'NYC')).toBe(true);
    });

    it('should sort documents', async () => {
      const result = await client.find('users', {
        sort: { age: 1 },
      });

      expect(result[0].age).toBe(25); // Bob
      expect(result[3].age).toBe(35); // Charlie
    });

    it('should limit results', async () => {
      const result = await client.find('users', {
        limit: 2,
      });

      expect(result).toHaveLength(2);
    });

    it('should skip results', async () => {
      const result = await client.find('users', {
        skip: 2,
        limit: 2,
      });

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Charlie');
    });

    it('should project fields', async () => {
      const result = await client.find('users', {
        projection: { name: 1, age: 1 },
      });

      expect(result[0]).toHaveProperty('_id');
      expect(result[0]).toHaveProperty('name');
      expect(result[0]).toHaveProperty('age');
      expect(result[0]).not.toHaveProperty('city');
    });

    it('should support regex filter', async () => {
      const result = await client.find('users', {
        filter: { name: { $regex: /^A/i } },
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Alice');
    });

    it('should support $in operator', async () => {
      const result = await client.find('users', {
        filter: { city: { $in: ['NYC', 'LA'] } },
      });

      expect(result).toHaveLength(3);
    });
  });

  describe('Aggregate Operations', () => {
    it('should support $match stage', async () => {
      const pipeline = [{ $match: { status: 'active' } }];

      const result = await client.aggregate('users', pipeline);

      expect(result).toHaveLength(3);
    });

    it('should support $group stage', async () => {
      const pipeline = [
        {
          $group: {
            _id: '$city',
            count: { $sum: 1 },
          },
        },
      ];

      const result = await client.aggregate('users', pipeline);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('_id');
      expect(result[0]).toHaveProperty('count');
    });

    it('should support $sort stage', async () => {
      const pipeline = [{ $sort: { age: -1 } }];

      const result = await client.aggregate('users', pipeline);

      expect(result[0].age).toBe(35);
    });

    it('should support $limit stage', async () => {
      const pipeline = [{ $limit: 2 }];

      const result = await client.aggregate('users', pipeline);

      expect(result).toHaveLength(2);
    });

    it('should support multi-stage pipeline', async () => {
      const pipeline = [
        { $match: { status: 'active' } },
        { $sort: { age: 1 } },
        { $limit: 2 },
      ];

      const result = await client.aggregate('users', pipeline);

      expect(result).toHaveLength(2);
      expect(result[0].age).toBe(25); // Bob (youngest active)
    });
  });

  describe('Count Operations', () => {
    it('should count all documents', async () => {
      const count = await client.count('users');

      expect(count).toBe(4);
    });

    it('should count with filter', async () => {
      const count = await client.count('users', { city: 'NYC' });

      expect(count).toBe(2);
    });
  });
});

describe('MongoDB Write Operations', () => {
  let client: MockMongoClient;

  beforeEach(async () => {
    client = new MockMongoClient();
    await client.connect('mongodb://localhost:27017/test');
  });

  describe('Insert Operations', () => {
    it('should insert a document', async () => {
      const result = await client.insertOne('users', {
        name: 'Eve',
        age: 27,
      });

      expect(result.insertedId).toBeDefined();
      expect(result.insertedId).toMatch(/^ObjectId\(/);
    });

    it('should add document to collection', async () => {
      await client.insertOne('users', { name: 'Frank' });

      const documents = await client.find('users', {});
      expect(documents).toHaveLength(1);
    });
  });

  describe('Update Operations', () => {
    beforeEach(async () => {
      await client.insertOne('users', { name: 'Grace', age: 30, city: 'NYC' });
    });

    it('should update a document', async () => {
      const result = await client.updateOne(
        'users',
        { name: 'Grace' },
        { $set: { age: 31 } }
      );

      expect(result.matchedCount).toBe(1);
      expect(result.modifiedCount).toBe(1);
    });

    it('should reflect changes in find', async () => {
      await client.updateOne('users', { name: 'Grace' }, { $set: { age: 31 } });

      const documents = await client.find('users', {});
      expect(documents[0].age).toBe(31);
    });

    it('should return zero matches for non-existent document', async () => {
      const result = await client.updateOne(
        'users',
        { name: 'NonExistent' },
        { $set: { age: 30 } }
      );

      expect(result.matchedCount).toBe(0);
      expect(result.modifiedCount).toBe(0);
    });
  });

  describe('Delete Operations', () => {
    beforeEach(async () => {
      await client.insertOne('users', { name: 'Henry', age: 40 });
    });

    it('should delete a document', async () => {
      const result = await client.deleteOne('users', { name: 'Henry' });

      expect(result.deletedCount).toBe(1);
    });

    it('should remove document from collection', async () => {
      await client.deleteOne('users', { name: 'Henry' });

      const documents = await client.find('users', {});
      expect(documents).toHaveLength(0);
    });

    it('should return zero for non-existent document', async () => {
      const result = await client.deleteOne('users', {
        name: 'NonExistent',
      });

      expect(result.deletedCount).toBe(0);
    });
  });
});

describe('MongoDB Error Handling', () => {
  let client: MockMongoClient;

  beforeEach(async () => {
    client = new MockMongoClient();
    await client.connect('mongodb://localhost:27017/test');
  });

  it('should throw configured error', async () => {
    client.setMockError('users', { code: 11000, message: 'Duplicate key error' });

    await expect(client.find('users', {})).rejects.toThrow('MongoError: 11000');
  });

  it('should allow error clearing', async () => {
    client.setMockError('users', { code: 1, message: 'Test error' });

    await expect(client.find('users', {})).rejects.toThrow();

    client.clearMocks();

    const result = await client.find('users', {});
    expect(result).toHaveLength(0);
  });
});

// =============================================================================
// Vitest Mock Utilities
// =============================================================================

/**
 * Factory function to create a mock MongoDB client for tests
 */
export function createMockMongoClient(): MockMongoClient {
  return new MockMongoClient();
}

/**
 * Setup function to configure mock data for common test scenarios
 */
export function setupMockMongoData(
  client: MockMongoClient,
  scenario: 'empty' | 'single' | 'multiple'
) {
  switch (scenario) {
    case 'empty':
      client.setCollectionData('test', []);
      break;

    case 'single':
      client.setCollectionData('test', [{ _id: '1', name: 'Test Document' }]);
      break;

    case 'multiple':
      client.setCollectionData('test', [
        { _id: '1', name: 'First', value: 100 },
        { _id: '2', name: 'Second', value: 200 },
        { _id: '3', name: 'Third', value: 300 },
      ]);
      break;
  }
}
