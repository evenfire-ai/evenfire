/**
 * Secret Manager for E2E Testing
 *
 * Provides utilities to create, manage, and cleanup Kubernetes secrets
 * for MCP servers during E2E testing. This resolves the gap where
 * secret.yaml files don't exist and create-k8s-secrets.sh requires
 * manual .env configuration.
 *
 * Usage:
 * ```ts
 * import { createTestSecret, verifySecretMounted, cleanupTestSecret } from './secret-manager';
 *
 * // Create secret for MongoDB
 * await createTestSecret('mongodb-server', {
 *   'connection-string': 'mongodb://localhost:27017/test'
 * });
 *
 * // Verify secret is mounted in pod
 * const isMounted = await verifySecretMounted('mongodb-server-pod', 'mcp-mongodb-credentials');
 *
 * // Cleanup after test
 * await cleanupTestSecret('mcp-mongodb-credentials', 'mcp-server');
 * ```
 */

import { execSync } from 'child_process';
import { KubeConfig, CoreV1Api } from '@kubernetes/client-node';

// =============================================================================
// Types
// =============================================================================

export interface SecretCredentials {
  [key: string]: string;
}

export interface TestSecretOptions {
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface SecretMountInfo {
  secretName: string;
  namespace: string;
  envVars: Array<{
    name: string;
    secretKeyRef: {
      name: string;
      key: string;
    };
  }>;
  volumes: Array<{
    name: string;
    secret: {
      secretName: string;
    };
  }>;
}

// =============================================================================
// Kubernetes Client Setup
// =============================================================================

let k8sCoreApi: CoreV1Api | null = null;

function getK8sCoreApi(): CoreV1Api {
  if (!k8sCoreApi) {
    const kc = new KubeConfig();
    kc.loadFromDefault(); // Uses ~/.kube/config or minikube config
    k8sCoreApi = kc.makeApiClient(CoreV1Api);
  }
  return k8sCoreApi;
}

// =============================================================================
// Secret Creation
// =============================================================================

/**
 * Creates a Kubernetes secret for testing purposes.
 *
 * @param serverName - Name of the MCP server (e.g., 'mongodb-server', 'airtable-server')
 * @param credentials - Object containing key-value pairs of credentials
 * @param options - Optional configuration (namespace, labels, annotations)
 *
 * @example
 * ```ts
 * await createTestSecret('mongodb-server', {
 *   'connection-string': 'mongodb://localhost:27017/test'
 * }, { namespace: 'mcp-server' });
 * ```
 */
export async function createTestSecret(
  serverName: string,
  credentials: SecretCredentials,
  options: TestSecretOptions = {}
): Promise<void> {
  const { namespace = 'mcp-server', labels = {}, annotations = {} } = options;

  // Derive secret name from server name
  const secretName = `mcp-${serverName}-credentials`;

  // Create metadata with standard labels
  const metadata: Record<string, any> = {
    name: secretName,
    namespace,
    labels: {
      'app': `mcp-${serverName}`,
      'clerum.io/test': 'true',
      'clerum.io/e2e': 'true',
      ...labels,
    },
    annotations: {
      'clerum.io/generated-by': 'secret-manager.ts',
      ...annotations,
    },
  };

  // Build secret data (values must be base64 encoded)
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    data[key] = Buffer.from(value, 'utf-8').toString('base64');
  }

  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata,
    data,
  };

  try {
    const api = getK8sCoreApi();
    await api.createNamespacedSecret(namespace, secret);
    console.log(`[SecretManager] Created secret: ${secretName} in namespace ${namespace}`);
  } catch (error: any) {
    if (error.statusCode === 409) {
      // Secret already exists - update it
      const api = getK8sCoreApi();
      await api.replaceNamespacedSecret(secretName, namespace, secret);
      console.log(`[SecretManager] Updated secret: ${secretName} in namespace ${namespace}`);
    } else {
      throw new Error(`Failed to create secret ${secretName}: ${error.message}`);
    }
  }
}

/**
 * Creates secrets for multiple MCP servers at once.
 *
 * @param servers - Object mapping server names to their credentials
 * @param options - Optional configuration applied to all secrets
 *
 * @example
 * ```ts
 * await createMultipleSecrets({
 *   'mongodb-server': { 'connection-string': 'mongodb://localhost:27017/test' },
 *   'airtable-server': { 'api-key': 'patXXX.XXX...' }
 * }, { namespace: 'mcp-server' });
 * ```
 */
export async function createMultipleSecrets(
  servers: Record<string, SecretCredentials>,
  options: TestSecretOptions = {}
): Promise<void> {
  const promises = Object.entries(servers).map(([serverName, credentials]) =>
    createTestSecret(serverName, credentials, options)
  );
  await Promise.all(promises);
}

// =============================================================================
// Predefined Test Secrets
// =============================================================================

/**
 * Creates a MongoDB test secret with a local connection string.
 *
 * @param connectionString - Optional custom connection string
 * @param options - Optional configuration
 */
export async function createMongoTestSecret(
  connectionString: string = 'mongodb://localhost:27017/test',
  options: TestSecretOptions = {}
): Promise<void> {
  await createTestSecret('mongodb-server', {
    'connection-string': connectionString,
  }, options);
}

/**
 * Creates an Airtable test secret with a dummy API key.
 *
 * @param apiKey - Optional custom API key (default is a dummy for testing)
 * @param options - Optional configuration
 */
export async function createAirtableTestSecret(
  apiKey: string = 'patDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummy',
  options: TestSecretOptions = {}
): Promise<void> {
  await createTestSecret('airtable-server', {
    'api-key': apiKey,
  }, options);
}

/**
 * Creates all predefined MCP server secrets at once.
 *
 * @param options - Optional configuration applied to all secrets
 */
export async function createAllMcpTestSecrets(
  options: TestSecretOptions = {}
): Promise<void> {
  await Promise.all([
    createMongoTestSecret(undefined, options),
    createAirtableTestSecret(undefined, options),
  ]);
}

// =============================================================================
// Secret Verification
// =============================================================================

/**
 * Verifies that a secret exists in Kubernetes.
 *
 * @param secretName - Name of the secret to verify
 * @param namespace - Namespace where the secret should exist
 *
 * @returns true if secret exists, false otherwise
 */
export async function verifySecretExists(
  secretName: string,
  namespace: string = 'mcp-server'
): Promise<boolean> {
  try {
    const api = getK8sCoreApi();
    await api.readNamespacedSecret(secretName, namespace);
    return true;
  } catch (error: any) {
    if (error.statusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Gets the contents of a secret (decoded from base64).
 *
 * @param secretName - Name of the secret
 * @param namespace - Namespace where the secret exists
 *
 * @returns Object with decoded key-value pairs
 */
export async function getSecretContents(
  secretName: string,
  namespace: string = 'mcp-server'
): Promise<Record<string, string>> {
  const api = getK8sCoreApi();
  const { body } = await api.readNamespacedSecret(secretName, namespace);

  const decoded: Record<string, string> = {};
  if (body.data) {
    for (const [key, value] of Object.entries(body.data)) {
      decoded[key] = Buffer.from(value as string, 'base64').toString('utf-8');
    }
  }

  return decoded;
}

/**
 * Verifies that a secret is properly mounted in a pod.
 *
 * Checks both:
 * 1. Environment variables referencing the secret
 * 2. Volumes mounted from the secret
 *
 * @param podName - Name of the pod to check
 * @param secretName - Name of the secret that should be mounted
 * @param namespace - Namespace where the pod exists
 *
 * @returns Object with mount information
 */
export async function verifySecretMounted(
  podName: string,
  secretName: string,
  namespace: string = 'mcp-server'
): Promise<SecretMountInfo> {
  const api = getK8sCoreApi();
  const { body: pod } = await api.readNamespacedPod(podName, namespace);

  const mountInfo: SecretMountInfo = {
    secretName,
    namespace,
    envVars: [],
    volumes: [],
  };

  // Check containers for envFrom and env secretKeyRef
  const containers = pod.spec?.containers || [];
  for (const container of containers) {
    // Check envFrom
    if (container.envFrom) {
      for (const envFrom of container.envFrom) {
        if (envFrom.secretRef?.name === secretName) {
          mountInfo.envVars.push({
            name: '*',
            secretKeyRef: {
              name: secretName,
              key: '*',
            },
          });
        }
      }
    }

    // Check individual env vars
    if (container.env) {
      for (const env of container.env) {
        if (env.valueFrom?.secretKeyRef?.name === secretName) {
          mountInfo.envVars.push({
            name: env.name,
            secretKeyRef: env.valueFrom.secretKeyRef as any,
          });
        }
      }
    }
  }

  // Check volumes
  const volumes = pod.spec?.volumes || [];
  for (const volume of volumes) {
    if (volume.secret?.secretName === secretName) {
      mountInfo.volumes.push({
        name: volume.name,
        secret: volume.secret as any,
      });
    }
  }

  const isMounted = mountInfo.envVars.length > 0 || mountInfo.volumes.length > 0;

  console.log(`[SecretManager] Secret ${secretName} mount check:`, {
    mounted: isMounted,
    envVars: mountInfo.envVars.length,
    volumes: mountInfo.volumes.length,
  });

  return mountInfo;
}

// =============================================================================
// Secret Cleanup
// =============================================================================

/**
 * Deletes a test secret from Kubernetes.
 *
 * @param secretName - Name of the secret to delete
 * @param namespace - Namespace where the secret exists
 */
export async function cleanupTestSecret(
  secretName: string,
  namespace: string = 'mcp-server'
): Promise<void> {
  try {
    const api = getK8sCoreApi();
    await api.deleteNamespacedSecret(secretName, namespace);
    console.log(`[SecretManager] Deleted secret: ${secretName} from namespace ${namespace}`);
  } catch (error: any) {
    if (error.statusCode !== 404) {
      // Ignore 404 (already deleted), throw other errors
      throw new Error(`Failed to delete secret ${secretName}: ${error.message}`);
    }
  }
}

/**
 * Cleans up all test secrets created by this manager.
 *
 * Deletes all secrets labeled with `clerum.io/test: true`.
 *
 * @param namespace - Namespace to clean up
 */
export async function cleanupAllTestSecrets(
  namespace: string = 'mcp-server'
): Promise<void> {
  const api = getK8sCoreApi();
  const { body } = await api.listNamespacedSecret(
    namespace,
    undefined, // pretty
    undefined, // allowWatchBookmarks
    undefined, // _continue
    undefined, // fieldSelector
    undefined, // labelSelector
    'clerum.io/test=true' // labelSelector to filter test secrets
  );

  const deletePromises = body.items.map(secret =>
    cleanupTestSecret(secret.metadata!.name!, namespace)
  );

  await Promise.all(deletePromises);
  console.log(`[SecretManager] Cleaned up ${deletePromises.length} test secret(s)`);
}

// =============================================================================
// Vitest Integration
// =============================================================================

/**
 * Vitest beforeEach hook to create test secrets.
 *
 * @example
 * ```ts
 * import { beforeEach } from 'vitest';
 * import { createMcpTestSecretsBeforeEach } from './secret-manager';
 *
 * beforeEach(createMcpTestSecretsBeforeEach(['mongodb-server', 'airtable-server']));
 * ```
 */
export function createMcpTestSecretsBeforeEach(
  servers: Array<'mongodb-server' | 'airtable-server'>,
  options: TestSecretOptions = {}
): () => Promise<void> {
  return async () => {
    const secrets: Record<string, SecretCredentials> = {};

    if (servers.includes('mongodb-server')) {
      secrets['mongodb-server'] = {
        'connection-string': process.env.MONGODB_CONNECTION_STRING ||
          'mongodb://localhost:27017/test',
      };
    }

    if (servers.includes('airtable-server')) {
      secrets['airtable-server'] = {
        'api-key': process.env.AIRTABLE_API_KEY ||
          'patDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummy',
      };
    }

    await createMultipleSecrets(secrets, options);
  };
}

/**
 * Vitest afterEach hook to cleanup test secrets.
 *
 * @example
 * ```ts
 * import { afterEach } from 'vitest';
 * import { cleanupMcpTestSecretsAfterEach } from './secret-manager';
 *
 * afterEach(cleanupMcpTestSecretsAfterEach(['mongodb-server', 'airtable-server']));
 * ```
 */
export function cleanupMcpTestSecretsAfterEach(
  servers: Array<'mongodb-server' | 'airtable-server'>,
  namespace: string = 'mcp-server'
): () => Promise<void> {
  return async () => {
    for (const server of servers) {
      const secretName = `mcp-${server}-credentials`;
      await cleanupTestSecret(secretName, namespace);
    }
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Encodes a string value to base64 for use in Kubernetes secrets.
 *
 * @param value - String value to encode
 *
 * @returns Base64-encoded string
 */
export function encodeSecretValue(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * Decodes a base64-encoded secret value.
 *
 * @param encodedValue - Base64-encoded string
 *
 * @returns Decoded string value
 */
export function decodeSecretValue(encodedValue: string): string {
  return Buffer.from(encodedValue, 'base64').toString('utf-8');
}

/**
 * Executes a kubectl command and returns the output.
 *
 * @param args - Arguments to pass to kubectl
 *
 * @returns Command output as string
 */
function kubectl(...args: string[]): string {
  try {
    return execSync(`kubectl ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    throw new Error(`kubectl command failed: ${error.message}`);
  }
}

/**
 * Alternative kubectl-based secret creation (fallback if @kubernetes/client-node fails).
 *
 * @param serverName - Name of the MCP server
 * @param credentials - Object containing key-value pairs
 * @param namespace - Namespace where to create the secret
 */
export function createTestSecretKubectl(
  serverName: string,
  credentials: SecretCredentials,
  namespace: string = 'mcp-server'
): void {
  const secretName = `mcp-${serverName}-credentials`;

  // Build --from-literal arguments
  const literalArgs = Object.entries(credentials)
    .map(([key, value]) => `--from-literal=${key}=${value}`)
    .join(' ');

  const command = [
    'create', 'secret', 'generic', secretName,
    `--namespace=${namespace}`,
    literalArgs,
    '--dry-run=client',
    '-o', 'yaml',
    '|',
    'kubectl', 'apply', '-f', '-',
  ].join(' ');

  kubectl(command);
  console.log(`[SecretManager] Created secret via kubectl: ${secretName}`);
}
