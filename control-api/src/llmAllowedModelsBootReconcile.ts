import * as k8s from '@kubernetes/client-node'
import { config } from './config.js'
import { llmAllowlistConfigMapWriteFailuresTotal } from './observability/metrics.js'
import {
  type AllowedModelsConfigMapMaterializer,
  LlmAllowedModelsConfigMapWriter,
} from './services/llmAllowedModelsConfigMap.js'

/**
 * Re-materialize the `clerum-llm-allowed-models` ConfigMap from Postgres on
 * boot (spec §3-R3.4 / V7 anti-drift). Runs after `initDb()` in main.ts.
 *
 * Wiring pattern mirrors `registryBootGuard.ts` — an isolated, testable module
 * with a narrow dependency graph — but with a DELIBERATE difference: the
 * registry guard is fail-fast and aborts the boot; this reconcile is
 * **non-fatal**. V7 asks for fail-loud without aborting: if the write fails we
 * log ERROR + increment the failure metric and let the process continue (the
 * next CRUD mutation, or the next boot, reconciles). Bricking control-api on a
 * transient K8s write would be worse than serving a slightly stale ConfigMap
 * that Postgres remains the source of truth for.
 */
export async function reconcileAllowedModelsConfigMapOnBoot(
  materializer?: AllowedModelsConfigMapMaterializer
): Promise<void> {
  try {
    const writer = materializer ?? buildDefaultWriter()
    await writer.materialize()
    console.log('[ControlAPI] llm allowed-models ConfigMap reconciled on boot')
  } catch (err) {
    llmAllowlistConfigMapWriteFailuresTotal.inc({ phase: 'boot' })
    console.error(
      '[ControlAPI] llm allowed-models ConfigMap boot reconcile failed (continuing):',
      err instanceof Error ? err.message : String(err)
    )
  }
}

function buildDefaultWriter(): LlmAllowedModelsConfigMapWriter {
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()
  const coreApi = kc.makeApiClient(k8s.CoreV1Api)
  // The allowlist ConfigMap always lives with the interactive Host pods.
  return new LlmAllowedModelsConfigMapWriter(coreApi, config.hostsNamespace)
}
