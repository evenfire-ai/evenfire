import { type Registry, collectDefaultMetrics, register } from 'prom-client'

type RegistrationState = 'idle' | 'registering' | 'complete'

const registrationStates = new WeakMap<Registry, RegistrationState>()
const PROCESS_CPU_METRIC = 'process_cpu_user_seconds_total'

/**
 * Register prom-client's process metrics once for each registry. The state
 * machine makes repeated server imports safe while preserving a retry path if
 * registration throws before the metric set is complete.
 */
export function registerProcessMetrics(registry: Registry = register): void {
  const state = registrationStates.get(registry) ?? 'idle'
  if (state === 'complete' || state === 'registering') return
  if (registry.getSingleMetric(PROCESS_CPU_METRIC)) {
    registrationStates.set(registry, 'complete')
    return
  }

  registrationStates.set(registry, 'registering')
  try {
    collectDefaultMetrics({ register: registry })
    registrationStates.set(registry, 'complete')
  } catch (error) {
    registrationStates.set(registry, 'idle')
    throw error
  }
}

registerProcessMetrics()
