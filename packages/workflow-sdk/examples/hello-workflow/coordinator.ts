/**
 * Example workflow coordinator using @clerum/workflow-sdk.
 *
 * Demonstrates:
 * - SDK initialization via fromEnvironment()
 * - Hybrid execution: SDK-only steps + agent steps (mcp_host)
 * - Signal handling (pause/resume/cancel)
 * - Status reporting to WRC
 * - Prompt template rendering with previous step outputs
 * - Model hot-swap via WRC secret broker
 * - Graceful shutdown
 *
 * Usage:
 *   1. Build: tsc coordinator.ts
 *   2. WRC creates this Pod with required env vars
 *   3. Coordinator runs, executes steps, reports status, shuts down
 */
import {
  type StepContext,
  type StepMcpServerRef,
  type StepSpec,
  WorkflowSDK,
  emitLog,
  loadSoul,
  renderPrompt,
  requestModelInjection,
  withRetry,
} from '@clerum/workflow-sdk'

/**
 * Resolve MCP server string names → StepMcpServerRef objects.
 *
 * The CRD spec stores mcpServers as string names. The execution engine
 * (mcp-host) requires full references with URLs. Resolution strategy:
 *  1. Check env var MCP_{NAME}_URL  (e.g. MCP_DB_URL=http://db-svc:8080)
 *  2. Fall back to k8s Service convention: http://{name}.sandbox-recipes.svc.cluster.local:8080
 *
 * Auth token: check env var MCP_{NAME}_AUTH_TOKEN.
 */
function resolveServerRefs(names: string[]): StepMcpServerRef[] {
  return names.map(name => {
    const envKey = name.toUpperCase().replace(/-/g, '_')
    const url =
      process.env[`MCP_${envKey}_URL`] ?? `http://${name}.sandbox-recipes.svc.cluster.local:8080`
    const authToken = process.env[`MCP_${envKey}_AUTH_TOKEN`]
    return authToken ? { name, url, authToken } : { name, url }
  })
}

async function main(): Promise<void> {
  // 1. Initialize SDK — reads env vars injected by WRC
  const sdk = await WorkflowSDK.fromEnvironment()
  const cfg = sdk.config.getConfig()
  const spec = await sdk.config.getSpec()

  emitLog('info', `Starting workflow: ${spec.name}`, {
    steps: spec.steps.length,
    hasAgent: !!spec.agent,
  })

  // 2. Start signal polling — react to pause/resume/cancel
  sdk.signals.pollSignals(async signal => {
    emitLog('info', `Signal received: ${signal.type}`, { requestId: signal.requestId })
    sdk.coordinator.injectSignal(signal)
  })

  // 3. Report workflow initializing
  sdk.updatePhase('initializing')
  await sdk.status.reportWorkflowStatus('initializing')

  // 4. Request model configuration if agent is specified
  if (spec.agent) {
    await requestModelInjection(cfg.wrcUrl, spec.name, cfg.tokenProvider, {
      stepId: '__global__',
      provider: spec.agent.provider,
      model: spec.agent.model,
    })
  }

  // 5. Run workflow — define step executor
  sdk.updatePhase('running')
  await sdk.status.reportWorkflowStatus('running')

  try {
    const outputs = await sdk.coordinator.runWorkflow(
      spec,
      async (step: StepSpec, ctx: StepContext) => {
        // Check for cancel signal
        if (ctx.signals.some(s => s.type === 'cancel')) {
          emitLog('info', `Skipping step ${step.id} — workflow cancelled`)
          sdk.updateStepState(step.id, { phase: 'skipped' })
          await sdk.status.reportStepStatus(step.id, 'skipped')
          return null
        }

        emitLog('info', `Executing step: ${step.id}`, { instruction: step.instruction })
        sdk.updateStepState(step.id, { phase: 'running' })
        await sdk.status.reportStepStatus(step.id, 'running')

        const startMs = Date.now()

        try {
          let output: unknown

          if (step.agent) {
            // --- Agent step: delegate to mcp_host ---
            const mcpHost = sdk.requireMcpHost()

            // Per-step model hot-swap
            await requestModelInjection(cfg.wrcUrl, spec.name, cfg.tokenProvider, {
              stepId: step.id,
              provider: step.agent.provider,
              model: step.agent.model,
            })

            // Render prompt template with previous outputs
            let prompt = step.instruction
            if (step.prompt?.template) {
              const soul = step.prompt.soul ? await loadSoul(step.prompt.soul) : undefined
              prompt = renderPrompt(step.prompt.template, {
                step,
                previousOutputs: ctx.previousOutputs,
                soul,
                workflowName: ctx.workflowName,
              })
            }

            // Execute agent step with retry
            const result = await withRetry(
              () =>
                mcpHost.executeAgentStep({
                  stepId: step.id,
                  mcpServers: resolveServerRefs(step.mcpServers ?? []),
                  allowedTools: step.tools?.include ? { include: step.tools.include } : undefined,
                  instruction: prompt,
                  timeoutSeconds: step.timeoutSeconds,
                }),
              { maxAttempts: step.retries ?? 1, backoffSeconds: step.backoffSeconds ?? 5 }
            )

            if (result.status === 'failed') {
              throw new Error(result.error ?? 'Agent step failed')
            }
            output = result.output
          } else {
            // --- SDK-only step: execute in coordinator ---
            // Developer replaces this with custom logic
            output = {
              message: `Step ${step.id} completed locally`,
              timestamp: new Date().toISOString(),
            }
          }

          const durationMs = Date.now() - startMs
          sdk.updateStepState(step.id, { phase: 'completed', output })
          await sdk.status.reportStepStatus(step.id, 'completed', { output, durationMs })
          emitLog('info', `Step completed: ${step.id}`, { durationMs })
          return output
        } catch (err) {
          const error = err as Error
          const durationMs = Date.now() - startMs
          sdk.updateStepState(step.id, { phase: 'failed' })
          await sdk.status.reportStepStatus(step.id, 'failed', { error: error.message, durationMs })
          emitLog('error', `Step failed: ${step.id}: ${error.message}`)
          throw error
        }
      }
    )

    // 6. Workflow completed
    sdk.updatePhase('completed')
    await sdk.status.reportWorkflowStatus('completed')
    emitLog('info', 'Workflow completed', { outputKeys: Object.keys(outputs) })
  } catch (err) {
    // 7. Workflow failed
    const error = err as Error
    sdk.updatePhase('failed')
    await sdk.status.reportWorkflowStatus('failed', { error: error.message })
    emitLog('error', `Workflow failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    // 8. Graceful shutdown
    await sdk.shutdown()
  }
}

main().catch(err => {
  console.error('Fatal coordinator error:', err)
  process.exit(1)
})
