import { describe, expect, it } from 'vitest'
import * as runtimeCore from '@clerum/workflow-runtime-core'
import {
  ConfigLoader,
  CycleDetectedError,
  McpHostClient,
  McpHostNotConfiguredError,
  SignalPoller,
  StatusReporter,
  StepCoordinator,
  WorkflowSDKInitError,
  computeBackoff,
  createFileRuntimeTokenProvider,
  createServer,
  createStaticRuntimeTokenProvider,
  emitLog,
  initLogger,
  loadSoul,
  renderPrompt,
  requestModelInjection,
  requireRuntimeToken,
  safeEqual,
  start,
  stop,
  withRetry,
} from '../../src'
import { sendWithAuthRetryOn401 } from '../../src/status-reporter/authRetry'

describe('@clerum/workflow-sdk facade', () => {
  it('reexports runtime protocol primitives from workflow-runtime-core for compatibility', () => {
    expect(ConfigLoader).toBe(runtimeCore.ConfigLoader)
    expect(SignalPoller).toBe(runtimeCore.SignalPoller)
    expect(StepCoordinator).toBe(runtimeCore.StepCoordinator)
    expect(StatusReporter).toBe(runtimeCore.StatusReporter)
    expect(McpHostClient).toBe(runtimeCore.McpHostClient)
    expect(renderPrompt).toBe(runtimeCore.renderPrompt)
    expect(loadSoul).toBe(runtimeCore.loadSoul)
    expect(requestModelInjection).toBe(runtimeCore.requestModelInjection)
    expect(createFileRuntimeTokenProvider).toBe(runtimeCore.createFileRuntimeTokenProvider)
    expect(createStaticRuntimeTokenProvider).toBe(runtimeCore.createStaticRuntimeTokenProvider)
    expect(requireRuntimeToken).toBe(runtimeCore.requireRuntimeToken)
    expect(withRetry).toBe(runtimeCore.withRetry)
    expect(computeBackoff).toBe(runtimeCore.computeBackoff)
    expect(emitLog).toBe(runtimeCore.emitLog)
    expect(initLogger).toBe(runtimeCore.initLogger)
    expect(createServer).toBe(runtimeCore.createServer)
    expect(start).toBe(runtimeCore.start)
    expect(stop).toBe(runtimeCore.stop)
    expect(safeEqual).toBe(runtimeCore.safeEqual)
    expect(CycleDetectedError).toBe(runtimeCore.CycleDetectedError)
    expect(WorkflowSDKInitError).toBe(runtimeCore.WorkflowSDKInitError)
    expect(McpHostNotConfiguredError).toBe(runtimeCore.McpHostNotConfiguredError)
  })

  it('keeps internal compatibility shims wired to workflow-runtime-core', () => {
    expect(sendWithAuthRetryOn401).toBe(runtimeCore.sendWithAuthRetryOn401)
  })
})
