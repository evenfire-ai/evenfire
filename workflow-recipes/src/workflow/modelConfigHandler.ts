/**
 * Model Config Handler — WRC-side Secret Broker for model hot-swap.
 *
 * The coordinator sends { provider, model, stepId } (never apiKey).
 * WRC resolves the API key from K8s Secrets and forwards to mcp_host.
 *
 * Security invariant: model credentials travel only on the WRC→mcp_host
 * configure request and are never returned to the coordinator.
 */
import { createLogger } from '../observability/logger'

// ─── Types ──────────────────────────────────────────────────────────────

export interface ConfigureModelRequest {
  stepId: string
  provider: string
  model: string
  soulStorageRef?: {
    bucket: string
    key: string
  }
}

export interface ConfigureModelResult {
  status: number
  body: Record<string, unknown>
}

export interface K8sSecretReader {
  readConfigMap(namespace: string, name: string): Promise<Record<string, string> | null>
  readSecret(namespace: string, name: string): Promise<Record<string, string> | null>
}

export interface McpHostClient {
  configure(
    endpoint: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

export interface ObjectStorageReader {
  download(bucket: string, key: string): Promise<string | null>
}

// ─── Handler ────────────────────────────────────────────────────────────

const CONFIGMAP_NAME = 'clerum-model-secret-mapping'
const DEFAULT_CONFIGMAP_NAMESPACE = 'mcp-host'
const CONFIGMAP_NAMESPACE = process.env.CLERUM_MODEL_CONFIG_NAMESPACE ?? DEFAULT_CONFIGMAP_NAMESPACE

export class ModelConfigHandler {
  constructor(
    private readonly k8s: K8sSecretReader,
    private readonly mcpHost: McpHostClient,
    private readonly objectStorage?: ObjectStorageReader
  ) {}

  async handle(
    req: ConfigureModelRequest,
    mcpHostEndpoint: string,
    wrcConfigureToken: string
  ): Promise<ConfigureModelResult> {
    const VALID_PROVIDERS = new Set(['openai', 'claude', 'zai', 'bailian'])
    if (!VALID_PROVIDERS.has(req.provider)) {
      return { status: 400, body: { error: 'Invalid provider' } }
    }
    const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/
    if (!MODEL_PATTERN.test(req.model)) {
      return { status: 400, body: { error: 'Invalid model name' } }
    }

    // 1. Read ConfigMap to resolve provider/model → secretName
    const configMap = await this.k8s.readConfigMap(CONFIGMAP_NAMESPACE, CONFIGMAP_NAME)
    if (!configMap) {
      return { status: 500, body: { error: 'ConfigMap not found', configMap: CONFIGMAP_NAME } }
    }

    // K8s ConfigMap keys cannot contain "/" — use "__" as provider/model separator.
    // e.g. "zai/glm-4.7" → "zai__glm-4.7"
    const mappingKey = `${req.provider}__${req.model}`
    const mapping = configMap[mappingKey]
    if (!mapping) {
      return { status: 404, body: { error: 'No secret mapping found', key: mappingKey } }
    }

    // Value format is "<secretName>/<keyName>" — explicit addressing of any
    // (Secret, key) tuple without assuming a canonical key name.
    const slash = mapping.indexOf('/')
    if (slash <= 0 || slash === mapping.length - 1) {
      return { status: 500, body: { error: 'Malformed secret mapping' } }
    }
    const secretName = mapping.substring(0, slash)
    const keyName = mapping.substring(slash + 1)

    // 2. Read Secret by name (get only, not list)
    const secret = await this.k8s.readSecret(CONFIGMAP_NAMESPACE, secretName)
    if (!secret) {
      return { status: 500, body: { error: 'Secret resolution failed for provider/model' } }
    }

    const apiKey = secret[keyName]
    if (!apiKey) {
      return { status: 500, body: { error: 'Secret resolution failed for provider/model' } }
    }

    // 3. Optional SOUL download
    let soulContent: string | undefined
    if (req.soulStorageRef && this.objectStorage) {
      try {
        const content = await this.objectStorage.download(
          req.soulStorageRef.bucket,
          req.soulStorageRef.key
        )
        if (content) soulContent = content
      } catch {
        // Non-blocking: workflow continues without SOUL override
        createLogger('wrc', 'model-config-handler').warn(
          'SOUL download failed — continuing without step SOUL override',
          { stepId: req.stepId }
        )
      }
    }

    // 4. POST /configure to mcp_host — apiKey ONLY on this leg. The secret
    // name is non-secret metadata used only for usage attribution; the key
    // name and value never leave WRC.
    const configureBody: Record<string, unknown> = {
      provider: req.provider,
      model: req.model,
      apiKey,
      llmSecretName: secretName,
    }
    if (soulContent) configureBody.soulContent = soulContent

    try {
      const result = await this.mcpHost.configure(mcpHostEndpoint, wrcConfigureToken, configureBody)
      if (result.status >= 400) {
        return {
          status: 502,
          body: { error: 'mcp_host configure failed', mcpHostStatus: result.status },
        }
      }
    } catch {
      return { status: 502, body: { error: 'mcp_host configure unreachable' } }
    }

    // 5. Response to coordinator — NEVER include apiKey
    return {
      status: 202,
      body: { configured: true, provider: req.provider, model: req.model },
    }
  }
}
