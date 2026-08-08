import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, registryUrlStartupWarning } from './config'

describe('loadConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should return defaults when no env vars set (Risk 1.6)', () => {
    delete process.env.CLERUM_OPERATOR_PORT
    delete process.env.CLERUM_DEV_MODE
    delete process.env.CLERUM_NAMESPACE
    delete process.env.CLERUM_HOST_NAMESPACE
    delete process.env.CLERUM_OPERATOR_NAME
    delete process.env.CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE
    delete process.env.CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS
    delete process.env.CLERUM_WORKFLOW_MAX_STEPS
    delete process.env.CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS
    delete process.env.CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS
    delete process.env.CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS
    delete process.env.CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS
    delete process.env.CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES
    delete process.env.WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE
    delete process.env.WRC_ENABLE_SNIPPET_RUNTIME
    delete process.env.WRC_MAX_WORKFLOW_STEPS
    delete process.env.WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES
    delete process.env.WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST
    delete process.env.WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS
    delete process.env.WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS
    delete process.env.WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS
    delete process.env.WRC_RUNTIME_TOKEN_TTL_SECONDS
    delete process.env.WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS
    delete process.env.WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS
    delete process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE
    delete process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED
    delete process.env.GOVERNED_TRACING_ENABLED
    const config = loadConfig()
    expect(config.port).toBe(8082)
    expect(config.namespace).toBe('mcp-server')
    expect(config.hostNamespace).toBe('mcp-host')
    expect(config.selfName).toBe('workflow-recipes')
    expect(config.devMode).toBe(false)
    expect(config.enableCustomCoordinatorImage).toBe(false)
    expect(config.maxWorkflowSteps).toBe(100)
    expect(config.allowedCoordinatorImagePrefixes).toEqual([])
    expect(config.requireCoordinatorImageDigest).toBe(true)
    expect(config.enableDeterministicMode).toBe(true)
    expect(config.governedTracingEnabled).toBe(true)
    expect(config.workflowDefaultRunDurationSeconds).toBe(3600)
    expect(config.workflowMaxRunDurationSeconds).toBe(86400)
    expect(config.workflowStepOutputPreviewMaxChars).toBe(32768)
    expect(config.runtimeTokenTtlSeconds).toBe(900)
    expect(config.runtimeTokenRefreshBeforeSeconds).toBe(300)
    expect(config.runtimeEgressDnsOverlapSeconds).toBe(300)
    expect(config.networkPolicyEnforcementMode).toBe('required')
    expect(config.networkPolicyEnforcementConfirmed).toBe(false)
    expect(config.workflowMaxWorkloadsPerRecipe).toBe(25)
    expect(config.workflowUiEgressInternalMaxItems).toBe(25)
    expect(config.workflowMaxSteps).toBe(100)
    expect(config.workflowStepDependsOnMaxItems).toBe(100)
    expect(config.workflowStepAllowedToolsMaxItems).toBe(50)
    expect(config.workflowStepMcpServersMaxItems).toBe(20)
    expect(config.workflowStatefulSetMaxReplicas).toBe(20)
    expect(config.workflowStatefulSetMaxVolumeClaimTemplates).toBe(4)
    expect(config.workflowStatefulSetMaxPvcPreflightChecks).toBe(80)
  })

  it('should read CLERUM_OPERATOR_PORT from env (Risk 1.6)', () => {
    process.env.CLERUM_OPERATOR_PORT = '9090'
    const config = loadConfig()
    expect(config.port).toBe(9090)
  })

  it('should read CLERUM_DEV_MODE=true as boolean (Risk 1.6)', () => {
    process.env.CLERUM_DEV_MODE = 'true'
    const config = loadConfig()
    expect(config.devMode).toBe(true)
  })

  it('reads GOVERNED_TRACING_ENABLED=false', () => {
    process.env.GOVERNED_TRACING_ENABLED = 'false'
    const config = loadConfig()
    expect(config.governedTracingEnabled).toBe(false)
  })

  it('reads the NetworkPolicy enforcement mode override', () => {
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE = 'warn'
    const config = loadConfig()
    expect(config.networkPolicyEnforcementMode).toBe('warn')
  })

  it('reads the NetworkPolicy enforcement confirmation override', () => {
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED = 'true'
    const config = loadConfig()
    expect(config.networkPolicyEnforcementConfirmed).toBe(true)
  })

  it('rejects invalid NetworkPolicy enforcement mode values', () => {
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE = 'fallback'
    expect(() => loadConfig()).toThrow(/CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE/)
  })

  it('should read the WRC InternalControl JWT secret from the issuer-specific env var', () => {
    process.env.INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET = 'test-wrc-internal-control-secret'
    const config = loadConfig()
    expect(config.internalControlJwtWrcHmacSecret).toBe('test-wrc-internal-control-secret')
  })

  it('should read custom coordinator image policy env vars', () => {
    process.env.WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE = 'true'
    process.env.WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES =
      'clerum/workflow-custom-sdk-e2e:, ghcr.io/your-org/'
    process.env.WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST = 'true'
    const config = loadConfig()
    expect(config.enableCustomCoordinatorImage).toBe(true)
    expect(config.allowedCoordinatorImagePrefixes).toEqual([
      'clerum/workflow-custom-sdk-e2e:',
      'ghcr.io/your-org/',
    ])
    expect(config.requireCoordinatorImageDigest).toBe(true)
  })

  it('should read WRC_MAX_WORKFLOW_STEPS from env', () => {
    process.env.WRC_MAX_WORKFLOW_STEPS = '42'
    const config = loadConfig()
    expect(config.maxWorkflowSteps).toBe(42)
    expect(config.workflowMaxSteps).toBe(42)
  })

  it('loads workflow duration and runtime token controls independently', () => {
    process.env.WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS = '300'
    process.env.WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS = '600'
    process.env.WRC_RUNTIME_TOKEN_TTL_SECONDS = '90'
    process.env.WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS = '45'

    const config = loadConfig()

    expect(config.workflowDefaultRunDurationSeconds).toBe(300)
    expect(config.workflowMaxRunDurationSeconds).toBe(600)
    expect(config.runtimeTokenTtlSeconds).toBe(90)
    expect(config.runtimeTokenRefreshBeforeSeconds).toBe(45)
  })

  it('rejects a runtime token refresh window that is not smaller than the token ttl', () => {
    process.env.WRC_RUNTIME_TOKEN_TTL_SECONDS = '90'
    process.env.WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS = '90'

    expect(() => loadConfig()).toThrow(/WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS/)
  })

  it('rejects a workflow default duration above the configured workflow max duration', () => {
    process.env.WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS = '601'
    process.env.WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS = '600'

    expect(() => loadConfig()).toThrow(/WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS/)
  })

  it('loads workflow step output preview limit independently from runtime duration', () => {
    process.env.WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS = '4096'
    const config = loadConfig()
    expect(config.workflowStepOutputPreviewMaxChars).toBe(4096)
  })

  it.each([['1023'], ['65537'], ['1.5'], ['not-a-number']])(
    'rejects invalid workflow step output preview limit %s',
    value => {
      process.env.WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS = value
      expect(() => loadConfig()).toThrow(/WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS/)
    }
  )

  it('loads runtime egress DNS overlap independently from token rotation', () => {
    process.env.WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS = '120'
    const config = loadConfig()
    expect(config.runtimeEgressDnsOverlapSeconds).toBe(120)
  })

  it.each([['29'], ['3601'], ['1.5'], ['not-a-number']])(
    'rejects invalid runtime egress DNS overlap %s',
    value => {
      process.env.WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS = value
      expect(() => loadConfig()).toThrow(/WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS/)
    }
  )

  it('should throw on invalid WRC_MAX_WORKFLOW_STEPS', () => {
    process.env.WRC_MAX_WORKFLOW_STEPS = '0'
    expect(() => loadConfig()).toThrow('WRC_MAX_WORKFLOW_STEPS')
  })

  it('should throw on invalid port (Risk 1.6)', () => {
    process.env.CLERUM_OPERATOR_PORT = '-1'
    expect(() => loadConfig()).toThrow()
  })

  it('accepts workflow limit overrides within CRD ceilings', () => {
    process.env.CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE = '12'
    process.env.CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS = '15'
    process.env.CLERUM_WORKFLOW_MAX_STEPS = '80'
    process.env.CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS = '90'
    process.env.CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS = '75'
    process.env.CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS = '12'
    process.env.CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS = '3'
    process.env.CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES = '2'

    const config = loadConfig()

    expect(config.workflowMaxWorkloadsPerRecipe).toBe(12)
    expect(config.workflowUiEgressInternalMaxItems).toBe(15)
    expect(config.maxWorkflowSteps).toBe(80)
    expect(config.workflowMaxSteps).toBe(80)
    expect(config.workflowStepDependsOnMaxItems).toBe(90)
    expect(config.workflowStepAllowedToolsMaxItems).toBe(75)
    expect(config.workflowStepMcpServersMaxItems).toBe(12)
    expect(config.workflowStatefulSetMaxReplicas).toBe(3)
    expect(config.workflowStatefulSetMaxVolumeClaimTemplates).toBe(2)
    expect(config.workflowStatefulSetMaxPvcPreflightChecks).toBe(6)
  })

  it.each([
    ['CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE', '0'],
    ['CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE', '26'],
    ['CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS', '0'],
    ['CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS', '26'],
    ['CLERUM_WORKFLOW_MAX_STEPS', '0'],
    ['CLERUM_WORKFLOW_MAX_STEPS', '101'],
    ['CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS', '-1'],
    ['CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS', '101'],
    ['CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS', '1.5'],
    ['CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS', '101'],
    ['CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS', 'twenty'],
    ['CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS', '21'],
    ['CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS', '0'],
    ['CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS', '21'],
    ['CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS', '1.5'],
    ['CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES', '0'],
    ['CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES', '5'],
    ['CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES', 'two'],
  ])('rejects invalid workflow limit %s=%s', (key, value) => {
    process.env[key] = value
    expect(() => loadConfig()).toThrow(new RegExp(key))
  })

  it('should return devMode:false by default (Risk 1.6)', () => {
    delete process.env.CLERUM_DEV_MODE
    const config = loadConfig()
    expect(config.devMode).toBe(false)
  })

  // ─── issue #299: external egress sliding-window accumulator knobs ─────────
  it('defaults the external egress accumulator knobs (overlap/floor/interval/max)', () => {
    delete process.env.WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS
    delete process.env.WRC_EXTERNAL_EGRESS_REFRESH_FLOOR_SECONDS
    delete process.env.WRC_EXTERNAL_EGRESS_REFRESH_INTERVAL_SECONDS
    delete process.env.WRC_EXTERNAL_EGRESS_MAX_ENTRIES
    const config = loadConfig()
    expect(config.externalEgressOverlapSeconds).toBe(300)
    expect(config.externalEgressRefreshFloorSeconds).toBe(5)
    expect(config.externalEgressRefreshIntervalSeconds).toBe(60)
    expect(config.externalEgressMaxEntries).toBe(128)
  })

  it('reads external egress accumulator overrides', () => {
    process.env.WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS = '600'
    process.env.WRC_EXTERNAL_EGRESS_REFRESH_FLOOR_SECONDS = '7'
    process.env.WRC_EXTERNAL_EGRESS_REFRESH_INTERVAL_SECONDS = '30'
    process.env.WRC_EXTERNAL_EGRESS_MAX_ENTRIES = '256'
    const config = loadConfig()
    expect(config.externalEgressOverlapSeconds).toBe(600)
    expect(config.externalEgressRefreshFloorSeconds).toBe(7)
    expect(config.externalEgressRefreshIntervalSeconds).toBe(30)
    expect(config.externalEgressMaxEntries).toBe(256)
  })

  it.each([
    ['WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS', '29'],
    ['WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS', 'not-a-number'],
    ['WRC_EXTERNAL_EGRESS_REFRESH_FLOOR_SECONDS', '0'],
    ['WRC_EXTERNAL_EGRESS_REFRESH_FLOOR_SECONDS', '1.5'],
    ['WRC_EXTERNAL_EGRESS_REFRESH_INTERVAL_SECONDS', '0'],
    ['WRC_EXTERNAL_EGRESS_MAX_ENTRIES', '7'],
    ['WRC_EXTERNAL_EGRESS_MAX_ENTRIES', 'lots'],
  ])('rejects invalid external egress knob %s=%s', (key, value) => {
    process.env[key] = value
    expect(() => loadConfig()).toThrow(new RegExp(key))
  })

  it('enforces the floor <= interval < overlap invariant (fail loud)', () => {
    // floor > interval
    process.env.WRC_EXTERNAL_EGRESS_REFRESH_FLOOR_SECONDS = '40'
    process.env.WRC_EXTERNAL_EGRESS_REFRESH_INTERVAL_SECONDS = '30'
    process.env.WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS = '300'
    expect(() => loadConfig()).toThrow(/floor.*interval.*overlap|external egress/i)
  })

  it('rejects an interval that is not strictly below the overlap', () => {
    process.env.WRC_EXTERNAL_EGRESS_REFRESH_FLOOR_SECONDS = '5'
    process.env.WRC_EXTERNAL_EGRESS_REFRESH_INTERVAL_SECONDS = '300'
    process.env.WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS = '300'
    expect(() => loadConfig()).toThrow(/floor.*interval.*overlap|external egress/i)
  })
})

// An unset/unparseable CLERUM_REGISTRY_URL makes isPlatformRegistryImage() return false
// for EVERY image, which turns off platform pull-credential injection entirely — while
// control-api still mints and writes the Secret. Recipe pods then ImagePullBackOff and
// nothing in the logs says why. This warning is the announcement of that state.
describe('registryUrlStartupWarning', () => {
  it('returns null when a parseable registry URL is configured', () => {
    expect(registryUrlStartupWarning('https://registry.evenfire.ai')).toBeNull()
    expect(registryUrlStartupWarning('http://registry-api.registry.svc.cluster.local:8085')).toBe(
      null
    )
  })

  it('warns that pull-credential injection is disabled when the URL is unset', () => {
    for (const unset of ['', '   ']) {
      const warning = registryUrlStartupWarning(unset)
      expect(warning).toMatch(/CLERUM_REGISTRY_URL/)
      expect(warning).toMatch(/not set/)
      expect(warning).toMatch(/ImagePullBackOff/)
    }
  })

  it('warns when the URL is set but unparseable — same silent-disable effect', () => {
    const warning = registryUrlStartupWarning('registry.evenfire.ai')
    expect(warning).toMatch(/CLERUM_REGISTRY_URL/)
    expect(warning).toMatch(/registry\.evenfire\.ai/)
    expect(warning).toMatch(/ImagePullBackOff/)
  })

  it('does not depend on ambient env — it reports on the value it is given', () => {
    process.env.CLERUM_REGISTRY_URL = 'https://registry.evenfire.ai'
    expect(registryUrlStartupWarning('')).not.toBeNull()
  })
})
