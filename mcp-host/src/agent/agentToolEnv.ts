import type { ConfigStore } from '../config/configStore'

/**
 * Env handed to shell-tool subprocesses. MUST use userEnvSnapshot() (not
 * snapshot()) so the LLM provider API key is never exposed to a child shell —
 * any tool-call could exfiltrate it. Security boundary; locked by
 * agentToolEnv.test.ts.
 */
export function agentToolEnvProvider(
  store: ConfigStore | null | undefined
): Record<string, string> {
  return store?.userEnvSnapshot() ?? {}
}
