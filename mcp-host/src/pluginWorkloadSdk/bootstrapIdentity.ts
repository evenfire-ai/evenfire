import { isRunnableLlmModelId } from '@clerum/llm-providers'
import { isLlmProvider } from '../llm/registryCore'
import type { LlmProvider } from '../llm/registryCore'
import type { ConfigureResponse, PluginWorkloadSdkBootstrapRequest } from '../workflow/types'
import type {
  PluginWorkloadSdkBootstrapProof,
  PluginWorkloadSdkClientNotificationsBootstrapProof,
} from './promptBridge/controlApiClient'

export interface PluginWorkloadSdkBootstrapIdentityDeps {
  onConfigured?: (context: { provider: LlmProvider; defaultModel: string }) => void
  verify?: (provider: string, model: string) => Promise<PluginWorkloadSdkBootstrapProof | null>
  verifyClientNotifications?: () => Promise<PluginWorkloadSdkClientNotificationsBootstrapProof | null>
}

/**
 * Validate and publish the public provider/model bootstrap identity shared by
 * workflow and sdk-only hosts. Credentials are deliberately absent from this
 * contract; promptBridge resolves one credential ticket per provider attempt.
 */
export async function configurePluginWorkloadSdkBootstrapIdentity(
  req: PluginWorkloadSdkBootstrapRequest | undefined,
  deps: PluginWorkloadSdkBootstrapIdentityDeps
): Promise<ConfigureResponse> {
  if (req?.capabilityFamily === 'clientNotifications') {
    const proof = deps.verifyClientNotifications ? await deps.verifyClientNotifications() : null
    if (!proof) {
      return {
        configured: false,
        ready: false,
        contractVersion: 2,
        capabilityFamily: 'clientNotifications',
        message: 'Plugin Workload SDK clientNotifications readiness is not available',
      }
    }
    return {
      configured: true,
      ready: proof.ready,
      contractVersion: 2,
      capabilityFamily: 'clientNotifications',
      policyReady: proof.policyReady,
      policyState: proof.policyState,
      ...(proof.policyReason ? { policyReason: proof.policyReason } : {}),
    }
  }
  if (!req?.provider) {
    return { configured: false, message: 'provider is required' }
  }
  if (!isLlmProvider(req.provider)) {
    return { configured: false, message: `Unknown provider: ${req.provider}` }
  }
  const model = typeof req.model === 'string' ? req.model.trim() : ''
  if (!isRunnableLlmModelId(model)) {
    return { configured: false, message: 'model is required and has an invalid format' }
  }
  const proof = deps.verify ? await deps.verify(req.provider, model) : null
  if (deps.verify && !proof) {
    return {
      configured: false,
      ready: false,
      contractVersion: 2,
      message: 'Plugin Workload SDK identity bootstrap contract is not ready',
    }
  }
  deps.onConfigured?.({ provider: req.provider, defaultModel: model })
  return {
    configured: true,
    ready: true,
    capabilityFamily: 'promptBridge',
    provider: req.provider,
    model,
    contractVersion: 2,
    ...(proof ? { policyReady: proof.policyReady, policyState: proof.policyState } : {}),
    ...(proof?.policyReason ? { policyReason: proof.policyReason } : {}),
    ...(proof?.policyRevision !== undefined ? { policyRevision: proof.policyRevision } : {}),
    ...(proof?.policyHash !== undefined ? { policyHash: proof.policyHash } : {}),
    ...(proof?.defaultTargetRef !== undefined ? { defaultTargetRef: proof.defaultTargetRef } : {}),
    ...(proof?.defaultProvider !== undefined ? { defaultProvider: proof.defaultProvider } : {}),
    ...(proof?.defaultModel !== undefined ? { defaultModel: proof.defaultModel } : {}),
    ...(proof?.clientNotificationsPolicyReady !== undefined
      ? { clientNotificationsPolicyReady: proof.clientNotificationsPolicyReady }
      : {}),
    ...(proof?.clientNotificationsPolicyState !== undefined
      ? { clientNotificationsPolicyState: proof.clientNotificationsPolicyState }
      : {}),
    ...(proof?.clientNotificationsPolicyReason !== undefined
      ? { clientNotificationsPolicyReason: proof.clientNotificationsPolicyReason }
      : {}),
  }
}
