import { describe, expect, it } from 'vitest'
import { validateBaseUrls } from './e2e-playwright/global-setup'

const DEV_CONTEXT = 'gke_your-gcp-project_us-central1-a_example-dev'

describe('validateBaseUrls', () => {
  it('requires localhost for clerum-test', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-test',
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'https://dev.example.com',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        allowDevPortForward: false,
      })
    ).toThrow(/local minikube context=clerum-test requires localhost URLs/)
  })

  it('allows generated branch minikube profile URLs through localhost port-forwards', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-figure-b-sandbox-mcphost-mitigation-5bd8cfa5',
        controlApiUrl: 'http://127.0.0.1:35784',
        externalRestUrl: 'http://127.0.0.1:35785',
        rpcProxyUrl: 'http://localhost:35788',
        allowDevPortForward: false,
      })
    ).not.toThrow()
  })

  it('rejects non-localhost urls for generated branch minikube profiles', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-figure-b-sandbox-mcphost-mitigation-5bd8cfa5',
        controlApiUrl: 'http://127.0.0.1:35784',
        externalRestUrl: 'https://profiles.dev.example.com',
        rpcProxyUrl: 'http://127.0.0.1:35788',
        allowDevPortForward: false,
      })
    ).toThrow(
      /local minikube context=clerum-codex-figure-b-sandbox-mcphost-mitigation-5bd8cfa5 requires localhost URLs/
    )
  })

  it('allows explicit dev port-forward mode for example-dev', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: DEV_CONTEXT,
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'http://127.0.0.1:8091',
        rpcProxyUrl: 'http://localhost:8094',
        allowDevPortForward: true,
      })
    ).not.toThrow()
  })

  it('allows random localhost ports for branch-scoped minikube contexts', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-workflow-output-rwo-affinity-39eec1ac',
        controlUiUrl: 'http://127.0.0.1:33300',
        controlApiUrl: 'http://127.0.0.1:33330',
        externalRestUrl: 'http://127.0.0.1:33331',
        rpcProxyUrl: 'http://localhost:33334',
        workflowApprovalReaderUrl: 'http://127.0.0.1:33338',
        allowDevPortForward: true,
      })
    ).not.toThrow()
  })

  it('rejects shared default ports for branch-scoped minikube contexts', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-codex-workflow-output-rwo-affinity-39eec1ac',
        controlUiUrl: 'http://127.0.0.1:3000',
        controlApiUrl: 'http://127.0.0.1:33330',
        externalRestUrl: 'http://127.0.0.1:33331',
        rpcProxyUrl: 'http://127.0.0.1:33334',
        allowDevPortForward: true,
      })
    ).toThrow(/CONTROL_UI_BASE_URL/)
  })

  it('rejects non-localhost urls when dev port-forward mode is enabled', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: DEV_CONTEXT,
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'https://profiles.dev.example.com',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        allowDevPortForward: true,
      })
    ).toThrow(/E2E_ALLOW_DEV_PORT_FORWARD=1 requires localhost URLs/)
  })

  it('validates workflow approval reader URL when the quadrants suite provides it', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: 'clerum-test',
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'http://127.0.0.1:8091',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        workflowApprovalReaderUrl: 'https://reader.example.com',
        allowDevPortForward: false,
      })
    ).toThrow(/WORKFLOW_APPROVAL_READER_BASE_URL/)
  })

  it('rejects localhost on example-dev without explicit opt-in', () => {
    expect(() =>
      validateBaseUrls({
        expectedContext: DEV_CONTEXT,
        controlApiUrl: 'http://127.0.0.1:8090',
        externalRestUrl: 'http://127.0.0.1:8091',
        rpcProxyUrl: 'http://127.0.0.1:8094',
        allowDevPortForward: false,
      })
    ).toThrow(/requires non-localhost URLs/)
  })
})
