import { describe, expect, it } from 'vitest'
import { buildPromptBridgeUsageEvent } from './index'

const WORKFLOW_RUN_ID = '00000000-0000-4000-8000-000000000001'

describe('PluginWorkloadSdk server usage attribution', () => {
  it('does not emit invalid workflow usage when promptBridge lacks authoritative run metadata', () => {
    const event = buildPromptBridgeUsageEvent({
      binding: {
        hostRef: 'sandbox-recipes/risk-review',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
      },
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      callerRef: 'worker',
    })

    expect(event).toBeNull()
  })

  it('emits the accepted workflow usage shape when promptBridge carries run and secret metadata', () => {
    const event = buildPromptBridgeUsageEvent({
      binding: {
        hostRef: 'sandbox-recipes/risk-review',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
      },
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      callerRef: 'worker',
      metadata: {
        workflowExecutionId: `${WORKFLOW_RUN_ID}:risk-review:2026-07-12T12:00:00.000Z`,
        workflowRunId: WORKFLOW_RUN_ID,
        llmSecretName: 'chatllm-api-keys',
        workflowTeamId: '11111111-1111-4111-8111-111111111111',
        workflowUserId: '22222222-2222-4222-8222-222222222222',
      },
    })

    expect(event).toMatchObject({
      run_id: WORKFLOW_RUN_ID,
      host_ref: 'sandbox-recipes/risk-review',
      recipe_name: 'risk-review',
      source_kind: 'workflow',
      llm_secret_name: 'chatllm-api-keys',
      task_id: `${WORKFLOW_RUN_ID}:risk-review:2026-07-12T12:00:00.000Z`,
      team_id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      sender: 'worker',
      channel_type: 'plugin_workload_sdk',
      input_tokens: 10,
      output_tokens: 5,
    })
  })

  it('emits a server-bound SDK-only usage shape without inventing a workflow run', () => {
    const invocationId = '00000000-0000-4000-8000-000000000099'
    const event = buildPromptBridgeUsageEvent({
      binding: {
        hostRef: 'sandbox-recipes/stepless',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'stepless',
      },
      runtimeMode: 'sdk-only',
      invocationId,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      inputTokens: 10,
      outputTokens: 5,
      callerRef: 'backend-worker',
      promptBridgeMetadata: {
        targetRef: 'openai-primary',
        credentialSlot: 'openai-api-key',
        fallbackUsed: false,
        attemptCount: 1,
      },
      metadata: { llmSecretName: 'openai-api-key' },
    })

    expect(event).toMatchObject({
      source_kind: 'unknown',
      channel_type: 'plugin_workload_sdk',
      recipe_name: 'stepless',
      run_id: null,
      task_id: null,
      llm_secret_name: 'openai-api-key',
      prompt_bridge_metadata: { invocation_id: invocationId },
    })
  })

  it('records actual promptBridge target attribution without credential values', () => {
    const event = buildPromptBridgeUsageEvent({
      binding: {
        hostRef: 'plugin-workload-sdk/sandbox-app',
        recipeNamespace: 'sandbox-apps',
        recipeName: 'prompt-notify',
      },
      provider: 'openai',
      model: 'gpt-5.4-mini',
      inputTokens: 10,
      outputTokens: 5,
      callerRef: 'backend-worker',
      promptBridgeMetadata: {
        targetRef: 'fallback-openai',
        credentialSlot: 'openai-api-key',
        fallbackUsed: true,
        attemptCount: 2,
      },
    })

    expect(event).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      prompt_bridge_metadata: {
        target_ref: 'fallback-openai',
        credential_slot: 'openai-api-key',
        fallback_used: true,
        attempt_count: 2,
      },
    })
    expect(JSON.stringify(event)).not.toContain('credentialTicket')
    expect(JSON.stringify(event)).not.toContain('secret-')
  })
})
