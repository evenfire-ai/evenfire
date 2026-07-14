import { evaluateTaskBrake } from '../../budget/taskBrake'
import type {
  Attachment,
  ChatMessage,
  LoopResult,
  ReasoningContext,
  TokenUsage,
  ToolDefinition,
  ToolResult,
} from '../types'
import type { LoopConfig } from './loopConfig'
import {
  handleLoopErrorRecovery,
  hasToolResultForCurrentUserTurn,
  hasWorkflowListResultForCurrentUserTurn,
  hasWorkflowTriggerResultForCurrentUserTurn,
} from './toolUseLoopErrorRecovery'
import {
  isWorkflowArtifactIntent,
  isWorkflowListIntent,
  latestUserText,
  shouldRecoverWorkflowArtifactTextResponse,
  shouldRecoverWorkflowTriggerTextResponse,
} from './toolUseLoopIntentRecovery'
import { validateToolLinkages } from './toolUseLoopLinkages'
import { appendToolResults } from './toolUseLoopMessages'
import {
  callReasoningForIteration,
  exhaustionResult,
  manageMessagesForIteration,
  responseResult,
  taskBrakeResult,
} from './toolUseLoopRuntime'
import { executeToolCalls } from './toolUseLoopToolBatch'
import {
  buildWorkflowListFallbackWhenResponseOmitsNames,
  buildWorkflowToolFailureResponse,
  buildWorkflowToolSuccessFallbackResponse,
  isWorkflowSuccessFallbackToolName,
} from './toolUseLoopWorkflowFallbacks'
import {
  buildWorkflowTriggerImmediateFallbackResponse,
  buildWorkflowTriggerNonRunFallbackWhenResponseOmitsClarification,
} from './toolUseLoopWorkflowTriggerFallbacks'

export { executeSingleTool } from './toolUseLoopSingleTool'
export { buildOutputPreview, extractInputPreview } from './toolUseLoopPreviews'
export { validateToolLinkages } from './toolUseLoopLinkages'

/**
 * The tool-use loop: the central algorithm of the agent.
 *
 * This function does not build prompts or interpret model semantics. It executes
 * tools, preserves tool-result linkages, manages context pressure, and applies
 * deterministic workflow fallbacks when the model cannot safely summarize tool output.
 */
export async function runToolUseLoop(
  config: LoopConfig,
  initialMessages: ChatMessage[],
  jobDescription?: string
): Promise<LoopResult> {
  const { toolRegistry, loopController, maxIterations } = config
  let messages = [...initialMessages]
  const totalUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  }
  let lastToolResults: ToolResult[] | null = null
  let lastCompletedToolResultsForFallback: ToolResult[] | null = null
  let emptyResponseAfterToolResultsRecovered = false
  let emptyInitialResponseRecovered = false
  let workflowListTextResponseRecovered = false
  let workflowArtifactIntentRecovered = false
  let workflowArtifactTextResponseRecovered = false
  let workflowTriggerTextResponseRecovered = false
  let workflowTriggerAfterListTextResponseRecovered = false
  const collectedAttachments: Attachment[] = []
  const userRequestText = latestUserText(initialMessages)

  const initialTools = toolRegistry.listDefinitions()
  console.log(
    `[NewCore:Loop] START → maxIter=${maxIterations}, tools=${initialTools.length}, messages=${initialMessages.length}`
  )

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (config.abortSignal?.aborted) return { type: 'cancelled', reason: 'signal_aborted' }

    // P2 token budgets (§5.2) — per-task emergency brake. Local, no network:
    // compares THIS task's token delta (current counters − the start-of-task
    // baseline) against the cap from the P1 verdict and exits BEFORE the next
    // LLM call (never interrupts a call in flight). On iteration 0 the delta is
    // 0, so the first call always proceeds. No-op when no cap is configured.
    if (config.taskBrake) {
      const trip = evaluateTaskBrake(config.taskBrake, config.conversation)
      if (trip) return taskBrakeResult(config, iteration, trip, collectedAttachments)
    }

    config.events.emit({
      type: 'loop:iteration',
      data: { iteration, messageCount: messages.length },
      timestamp: new Date(),
    })

    messages = await manageMessagesForIteration(config, messages, iteration, true)

    let tools: ToolDefinition[]
    try {
      tools = await loopController.refreshTools(toolRegistry.listDefinitions())
    } catch {
      tools = toolRegistry.listDefinitions()
    }

    const context: ReasoningContext = {
      messages,
      available_tools: tools,
      job_description: jobDescription,
      signal: config.abortSignal,
    }

    const { result, continuingFromToolResults } = await callReasoningForIteration(
      config,
      context,
      lastToolResults,
      iteration
    )
    if (continuingFromToolResults) lastToolResults = null
    if (config.abortSignal?.aborted) return { type: 'cancelled', reason: 'signal_aborted' }

    switch (result.type) {
      case 'text': {
        if (config.abortSignal?.aborted) return { type: 'cancelled', reason: 'signal_aborted' }

        const workflowListFallback = continuingFromToolResults
          ? buildWorkflowListFallbackWhenResponseOmitsNames(
              result.content,
              lastCompletedToolResultsForFallback
            )
          : null
        if (workflowListFallback) {
          return responseResult(
            config,
            iteration,
            workflowListFallback,
            totalUsage,
            collectedAttachments,
            `[NewCore:Loop] EXIT → workflow_list deterministic fallback, iterations=${iteration + 1}`
          )
        }

        const workflowTriggerNonRunFallback = continuingFromToolResults
          ? buildWorkflowTriggerNonRunFallbackWhenResponseOmitsClarification(
              result.content,
              lastCompletedToolResultsForFallback
            )
          : null
        if (workflowTriggerNonRunFallback) {
          return responseResult(
            config,
            iteration,
            workflowTriggerNonRunFallback,
            totalUsage,
            collectedAttachments,
            `[NewCore:Loop] EXIT → workflow_trigger non-run deterministic fallback, iterations=${iteration + 1}`
          )
        }

        const completedWorkflowListThisTurn =
          Array.isArray(lastCompletedToolResultsForFallback) &&
          lastCompletedToolResultsForFallback.some(result => result.name === 'workflow_list')
        if (
          continuingFromToolResults &&
          !workflowTriggerAfterListTextResponseRecovered &&
          !hasWorkflowTriggerResultForCurrentUserTurn(messages) &&
          completedWorkflowListThisTurn &&
          shouldRecoverWorkflowTriggerTextResponse(userRequestText, result.content)
        ) {
          workflowTriggerAfterListTextResponseRecovered = true
          console.log(
            `[NewCore:Loop] iter=${iteration} → recovering workflow trigger text response after workflow_list`
          )
          messages.push({ role: 'assistant', content: result.content })
          messages.push({
            role: 'user',
            content:
              'The previous assistant response listed or described workflows but did not trigger the requested workflow. The user asked to run a named workflow recipe and provided any business inputs in the original message. Call workflow_trigger for that workflow with those inputs when it is available, or use workflow tools to prove it is not available. Do not only summarize workflow_list.',
          })
          continue
        }

        if (
          !continuingFromToolResults &&
          !emptyResponseAfterToolResultsRecovered &&
          !emptyInitialResponseRecovered &&
          !workflowListTextResponseRecovered &&
          isWorkflowListIntent(userRequestText) &&
          tools.some(tool => tool.name === 'workflow_list') &&
          !hasToolResultForCurrentUserTurn(messages) &&
          !hasWorkflowListResultForCurrentUserTurn(messages)
        ) {
          workflowListTextResponseRecovered = true
          console.log(
            `[NewCore:Loop] iter=${iteration} → recovering workflow list text response without tool call`
          )
          messages.push({ role: 'assistant', content: result.content })
          messages.push({
            role: 'user',
            content:
              'The previous assistant response answered a workflow recipe list request without calling workflow_list. Use workflow_list now and answer only from its current results. Do not reuse prior conversation workflow names.',
          })
          continue
        }

        if (
          !continuingFromToolResults &&
          !workflowTriggerTextResponseRecovered &&
          !hasWorkflowTriggerResultForCurrentUserTurn(messages) &&
          shouldRecoverWorkflowTriggerTextResponse(userRequestText, result.content)
        ) {
          workflowTriggerTextResponseRecovered = true
          console.log(
            `[NewCore:Loop] iter=${iteration} → recovering workflow trigger text response without tool call`
          )
          messages.push({ role: 'assistant', content: result.content })
          messages.push({
            role: 'user',
            content:
              'The previous assistant response did not trigger the requested workflow. The user asked to trigger a workflow recipe by name. Use workflow_trigger for the requested workflow and target when it is available, or use the workflow tools to prove that it is not available. Do not create or report a workflow run without workflow_trigger.',
          })
          continue
        }

        if (
          !continuingFromToolResults &&
          !workflowArtifactTextResponseRecovered &&
          shouldRecoverWorkflowArtifactTextResponse(userRequestText)
        ) {
          workflowArtifactTextResponseRecovered = true
          console.log(
            `[NewCore:Loop] iter=${iteration} → recovering workflow artifact text response without tool call`
          )
          messages.push({ role: 'assistant', content: result.content })
          messages.push({
            role: 'user',
            content:
              'The previous assistant response did not retrieve the requested workflow result artifact. The user asked for an existing workflow result artifact by name. Use workflow_result for the named workflow, or use the workflow tools to prove that it is unavailable. Do not invent artifact URLs, proof values, or run outputs.',
          })
          continue
        }

        if (loopController.shouldAccept(result.content, iteration)) {
          return responseResult(
            config,
            iteration,
            result.content,
            totalUsage,
            collectedAttachments,
            `[NewCore:Loop] EXIT → response (text, ${result.content.length} chars), iterations=${iteration + 1}`
          )
        }

        const nudgeMsg = loopController.onTextRejected(result.content, iteration)
        if (nudgeMsg) messages.push({ role: 'assistant', content: result.content }, nudgeMsg)
        continue
      }

      case 'tool_calls': {
        const toolNames = result.calls.map(c => c.name).join(', ')
        console.log(`[NewCore:Loop] iter=${iteration} → tool_calls: [${toolNames}]`)

        if (
          isWorkflowListIntent(userRequestText) &&
          result.calls.some(call => call.name === 'workflow_trigger')
        ) {
          const workflowListFallback = buildWorkflowToolSuccessFallbackResponse(
            lastCompletedToolResultsForFallback
          )
          if (workflowListFallback) {
            return responseResult(
              config,
              iteration,
              workflowListFallback,
              totalUsage,
              collectedAttachments,
              `[NewCore:Loop] EXIT → workflow_list deterministic fallback before mistaken trigger, iterations=${iteration + 1}`
            )
          }

          messages.push({
            role: 'user',
            content:
              'The user asked to list workflow recipes, not trigger one. Do not call workflow_trigger for workflow availability questions. Use workflow_list and answer only from its results.',
          })
          continue
        }

        if (
          !workflowArtifactIntentRecovered &&
          isWorkflowArtifactIntent(userRequestText) &&
          result.calls.some(call => call.name === 'workflow_trigger')
        ) {
          workflowArtifactIntentRecovered = true
          messages.push({
            role: 'user',
            content:
              'The previous tool choice would trigger a workflow, but the user asked for an existing workflow result artifact. Do not call workflow_trigger for result, artifact, output, or download requests. Use workflow_result for the named workflow.',
          })
          continue
        }

        messages.push({
          role: 'assistant',
          content: result.content ?? '',
          tool_calls: result.calls,
        })

        const { toolResults, pendingApproval, cancelled } = await executeToolCalls(
          result.calls,
          config,
          iteration,
          messages,
          result.content,
          result.usage
        )
        if (cancelled) return { type: 'cancelled', reason: 'signal_aborted' }
        if (pendingApproval) {
          if (collectedAttachments.length > 0) {
            pendingApproval.attachments = [
              ...(pendingApproval.attachments ?? []),
              ...collectedAttachments,
            ]
          }
          return { type: 'need_approval', approval: pendingApproval }
        }

        const workflowFallbackResults = toolResults.filter(
          tr => tr.is_error !== true && isWorkflowSuccessFallbackToolName(tr.name)
        )
        if (workflowFallbackResults.length > 0) {
          lastCompletedToolResultsForFallback = workflowFallbackResults
        }

        const workflowTriggerImmediateFallback =
          buildWorkflowTriggerImmediateFallbackResponse(toolResults)
        if (workflowTriggerImmediateFallback) {
          return responseResult(
            config,
            iteration,
            workflowTriggerImmediateFallback,
            totalUsage,
            collectedAttachments,
            `[NewCore:Loop] EXIT → workflow_trigger deterministic fallback, iterations=${iteration + 1}`
          )
        }

        const workflowToolFailureResponse = buildWorkflowToolFailureResponse(toolResults)
        if (workflowToolFailureResponse) {
          return responseResult(
            config,
            iteration,
            workflowToolFailureResponse,
            totalUsage,
            collectedAttachments,
            `[NewCore:Loop] EXIT → workflow tool failure response, iterations=${iteration + 1}`
          )
        }

        appendToolResults(messages, toolResults, collectedAttachments)
        lastToolResults = toolResults
        messages = await manageMessagesForIteration(config, messages, iteration)
        validateToolLinkages(messages)
        continue
      }

      case 'need_approval':
        console.log(`[NewCore:Loop] EXIT → need_approval, iterations=${iteration + 1}`)
        return { type: 'need_approval', approval: result.approval }
      case 'error': {
        const recovery = handleLoopErrorRecovery({
          error: result.error,
          continuingFromToolResults,
          emptyResponseAfterToolResultsRecovered,
          emptyInitialResponseRecovered,
          workflowTriggerTextResponseRecovered,
          lastCompletedToolResultsForFallback,
          messages,
          iteration,
          userRequestText,
        })

        if (recovery.type === 'continue') {
          emptyResponseAfterToolResultsRecovered =
            recovery.emptyResponseAfterToolResultsRecovered ??
            emptyResponseAfterToolResultsRecovered
          emptyInitialResponseRecovered =
            recovery.emptyInitialResponseRecovered ?? emptyInitialResponseRecovered
          workflowTriggerTextResponseRecovered =
            recovery.workflowTriggerTextResponseRecovered ?? workflowTriggerTextResponseRecovered
          messages = recovery.messages
          console.log(`[NewCore:Loop] iter=${iteration} → recovering from LLM error`)
          continue
        }

        if (recovery.type === 'response') {
          return responseResult(
            config,
            iteration,
            recovery.content,
            totalUsage,
            collectedAttachments,
            recovery.logMessage
          )
        }

        console.log(
          `[NewCore:Loop] EXIT → error: ${result.error.message}, iterations=${iteration + 1}`
        )
        return { type: 'error', error: result.error }
      }
    }
  }

  return exhaustionResult(
    config,
    maxIterations,
    loopController.onExhaustion(maxIterations),
    collectedAttachments
  )
}
