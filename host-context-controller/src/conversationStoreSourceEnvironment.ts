import type * as k8s from '@kubernetes/client-node'

/** Startup inputs must come from the image ABI and explicit controller bindings. */
const UNSAFE_STARTUP_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'ENV',
  'BASH_ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'PYTHONPATH',
  'PYTHONHOME',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'GLIBC_TUNABLES',
  'PUID',
  'PGID',
])
const BINDING_NAMES = new Set([
  'CLERUM_HOST_NAME',
  'CLERUM_HOST_UID',
  'CLERUM_PVC_UID',
  'CLERUM_NAMESPACE',
  'CLERUM_WORKSPACE_PATH',
  'CLERUM_MEMORY_WORKSPACE_PATH',
  'CLERUM_SESSION_STORE',
  'CLERUM_SESSION_DB_DIR',
  'CLERUM_SESSION_DB_PATH',
  'CLERUM_DB_BARRIER_FULL',
  'CLERUM_CANONICAL_STORE_CONTRACT',
  'CLERUM_CANONICAL_STORE_REQUIRED',
  'CLERUM_CANONICAL_STATE_DIR',
  'CLERUM_CANONICAL_POD_UID',
  'CLERUM_STATELESS_LIFECYCLE',
  'CLERUM_POD_UID',
])

/**
 * Freeze admitted key names while preserving mutable values via key references.
 * New keys in a mutable envFrom source can no longer alter the process loader.
 * This applies only after the verified preparation gate admits a new template;
 * an existing unprepared Pod retains its entire applied template.
 */
export function projectConversationStoreSourceEnvironment(
  configMap: k8s.V1ConfigMap,
  expectedName: string
): k8s.V1EnvVar[] {
  if (
    !configMap.metadata?.uid ||
    !configMap.metadata.resourceVersion ||
    configMap.metadata.name !== expectedName ||
    configMap.metadata.deletionTimestamp
  )
    throw new Error('SourceEnvironmentUnverified')
  const names = Object.keys(configMap.data ?? {}).sort()
  for (const name of names) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      UNSAFE_STARTUP_NAMES.has(name) ||
      /^(?:LD_|DYLD_|S6_|LSIO_)/.test(name)
    )
      throw new Error('SourceEnvironmentUnsafe')
  }
  return names
    .filter(name => !BINDING_NAMES.has(name))
    .map(name => ({ name, valueFrom: { configMapKeyRef: { name: expectedName, key: name } } }))
}
