export const projectRoots = [
  'channel-reader',
  'control-api',
  'control-ui',
  'desktop-app',
  'external-rest-api',
  'host-context-controller',
  'mcp-host',
  'mcp-proxy',
  'mcp-servers',
  'packages/desktop-app-links',
  'packages/workflow-sdk',
  'profile-ui',
  'rpc-proxy',
  'stdio-bridge',
  'tests/e2e',
  'workflow-recipes',
]

export const packageRoots = [
  'channel-reader',
  'control-api',
  'control-ui',
  'external-rest-api',
  'host-context-controller',
  'mcp-host',
  'mcp-proxy',
  'mcp-servers',
  'mcp-servers/doc-generator',
  'mcp-servers/web-search',
  'packages/workflow-sdk',
  'profile-ui',
  'rpc-proxy',
  'stdio-bridge',
  'tests/e2e',
  'tests/e2e/fixtures',
  'tests/e2e/fixtures/mock-mcp-server',
  'tests/e2e/fixtures/mock-secrets-server',
  'tests/e2e/fixtures/mock-stdio-mcp-server',
  'tests/e2e/playwright',
  'workflow-recipes',
  'workflow-recipes/tests/e2e',
]

export const rootFormatTargets = [
  'commitlint.config.cjs',
  'package.json',
  'prettier.config.cjs',
  '.prettierignore',
  'scripts/precommit',
  'scripts/prettier',
]

// CI intentionally has a wider allowlist than the local staged and repository-wide
// formatters above. It checks only files in the incoming Git diff, so adding active
// build roots here does not make `npm run format` traverse legacy formatting debt.
export const ciProjectRoots = [
  ...projectRoots,
  'gfs-controller',
  'nginx-egress-proxy',
  'packages/image-policy',
  'packages/llm-providers',
  'packages/network-policy-core',
  'packages/workflow-recipe-capability-policy',
  'packages/workflow-runtime-core',
  'webhook-gateway',
  'webhook-proxy',
  'workflow-approval-request-reader',
  'workspace-files-controller',
]

export const ciRootFormatTargets = [...rootFormatTargets, '.github/workflows', 'scripts']

// Only checked when the candidate extension is YAML. The generated minikube
// API-IP patch is excluded explicitly even though it is normally Git-ignored;
// its tracked `.yaml.template` producer is also rejected by the extension gate.
export const ciYamlRoots = [
  'deploy/base',
  'deploy/components',
  'deploy/overlays',
  'deploy/security',
]

export const ciExcludedPaths = ['deploy/overlays/minikube/patches/k8s-api-ip.yaml']
