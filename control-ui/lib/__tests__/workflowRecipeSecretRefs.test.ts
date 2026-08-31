import { describe, expect, it } from 'vitest'
import { collectWorkflowRecipeSecretRefs } from '../workflowRecipeSecretRefs'

describe('collectWorkflowRecipeSecretRefs', () => {
  it('collects workload envSecret, snippet secretRef, and OAuth client refs', () => {
    const refs = collectWorkflowRecipeSecretRefs({
      workloads: [
        {
          id: 'api',
          envSecret: {
            name: 'workflow-api-credentials',
            keys: [
              { secretKey: 'apiKey', envVar: 'API_KEY' },
              { secretKey: 'dbPassword', envVar: 'DB_PASSWORD' },
            ],
          },
        },
      ],
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            capabilities: {
              secrets: [{ secretRef: { name: 'snippet-creds', key: 'token' } }],
            },
          },
        },
      ],
      oauthClients: [
        {
          id: 'github',
          clientIdRef: { name: 'github-oauth', key: 'clientId' },
          clientSecretRef: { name: 'github-oauth', key: 'clientSecret' },
        },
      ],
    })

    expect(
      [...refs.values()].map(ref => [ref.namespace, ref.secretName, [...ref.keys].sort()])
    ).toEqual([
      ['sandbox-recipes', 'workflow-api-credentials', ['apiKey', 'dbPassword']],
      ['sandbox-recipes', 'snippet-creds', ['token']],
      ['sandbox-recipes', 'github-oauth', ['clientId', 'clientSecret']],
    ])
  })

  it('keeps transport and UI workload envSecret refs in their runtime namespaces', () => {
    const refs = collectWorkflowRecipeSecretRefs({
      ui: { workloadRef: 'frontend' },
      workloads: [
        {
          id: 'transport',
          transport: { type: 'streamableHttp', path: '/mcp' },
          envSecret: {
            name: 'transport-creds',
            keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
          },
        },
        {
          id: 'frontend',
          envSecret: {
            name: 'ui-creds',
            keys: [{ secretKey: 'token', envVar: 'TOKEN' }],
          },
        },
      ],
    })

    expect([...refs.values()].map(ref => [ref.namespace, ref.secretName, [...ref.keys]])).toEqual([
      ['mcp-server', 'transport-creds', ['apiKey']],
      ['sandbox-ui', 'ui-creds', ['token']],
    ])
  })

  it('does not invent an LLM Secret for a Codex-only agent, even if secretRef is leftover', () => {
    const refs = collectWorkflowRecipeSecretRefs({
      agent: {
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        secretRef: { name: 'codex-oauth', key: 'refreshToken' },
      },
      steps: [{ id: 'draft', instruction: 'Write a note' }],
    })
    expect([...refs.values()]).toEqual([])
  })

  it('collects an agent secretRef only when the agent uses static credentials', () => {
    const refs = collectWorkflowRecipeSecretRefs({
      agent: {
        provider: 'openai',
        model: 'gpt-5.4',
        secretRef: { name: 'openai-llm', key: 'openai-api-key' },
      },
    })
    expect([...refs.values()].map(ref => [ref.namespace, ref.secretName, [...ref.keys]])).toEqual([
      ['sandbox-recipes', 'openai-llm', ['openai-api-key']],
    ])
  })
})
