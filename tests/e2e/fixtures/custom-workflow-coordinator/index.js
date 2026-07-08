const fs = require('node:fs/promises')
const path = require('node:path')
const {
  WorkflowSDK,
  emitLog,
  renderPrompt,
  requestModelInjection,
} = require('@clerum/workflow-sdk')

const ARTIFACT_NAME = 'custom-sdk-result.json'
const ARTIFACT_PATH = `/output/${ARTIFACT_NAME}`
const SUMMARY_ARTIFACT_NAME = 'custom-risk-summary.md'
const SUMMARY_ARTIFACT_PATH = `/output/${SUMMARY_ARTIFACT_NAME}`
const WRC_PROBE_TIMEOUT_MS = 10000
const PUBLIC_HTTP_PROBE_TIMEOUT_MS = 30000
const WORKLOAD_PROBE_TIMEOUT_MS = 30000
const WORKLOAD_PROBE_RETRY_MS = 1000

async function readRequiredTokenFile(envName) {
  const filePath = process.env[envName]
  if (!filePath) {
    throw new Error(`${envName} is required for custom coordinator WRC probes`)
  }
  const token = (await fs.readFile(filePath, 'utf8')).trim()
  if (!token) {
    throw new Error(`${envName} is empty`)
  }
  return token
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatError(err) {
  const message = err instanceof Error ? err.message : String(err)
  const cause = err?.cause instanceof Error ? `: ${err.cause.message}` : ''
  return `${message}${cause}`
}

function readContractDefault(spec, key, fallback) {
  const inputValue = spec.inputs?.[key]
  if (inputValue !== undefined && inputValue !== null && inputValue !== '') {
    return inputValue
  }
  const value = spec.inputContract?.properties?.[key]?.default
  return value ?? fallback
}

async function callWrc(spec, route, options = {}) {
  const base = `${process.env.CLERUM_WRC_URL}/api/v1/workflow/${encodeURIComponent(spec.name)}`
  const target = `${base}${route}`
  const wrcToken = await readRequiredTokenFile('WRC_TOKEN_FILE')
  try {
    const response = await fetch(target, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${wrcToken}`,
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(WRC_PROBE_TIMEOUT_MS),
    })
    return response.status
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error(`WRC probe ${route} timed out after ${WRC_PROBE_TIMEOUT_MS}ms`)
    }
    throw new Error(`WRC probe ${route} failed: ${formatError(err)}`, { cause: err })
  }
}

async function probeRuntimeHttpEgress(spec) {
  const allowedHosts = spec.runtimeEgress?.http?.allowedHosts ?? []
  if (!allowedHosts.includes('api.github.com')) {
    return { attempted: false, allowedHosts }
  }

  let response
  try {
    response = await fetch('https://api.github.com/repos/octocat/Hello-World', {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'clerum-workflow-e2e',
      },
      signal: AbortSignal.timeout(PUBLIC_HTTP_PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error(
        `public HTTP probe to api.github.com timed out after ${PUBLIC_HTTP_PROBE_TIMEOUT_MS}ms`
      )
    }
    throw new Error(`public HTTP probe to api.github.com failed: ${formatError(err)}`, {
      cause: err,
    })
  }
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`public HTTP probe failed with status ${response.status}`)
  }
  if (body?.full_name !== 'octocat/Hello-World' || body?.private !== false) {
    throw new Error(`public HTTP probe returned unexpected GitHub payload: ${JSON.stringify(body)}`)
  }

  return {
    attempted: true,
    reachable: true,
    host: 'api.github.com',
    api: 'github',
    status: response.status,
    repoFullName: body.full_name,
    private: body.private,
    sourceUrl: body.html_url,
  }
}

async function probeDeclaredWorkflowWorkload(spec) {
  const workload = (spec.workloads ?? []).find(
    item => item.id === 'business-api' && !item.transport
  )
  if (!workload) {
    return { attempted: false }
  }
  const deadline = Date.now() + WORKLOAD_PROBE_TIMEOUT_MS
  const target = `http://${workload.host}:${workload.port}/`
  let response
  let lastError
  while (Date.now() < deadline) {
    try {
      response = await fetch(target, {
        signal: AbortSignal.timeout(WORKLOAD_PROBE_RETRY_MS),
      })
      break
    } catch (err) {
      lastError = err
      await new Promise(resolve => setTimeout(resolve, WORKLOAD_PROBE_RETRY_MS))
    }
  }
  if (!response) {
    throw new Error(
      `declared workflow workload probe to ${workload.id} timed out after ${WORKLOAD_PROBE_TIMEOUT_MS}ms: ${formatError(lastError ?? new Error('unknown'))}`
    )
  }
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`declared workflow workload probe failed with status ${response.status}`)
  }
  if (body?.status !== 'ok' || !Array.isArray(body?.tools) || !body.tools.includes('record')) {
    throw new Error(
      `declared workflow workload returned unexpected payload: ${JSON.stringify(body)}`
    )
  }
  return {
    attempted: true,
    workloadId: workload.id,
    host: workload.host,
    port: workload.port,
    status: response.status,
    bodyStatus: body.status,
    tools: body.tools,
  }
}

async function probeForbiddenWrcCapabilities(spec) {
  const phantomStatus = await callWrc(spec, '/status', {
    method: 'POST',
    body: JSON.stringify({
      stepId: 'phantom-step',
      phase: 'completed',
      executor: 'custom',
    }),
  })
  const configureModelStatus = await callWrc(spec, '/configure-model', {
    method: 'POST',
    body: JSON.stringify({
      stepId: 'transform',
      provider: 'openai',
      model: 'gpt-4o-mini',
    }),
  })
  const declaredAgentStep = spec.steps.find(step => step.agent || spec.agent) ?? spec.steps[0]
  const declaredAgent = declaredAgentStep?.agent ?? spec.agent ?? {}
  const wrongProvider = declaredAgent.provider === 'zai' ? 'openai' : 'zai'
  const undeclaredInjectionStatus = await callWrc(spec, '/injections/model', {
    method: 'POST',
    body: JSON.stringify({
      stepId: declaredAgentStep?.id ?? 'prepare',
      provider: wrongProvider,
      model: wrongProvider === 'zai' ? 'glm-4.7' : 'gpt-4o-mini',
    }),
  })
  const triggerStatus = await callWrc(spec, '/trigger', {
    method: 'POST',
    body: JSON.stringify({}),
  })

  if (phantomStatus !== 422) {
    throw new Error(`expected phantom step status 422, got ${phantomStatus}`)
  }
  if (configureModelStatus !== 403) {
    throw new Error(`expected configure-model 403, got ${configureModelStatus}`)
  }
  if (undeclaredInjectionStatus !== 422) {
    throw new Error(`expected undeclared model injection 422, got ${undeclaredInjectionStatus}`)
  }
  if (triggerStatus !== 403) {
    throw new Error(`expected trigger 403, got ${triggerStatus}`)
  }

  return { phantomStatus, configureModelStatus, undeclaredInjectionStatus, triggerStatus }
}

function hasBrokerBackedWork(step) {
  return Boolean(
    step.agent ||
    step.instruction ||
    (Array.isArray(step.mcpServers) && step.mcpServers.length > 0) ||
    step.requiresApproval
  )
}

function resolveStepAgent(step, spec, currentAgent) {
  const provider = step.agent?.provider ?? spec.agent?.provider ?? currentAgent?.provider
  const model = step.agent?.model ?? spec.agent?.model ?? currentAgent?.model
  if (!provider || !model) return null
  return { provider, model }
}

async function waitForMcpHostReady(mcpHost, attempts = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const health = await mcpHost.healthCheck()
    if (health.status === 'healthy') return
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw new Error('mcp_host did not become ready for broker-backed custom coordinator step')
}

function summarizeToolCalls(toolsCalled) {
  if (!Array.isArray(toolsCalled)) return []
  return toolsCalled.map(item => ({
    serverName: item.serverName,
    toolName: item.toolName,
    args: item.args,
    durationMs: item.durationMs,
  }))
}

async function runBrokerBackedStep(step, spec, previousOutputs, runtimeState, sdk) {
  const mcpHost = sdk.requireMcpHost()
  await waitForMcpHostReady(mcpHost)

  const agent = resolveStepAgent(step, spec, runtimeState.currentAgent)
  if (!agent) {
    throw new Error(`broker-backed step ${step.id} is missing declared agent provider/model`)
  }

  if (
    !runtimeState.currentAgent ||
    runtimeState.currentAgent.provider !== agent.provider ||
    runtimeState.currentAgent.model !== agent.model
  ) {
    const config = sdk.config.getConfig()
    await requestModelInjection(config.wrcUrl, spec.name, config.tokenProvider, {
      stepId: step.id,
      provider: agent.provider,
      model: agent.model,
    })
    runtimeState.currentAgent = agent
  }

  const instruction = renderPrompt(step.instruction ?? '', {
    step,
    previousOutputs,
    workflowName: spec.name,
  })
  if (!runtimeState.workflowExecutionId) {
    throw new Error('CLERUM_WORKFLOW_RUN_ID is required for broker-backed custom coordinator steps')
  }
  const result = await mcpHost.executeAgentStep({
    stepId: step.id,
    instruction,
    mcpServers: step.mcpServers ?? [],
    allowedTools: step.allowedTools ?? step.tools ?? {},
    maxIterations: step.maxIterations,
    timeoutSeconds: step.timeoutSeconds,
    contextVars: {
      workflowExecutionId: runtimeState.workflowExecutionId,
      scenario: previousOutputs.prepare?.scenario ?? 'broker-backed-custom-coordinator',
      requestId: previousOutputs.prepare?.requestId ?? 'unknown',
    },
    ...(step.requiresApproval && { requiresApproval: step.requiresApproval }),
  })

  if (result.status === 'failed') {
    throw new Error(`mcp_host execute failed for step ${step.id}: ${result.error ?? 'unknown'}`)
  }

  const tools = summarizeToolCalls(result.toolsCalled)
  const mcpDataUsed = tools.length > 0
  return {
    brokerBacked: true,
    modelUsed: `${agent.provider}/${agent.model}`,
    mcpDataUsed,
    tools,
    output: result.output ?? '',
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
  }
}

async function runBusinessStep(
  step,
  spec,
  orderedSteps,
  previousOutputs,
  forbiddenCapabilityProbe,
  runtimeState,
  sdk
) {
  if (step.id === 'wait-for-token-rotation') {
    const initialDelayMs = Number(spec.inputs?.tokenRotationInitialDelayMs ?? 20000)
    const projectionDelayMs = Number(spec.inputs?.tokenRotationProjectionDelayMs ?? 75000)
    await sleep(initialDelayMs)
    await sdk.status.reportStepStatus(step.id, 'running', {
      executor: 'custom',
      output: {
        tokenRotationProbe: true,
        heartbeat: 'refresh-window-reached',
      },
    })
    await sleep(projectionDelayMs)
    return {
      tokenRotationProbe: true,
      waitedMs: initialDelayMs + projectionDelayMs,
      finalStatusUsesCurrentTokenFile: true,
    }
  }

  if (step.id === 'prepare') {
    const publicHttp = await probeRuntimeHttpEgress(spec)
    const declaredWorkload = await probeDeclaredWorkflowWorkload(spec)
    return {
      scenario: readContractDefault(spec, 'scenario', 'receivables-risk-reconciliation'),
      requestId: readContractDefault(spec, 'requestId', 'e2e-custom'),
      approvalThreshold: readContractDefault(spec, 'approvalThreshold', 1000),
      publicHttp,
      declaredWorkload,
      receivables: [
        { account: 'dao-alpha', outstandingAmount: 1280, daysOverdue: 64, disputes: 2 },
        { account: 'dao-beta', outstandingAmount: 420, daysOverdue: 9, disputes: 0 },
        { account: 'dao-gamma', outstandingAmount: 180, daysOverdue: 31, disputes: 1 },
      ],
      artifact: {
        name: '../unsafe-custom-sdk-result.json',
        format: 'json',
        path: '/etc/unsafe-custom-sdk-result.json',
        sizeBytes: -1,
      },
    }
  }

  if (hasBrokerBackedWork(step)) {
    return runBrokerBackedStep(step, spec, previousOutputs, runtimeState, sdk)
  }

  if (step.id === 'transform') {
    const prepared = previousOutputs.prepare
    const highRiskAccounts = prepared.receivables
      .filter(item => item.outstandingAmount >= prepared.approvalThreshold || item.disputes > 1)
      .map(item => item.account)
    const outstandingAmount = prepared.receivables.reduce(
      (sum, item) => sum + item.outstandingAmount,
      0
    )
    const weightedRiskScore = prepared.receivables.reduce(
      (sum, item) => sum + item.daysOverdue * item.disputes + item.outstandingAmount / 100,
      0
    )

    return {
      highRiskAccounts,
      outstandingAmount,
      weightedRiskScore: Number(weightedRiskScore.toFixed(2)),
      manualReviewRequired: highRiskAccounts.length > 0,
    }
  }

  if (step.id === 'emit') {
    if (previousOutputs['wait-for-token-rotation']) {
      const payload = {
        workflowName: spec.name,
        coordinatorImage: spec.coordinatorImage,
        orderedStepIds: orderedSteps.map(item => item.id),
        previousOutputKeys: Object.keys(previousOutputs),
        tokenRotationProbe: previousOutputs['wait-for-token-rotation'],
      }
      await fs.mkdir(path.dirname(ARTIFACT_PATH), { recursive: true })
      await fs.writeFile(ARTIFACT_PATH, JSON.stringify(payload, null, 2))
      const stat = await fs.stat(ARTIFACT_PATH)
      return {
        artifacts: [
          {
            name: ARTIFACT_NAME,
            format: 'json',
            sizeBytes: stat.size,
            path: ARTIFACT_PATH,
            createdAt: new Date().toISOString(),
          },
        ],
        payload,
      }
    }

    const brokerOutput = Object.values(previousOutputs).find(item => item?.brokerBacked)
    const payload = brokerOutput
      ? {
          workflowName: spec.name,
          coordinatorImage: spec.coordinatorImage,
          orderedStepIds: orderedSteps.map(item => item.id),
          previousOutputKeys: Object.keys(previousOutputs),
          unsafeArtifactAttempted: true,
          forbiddenCapabilityProbe,
          businessDecision: {
            scenario: previousOutputs.prepare.scenario,
            requestId: previousOutputs.prepare.requestId,
            approvalThreshold: previousOutputs.prepare.approvalThreshold,
            publicHttp: previousOutputs.prepare.publicHttp,
            declaredWorkload: previousOutputs.prepare.declaredWorkload,
          },
          brokerBacked: {
            modelUsed: brokerOutput.modelUsed,
            mcpDataUsed: brokerOutput.mcpDataUsed,
            tools: brokerOutput.tools,
            outputExcerpt: String(brokerOutput.output ?? '').slice(0, 500),
          },
        }
      : {
          workflowName: spec.name,
          coordinatorImage: spec.coordinatorImage,
          orderedStepIds: orderedSteps.map(item => item.id),
          previousOutputKeys: Object.keys(previousOutputs),
          unsafeArtifactAttempted: true,
          forbiddenCapabilityProbe,
          businessDecision: {
            scenario: previousOutputs.prepare.scenario,
            requestId: previousOutputs.prepare.requestId,
            publicHttp: previousOutputs.prepare.publicHttp,
            declaredWorkload: previousOutputs.prepare.declaredWorkload,
            highRiskAccounts: previousOutputs.transform.highRiskAccounts,
            outstandingAmount: previousOutputs.transform.outstandingAmount,
            weightedRiskScore: previousOutputs.transform.weightedRiskScore,
            manualReviewRequired: previousOutputs.transform.manualReviewRequired,
          },
        }
    const summary = [
      '# Custom Coordinator Broker Summary',
      '',
      `- workflow: ${spec.name}`,
      `- requestId: ${payload.businessDecision.requestId}`,
      `- brokerBacked: ${Boolean(brokerOutput)}`,
      `- mcpDataUsed: ${Boolean(payload.brokerBacked?.mcpDataUsed)}`,
      `- tools: ${(payload.brokerBacked?.tools ?? []).map(t => `${t.serverName}__${t.toolName}`).join(', ') || 'none'}`,
      '',
    ].join('\n')
    await fs.mkdir(path.dirname(ARTIFACT_PATH), { recursive: true })
    await fs.writeFile(ARTIFACT_PATH, JSON.stringify(payload, null, 2))
    if (brokerOutput) {
      await fs.writeFile(SUMMARY_ARTIFACT_PATH, summary)
    }
    const stat = await fs.stat(ARTIFACT_PATH)
    const artifacts = [
      {
        name: ARTIFACT_NAME,
        format: 'json',
        sizeBytes: stat.size,
        path: ARTIFACT_PATH,
        createdAt: new Date().toISOString(),
      },
    ]
    if (brokerOutput) {
      const summaryStat = await fs.stat(SUMMARY_ARTIFACT_PATH)
      artifacts.push({
        name: SUMMARY_ARTIFACT_NAME,
        format: 'md',
        sizeBytes: summaryStat.size,
        path: SUMMARY_ARTIFACT_PATH,
        createdAt: new Date().toISOString(),
      })
    }
    return {
      artifacts,
      payload,
    }
  }

  throw new Error(`unknown custom business step ${step.id}`)
}

async function main() {
  const sdk = await WorkflowSDK.fromEnvironment()
  const spec = await sdk.config.getSpec()
  const orderedSteps = sdk.coordinator.resolveOrder(spec.steps)
  const previousOutputs = {}
  const workflowRunId = process.env.CLERUM_WORKFLOW_RUN_ID?.trim()
  const workflowStartedAt = new Date().toISOString()
  const runtimeState = {
    currentAgent: null,
    workflowExecutionId: workflowRunId ? `${workflowRunId}:${spec.name}:${workflowStartedAt}` : '',
  }

  try {
    sdk.updatePhase('running')
    await sdk.status.reportWorkflowStatus('running')
    const forbiddenCapabilityProbe = await probeForbiddenWrcCapabilities(spec)

    for (const step of orderedSteps) {
      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      sdk.updateStepState(step.id, { phase: 'running' })
      await sdk.status.reportStepStatus(step.id, 'running', {
        executor: 'custom',
        startedAt,
      })

      const output = await runBusinessStep(
        step,
        spec,
        orderedSteps,
        previousOutputs,
        forbiddenCapabilityProbe,
        runtimeState,
        sdk
      )

      previousOutputs[step.id] = output
      sdk.updateStepState(step.id, { phase: 'completed', output })
      await sdk.status.reportStepStatus(step.id, 'completed', {
        output,
        executor: 'custom',
        durationMs: Date.now() - startedMs,
        completedAt: new Date().toISOString(),
      })
    }

    sdk.updatePhase('completed')
    await sdk.status.reportWorkflowStatus('completed', { completedAt: new Date().toISOString() })
    emitLog('info', 'Custom coordinator completed', { workflowName: spec.name })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sdk.updatePhase('failed')
    await sdk.status.reportWorkflowStatus('failed', { failureReason: message })
    emitLog('error', `Custom coordinator failed: ${message}`)
    process.exitCode = 1
  } finally {
    await sdk.shutdown()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
