import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import type { WorkflowRecipeResource } from '../../lib/api'
import { validateRecipe } from '../../lib/recipeValidator'
import { RecipeEditor } from '../RecipeEditor'
import { ToastProvider } from '../Toast'

// vi.mock is hoisted before imports, factory runs lazily
vi.mock('../../lib/api', () => ({
  createRecipe: vi
    .fn()
    .mockResolvedValue({ metadata: { name: 'new-recipe', namespace: 'sandbox-recipes' } }),
  updateRecipe: vi.fn().mockResolvedValue({ metadata: { name: 'existing' } }),
  apiSend: vi.fn().mockResolvedValue({}),
  // Recipe-secret namespaces fetched on editor mount; bare defaults preserve
  // single-tenant behavior assumed by these tests.
  getControlUINamespaces: vi
    .fn()
    .mockResolvedValue({ sandbox: 'sandbox-recipes', mcpServer: 'mcp-server' }),
  // L2 pre-flight — tests override per-scenario.
  validateRecipeServer: vi.fn().mockResolvedValue({ valid: true }),
  // Grants — tests override per-scenario.
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
  getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
  listWorkflowGrants: vi.fn().mockResolvedValue({ items: [] }),
  listWorkflowTeamGrants: vi.fn().mockResolvedValue({ items: [] }),
  listWorkflowApprovalAllowedTeams: vi.fn().mockResolvedValue({ items: [] }),
  setWorkflowGrants: vi.fn().mockResolvedValue({ userIds: [] }),
  setWorkflowTeamGrants: vi.fn().mockResolvedValue({ teamIds: [], added: [], removed: [] }),
  allowWorkflowApprovalTeam: vi.fn().mockResolvedValue({ teamId: 'team-1' }),
  revokeWorkflowApprovalTeam: vi.fn().mockResolvedValue({ teamId: 'team-1' }),
}))

const VALID_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'my-recipe' },
    spec: { workloads: [{ id: 'api', type: 'deployment', image: 'my-api:latest' }] },
  },
  null,
  2
)

const INVALID_NAME_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'MyBadName' }, // uppercase — RFC1123 violation
    spec: { workloads: [{ id: 'w', type: 'deployment', image: 'x' }] },
  },
  null,
  2
)

const SNIPPET_SECRET_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'snippet-secret-recipe' },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user', 'autonomous'] } },
      steps: [
        {
          id: 'fetch-price',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'coingecko_api_key',
                  secretRef: { name: 'coingecko-api', key: 'apiKey' },
                },
              ],
            },
          },
        },
        {
          id: 'reuse-secret',
          dependsOn: ['fetch-price'],
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { reused: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'coingecko_api_key',
                  secretRef: { name: 'coingecko-api', key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
    },
  },
  null,
  2
)

const WORKLOAD_ENV_SECRET_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'workload-secret-recipe' },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user', 'autonomous'] } },
      workloads: [
        {
          id: 'postgres',
          type: 'statefulset',
          image: 'postgres:16',
          env: [{ name: 'POSTGRES_USER', value: 'clerum' }],
          envSecret: {
            name: 'postgres-credentials',
            keys: [
              { secretKey: 'password', envVar: 'POSTGRES_PASSWORD' },
              { secretKey: 'databaseUrl', envVar: 'DATABASE_URL' },
            ],
          },
        },
      ],
      steps: [
        {
          id: 'load',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'POSTGRES_PASSWORD',
                  secretRef: { name: 'postgres-credentials', key: 'password' },
                },
              ],
            },
          },
        },
      ],
    },
  },
  null,
  2
)

const OAUTH_CLIENT_SECRET_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'oauth-client-secret-recipe' },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user', 'autonomous'] } },
      oauthClients: [
        {
          id: 'github',
          clientIdRef: { name: 'github-oauth', key: 'clientId' },
          clientSecretRef: { name: 'github-oauth', key: 'clientSecret' },
        },
      ],
      steps: [
        {
          id: 'exchange',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
          },
        },
      ],
    },
  },
  null,
  2
)

const TRANSPORT_WORKLOAD_ENV_SECRET_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'transport-workload-secret-recipe' },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user', 'autonomous'] } },
      workloads: [
        {
          id: 'mock-tools',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          transport: { type: 'streamableHttp' },
          envSecret: {
            name: 'shared-credentials',
            keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
          },
        },
      ],
      steps: [
        {
          id: 'fetch-price',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'api_key',
                  secretRef: { name: 'shared-credentials', key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
    },
  },
  null,
  2
)

const SANDBOX_UI_WORKLOAD_ENV_SECRET_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'ui-workload-secret-recipe' },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user', 'autonomous'] } },
      ui: { workloadRef: 'frontend' },
      workloads: [
        {
          id: 'frontend',
          type: 'deployment',
          image: 'clerum/sandbox-ui-fixture:test',
          envSecret: {
            name: 'ui-credentials',
            keys: [{ secretKey: 'token', envVar: 'UI_TOKEN' }],
          },
        },
      ],
      steps: [
        {
          id: 'render',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
          },
        },
      ],
    },
  },
  null,
  2
)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

function reviewManifestButton(): HTMLButtonElement {
  const matches = screen.getAllByRole('button', { name: 'Review manifest' })
  const button = matches.at(-1)
  if (!button) throw new Error('Review manifest button not found')
  return button as HTMLButtonElement
}

function clickReviewManifest() {
  fireEvent.click(reviewManifestButton())
}

function proceedToDeploy() {
  fireEvent.click(screen.getByText('Apply defaults'))
  fireEvent.click(screen.getByText('Continue to access'))
}

function reviewAndProceedToDeploy() {
  clickReviewManifest()
  proceedToDeploy()
}

describe('RecipeEditor — render', () => {
  it("shows 'Install Plugin' title in create mode", () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Install Plugin')).toBeInTheDocument()
  })

  it("shows 'Edit Plugin: name' title in edit mode", () => {
    const initial: WorkflowRecipeResource = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'existing', namespace: 'sandbox-recipes' },
      spec: {},
    }
    render(<RecipeEditor initial={initial} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/Edit Plugin: existing/)).toBeInTheDocument()
  })

  it('renders textarea with example JSON containing apiVersion', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    expect((textarea as HTMLTextAreaElement).value).toContain('clerum.io/v1alpha1')
  })

  it('loads web-search templates with public-web egress and no arbitrary fetch tool', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const templateSelect = screen.getByRole('combobox')
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    for (const label of [
      'Agentic Workflow (PDF Report)',
      'Layer 3A Snippet Hybrid Agentic',
      'Competitive Intel Report (PDF)',
      'Market Data Dashboard (Excel)',
      'Due Diligence Package (PDF+Excel)',
    ]) {
      fireEvent.change(templateSelect, { target: { value: label } })
      const parsed = JSON.parse(textarea.value) as {
        spec: {
          workloads: Array<{
            id: string
            env?: Array<{ name: string; value: string }>
            egressBindings?: Array<{ dns: string; port: number; protocol?: string }>
          }>
        }
      }
      const webSearch = parsed.spec.workloads.find(workload => workload.id === 'web-search')
      expect(webSearch?.env).toEqual(
        expect.arrayContaining([
          { name: 'DEFAULT_SEARCH_ENGINE', value: 'duckduckgo' },
          { name: 'ALLOWED_SEARCH_ENGINES', value: 'duckduckgo' },
        ])
      )
      expect(webSearch?.egressBindings).toEqual(
        expect.arrayContaining([{ egressClass: 'public-web' }])
      )
      expect(textarea.value).toContain('"web-search__search"')
      expect(textarea.value).not.toContain('"web-search__fetchWebContent"')
      expect(textarea.value).not.toContain('"web-search__fetch"')
      expect(textarea.value).not.toContain('"web-search__fetch_page"')
      expect(textarea.value).not.toContain('"web-search__search_news"')
    }
  })

  it('loads templates with production-safe step timeout defaults', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const templateSelect = screen.getByRole('combobox')
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    for (const label of [
      'Agentic Workflow (PDF Report)',
      'Agentic Workload Template Resolution',
      'Layer 3A Snippet Direct DB',
      'Layer 3A Snippet Hybrid Agentic',
      'Market Data Dashboard (Excel)',
      'Due Diligence Package (PDF+Excel)',
    ]) {
      fireEvent.change(templateSelect, { target: { value: label } })
      const parsed = JSON.parse(textarea.value) as {
        spec: { steps: Array<{ timeoutSeconds: number }> }
      }
      expect(parsed.spec.steps.every(step => step.timeoutSeconds >= 600)).toBe(true)
    }

    fireEvent.change(templateSelect, { target: { value: 'Competitive Intel Report (PDF)' } })
    const competitive = JSON.parse(textarea.value) as {
      spec: { steps: Array<{ timeoutSeconds: number }> }
    }
    expect(competitive.spec.steps.every(step => step.timeoutSeconds === 1800)).toBe(true)
  })

  it('loads every runnable workflow template with an on-demand trigger for Control UI and Desktop runs', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const templateSelect = screen.getByRole('combobox') as HTMLSelectElement
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    const labels = Array.from(templateSelect.options)
      .map(option => option.value)
      .filter(Boolean)

    for (const label of labels) {
      fireEvent.change(templateSelect, { target: { value: label } })
      const parsed = JSON.parse(textarea.value) as {
        spec: { steps?: unknown[]; triggers?: { onDemand?: { allowedActors?: string[] } } }
      }
      if (!Array.isArray(parsed.spec.steps) || parsed.spec.steps.length === 0) continue
      expect(parsed.spec.triggers?.onDemand).toBeDefined()
      expect(parsed.spec.triggers?.onDemand?.allowedActors).toEqual(
        expect.arrayContaining(['user', 'autonomous'])
      )
    }
  })

  it('loads templates that pass client-side WorkflowRecipe validation', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const templateSelect = screen.getByRole('combobox')
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    for (const label of [
      'MongoDB MCP Stack (Workload)',
      'Agentic Workflow (PDF Report)',
      'Agentic Workload Template Resolution',
      'Layer 3A Snippet Direct DB',
      'Layer 3A Snippet Hybrid Agentic',
      'Competitive Intel Report (PDF)',
      'Market Data Dashboard (Excel)',
      'Due Diligence Package (PDF+Excel)',
    ]) {
      fireEvent.change(templateSelect, { target: { value: label } })
      expect(
        validateRecipe(textarea.value).issues.filter(issue => issue.severity === 'error')
      ).toEqual([])
    }
  })

  it('loads #231 and visible Layer 3A templates without valueFrom.template', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const templateSelect = screen.getByRole('combobox')
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    const labels = [
      'Agentic Workload Template Resolution',
      'Layer 3A Snippet Direct DB',
      'Layer 3A Snippet Hybrid Agentic',
    ]

    for (const label of labels) {
      fireEvent.change(templateSelect, { target: { value: label } })
      const parsed = JSON.parse(textarea.value) as { spec: Record<string, unknown> }
      expect(textarea.value).not.toContain('valueFrom')
      expect(textarea.value).not.toContain('valueFrom.template')
      expect(parsed.spec.steps).toBeDefined()
    }

    fireEvent.change(templateSelect, { target: { value: 'Agentic Workload Template Resolution' } })
    const agenticTemplate = JSON.parse(textarea.value) as {
      spec: { workloads: Array<{ id: string; security?: Record<string, number> }> }
    }
    expect(textarea.value).toContain('{{postgres:host}}')
    expect(textarea.value).toContain('{{postgres:port}}')
    expect(textarea.value).toContain('{{inputs.db_name}}')
    expect(agenticTemplate.spec.workloads.find(w => w.id === 'postgres')?.security).toEqual({
      runAsUser: 70,
      runAsGroup: 70,
      fsGroup: 70,
    })
  })

  it('hides Layer 3B local-image templates unless local templates are enabled', () => {
    const deterministic = 'Layer 3B Custom Coordinator - Deterministic (Advanced, Local Images)'
    const brokerBacked = 'Layer 3B Custom Coordinator - Broker Backed (Advanced, Local Images)'

    vi.stubEnv('NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES', 'false')
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('option', { name: deterministic })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: brokerBacked })).not.toBeInTheDocument()

    cleanup()
    vi.stubEnv('NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES', 'true')
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)

    const templateSelect = screen.getByRole('combobox')
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(screen.getByRole('option', { name: deterministic })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: brokerBacked })).toBeInTheDocument()

    for (const label of [deterministic, brokerBacked]) {
      fireEvent.change(templateSelect, { target: { value: label } })
      const parsed = JSON.parse(textarea.value) as {
        spec: {
          coordinatorImage?: string
          triggers?: { onDemand?: { allowedActors?: string[] } }
        }
      }
      expect(parsed.spec.coordinatorImage).toBe('clerum/workflow-custom-sdk-e2e:test')
      expect(parsed.spec.triggers?.onDemand?.allowedActors).toEqual(
        expect.arrayContaining(['user', 'autonomous'])
      )
      expect(textarea.value).toContain('requires locally built')
      expect(textarea.value).not.toContain('valueFrom')
      expect(textarea.value).not.toContain('valueFrom.template')
      expect(
        validateRecipe(textarea.value).issues.filter(issue => issue.severity === 'error')
      ).toEqual([])
    }
  })

  it('renders textarea pre-filled with initial recipe name in edit mode', () => {
    const initial: WorkflowRecipeResource = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'existing' },
      spec: {},
    }
    render(<RecipeEditor initial={initial} onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    expect((textarea as HTMLTextAreaElement).value).toContain('"existing"')
  })

  it('shows Review manifest button', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(reviewManifestButton()).toBeInTheDocument()
  })

  it('shows Operator Defaults toggle button', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Defaults/ })).toBeInTheDocument()
  })

  it('calls onCancel when ✕ is clicked', () => {
    const onCancel = vi.fn()
    render(<RecipeEditor onSaved={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('✕'))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('RecipeEditor — validation flow', () => {
  it("shows 'Manifest review passed' after reviewing valid JSON", () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    clickReviewManifest()
    expect(screen.getByText(/Manifest review passed/)).toBeInTheDocument()
  })

  it("shows 'Manifest review failed' for malformed JSON", () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '{not json}' } })
    clickReviewManifest()
    expect(screen.getByText(/Manifest review failed/)).toBeInTheDocument()
  })

  it('shows RFC1123 error for uppercase name', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: INVALID_NAME_JSON } })
    clickReviewManifest()
    expect(screen.getByText(/Manifest review failed/)).toBeInTheDocument()
  })

  it('shows error count in review summary', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: INVALID_NAME_JSON } })
    clickReviewManifest()
    // Manifest review failed — N error(s)
    expect(screen.getByText('Manifest review failed — 1 error(s)')).toBeInTheDocument()
  })

  it('separates contextRef informational notes from blocking validation errors', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'inline-sensitive-env' },
          spec: {
            triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
            workloads: [
              {
                id: 'mock-tools',
                type: 'deployment',
                image: 'clerum/mock-mcp-server:test',
                port: 3000,
                transport: { type: 'streamableHttp', path: '/mcp' },
                env: [
                  { name: 'CONFIG_MODE', value: 'test' },
                  { name: 'API_TOKEN', value: 'token-for-negative-test' },
                ],
              },
            ],
            steps: [
              {
                id: 'run',
                run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
              },
            ],
          },
        }),
      },
    })
    clickReviewManifest()

    expect(screen.getByText('Manifest review failed — 1 error(s)')).toBeInTheDocument()
    expect(screen.getByText('Blocking errors')).toBeInTheDocument()
    expect(screen.getByText('Informational notes')).toBeInTheDocument()
    expect(screen.getByText(/env name looks sensitive/)).toBeInTheDocument()
    expect(screen.getByText(/WRC will auto-create a private Context/)).toBeInTheDocument()
  })

  it('blocks reserved WorkflowRecipe secret names and invalid secret keys during validation', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'invalid-secret-ref' },
          spec: {
            triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
            workloads: [
              {
                id: 'mock-tools',
                type: 'deployment',
                image: 'clerum/mock-mcp-server:test',
                port: 3000,
                transport: { type: 'streamableHttp', path: '/mcp' },
                envSecret: {
                  name: 'wf-reserved-runtime-config',
                  keys: [{ secretKey: 'bad/key', envVar: 'CONFIG_TOKEN' }],
                },
              },
            ],
            steps: [
              {
                id: 'run',
                run: {
                  type: 'snippet',
                  language: 'typescript',
                  code: 'return { ok: true }',
                  capabilities: {
                    secrets: [
                      {
                        alias: 'config_token',
                        secretRef: { name: 'wf-reserved-runtime-config', key: 'bad/key' },
                      },
                    ],
                  },
                },
              },
            ],
          },
        }),
      },
    })
    clickReviewManifest()

    expect(screen.getByText(/Manifest review failed/)).toBeInTheDocument()
    expect(screen.getAllByText(/platform-managed/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/secret key must contain only/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Ready to deploy/)).not.toBeInTheDocument()
    expect(screen.queryByText('Deploy plugin')).not.toBeInTheDocument()
  })

  it('shows a warning when step output previews can exceed the Kubernetes object budget', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'large-preview-budget' },
          spec: {
            triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
            steps: Array.from({ length: 48 }, (_, i) => ({
              id: `s-${i}`,
              instruction: `step ${i}`,
            })),
          },
        }),
      },
    })
    clickReviewManifest()

    expect(screen.getByText(/Manifest review passed \(1 warning/)).toBeInTheDocument()
    expect(screen.getByText(/Kubernetes object budget/)).toBeInTheDocument()
  })

  it('shows a warning when env.value references a sensitive input template', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          metadata: { name: 'sensitive-input-env-template' },
          spec: {
            inputContract: {
              properties: {
                db_password: { type: 'string' },
              },
            },
            inputs: {
              db_password: 'placeholder',
            },
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'api:latest',
                env: [
                  {
                    name: 'DATABASE_URL',
                    value: 'postgres://app:{{inputs.db_password}}@postgres:5432/app',
                  },
                ],
              },
            ],
          },
        }),
      },
    })
    clickReviewManifest()

    expect(screen.getByText(/Manifest review passed \(1 warning/)).toBeInTheDocument()
    expect(screen.getByText('Warnings')).toBeInTheDocument()
    expect(
      screen.getByText(/env.value references sensitive input template.*{{inputs.db_password}}/)
    ).toBeInTheDocument()
  })

  it("shows 'Apply defaults' button after valid review", () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    clickReviewManifest()
    expect(screen.getByText('Apply defaults')).toBeInTheDocument()
  })

  it('resets validation when textarea is edited', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    clickReviewManifest()
    expect(screen.getByText(/Manifest review passed/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Manifest/ }))
    const updatedTextarea = screen.getByRole('textbox')
    fireEvent.change(updatedTextarea, { target: { value: VALID_JSON + '\n' } })
    expect(screen.queryByText(/Manifest review passed/)).not.toBeInTheDocument()
  })

  it('toggles Operator Defaults panel visibility', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    clickReviewManifest()
    fireEvent.click(screen.getByText('Apply defaults'))
    expect(screen.queryByText('Security')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/Show.*Operator Defaults/))
    expect(screen.getByText('Security')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Hide.*Operator Defaults/))
    expect(screen.queryByText('Security')).not.toBeInTheDocument()
  })
})

describe('RecipeEditor — deploy flow', () => {
  it("shows 'Deploy plugin' button after valid review (no enrichment)", async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()
    await waitFor(() => {
      expect(screen.getByText('Deploy plugin')).toBeInTheDocument()
    })
  })

  it('calls createRecipe and onSaved on successful deploy', async () => {
    const onSaved = vi.fn()
    render(<RecipeEditor onSaved={onSaved} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()
    const deployBtn = await screen.findByText('Deploy plugin')
    fireEvent.click(deployBtn)
    await waitFor(() => {
      expect(vi.mocked(api.createRecipe)).toHaveBeenCalled()
      expect(onSaved).toHaveBeenCalled()
    })
  })

  it('edits transport workload egress before deploy and submits the updated manifest', async () => {
    const recipeWithTransport = JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'web-search-egress-edit' },
        spec: {
          triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            },
          ],
          steps: [
            {
              id: 'research',
              run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
            },
          ],
        },
      },
      null,
      2
    )
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: recipeWithTransport } })
    clickReviewManifest()

    expect(await screen.findByText('External Egress Editor')).toBeInTheDocument()
    expect(screen.getAllByText('Transport workload "web-search"').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByDisplayValue('No external egress (closed by default)'), {
      target: { value: 'exact-host' },
    })
    fireEvent.change(screen.getByPlaceholderText('api.example.com, auth.example.com'), {
      target: { value: 'duckduckgo.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('443'), { target: { value: '443' } })
    await waitFor(() =>
      expect(screen.getByText(/1 domain\(s\) x 1 port\(s\) = 1 binding/)).toBeInTheDocument()
    )

    proceedToDeploy()
    fireEvent.click(await screen.findByText('Deploy plugin'))
    await waitFor(() => expect(api.createRecipe).toHaveBeenCalled())

    const createPayload = vi.mocked(api.createRecipe).mock.calls[0][0] as unknown as {
      spec: { workloads: Array<{ id: string; egressBindings?: unknown[] }> }
    }
    expect(createPayload.spec.workloads[0].egressBindings).toEqual([
      { dns: 'duckduckgo.com', port: 443, protocol: 'TCP' },
    ])
  })

  it('does not forward YAML metadata.namespace during validate or create', async () => {
    const jsonWithNamespace = JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'namespace-ignored', namespace: 'mcp-server' },
        spec: { workloads: [{ id: 'api', type: 'deployment', image: 'my-api:latest' }] },
      },
      null,
      2
    )
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: jsonWithNamespace } })
    reviewAndProceedToDeploy()
    const deployBtn = await screen.findByText('Deploy plugin')
    fireEvent.click(deployBtn)
    await waitFor(() => expect(api.createRecipe).toHaveBeenCalled())

    const validationPayload = vi.mocked(api.validateRecipeServer).mock.calls[0][0]
    expect(validationPayload.metadata).toEqual({ name: 'namespace-ignored' })
    expect(validationPayload.spec.workloads[0]).toEqual(
      expect.objectContaining({ id: 'api', type: 'deployment' })
    )
    expect(api.validateRecipeServer).toHaveBeenCalledWith(validationPayload, { mode: 'create' })

    const createPayload = vi.mocked(api.createRecipe).mock.calls[0][0]
    expect(createPayload.metadata).toEqual({ name: 'namespace-ignored' })
    expect(createPayload.spec.workloads[0]).toEqual(
      expect.objectContaining({ id: 'api', type: 'deployment' })
    )
  })

  it('detects snippet secretRef entries and renders one password input per unique Secret key', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: SNIPPET_SECRET_JSON } })
    reviewAndProceedToDeploy()

    expect(await screen.findByText(/Configuration & Secrets/)).toBeInTheDocument()
    expect(screen.getByText('coingecko-api')).toBeInTheDocument()
    expect(screen.getByText('coingecko_api_key')).toBeInTheDocument()
    expect(screen.getByText(/Deploy the recipe with pending secrets/)).toBeInTheDocument()
    expect(screen.getAllByText('Pending secret value')).toHaveLength(1)
    expect(
      screen.queryByPlaceholderText('Enter value for coingecko_api_key')
    ).not.toBeInTheDocument()
  })

  it('detects workload envSecret entries without duplicating keys also used by snippets', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: WORKLOAD_ENV_SECRET_JSON } })
    reviewAndProceedToDeploy()

    expect(await screen.findByText(/Configuration & Secrets/)).toBeInTheDocument()
    expect(screen.getByText('postgres-credentials')).toBeInTheDocument()
    expect(screen.getAllByText('Pending secret value')).toHaveLength(2)
    expect(
      screen.queryByPlaceholderText('Enter value for POSTGRES_PASSWORD')
    ).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Enter value for DATABASE_URL')).not.toBeInTheDocument()
  })

  it('detects OAuth client Secret refs as pending recipe secrets', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: OAUTH_CLIENT_SECRET_JSON } })
    reviewAndProceedToDeploy()

    expect(await screen.findByText(/Configuration & Secrets/)).toBeInTheDocument()
    expect(screen.getByText('github-oauth')).toBeInTheDocument()
    expect(screen.getByText('clientId')).toBeInTheDocument()
    expect(screen.getByText('clientSecret')).toBeInTheDocument()
    expect(screen.getByText(/\(ns: sandbox-recipes\)/)).toBeInTheDocument()
    expect(screen.getAllByText('Pending secret value')).toHaveLength(2)
  })

  it('detects transport workload envSecret targets in mcp-server and groups shared snippet keys', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: TRANSPORT_WORKLOAD_ENV_SECRET_JSON } })
    reviewAndProceedToDeploy()

    expect(await screen.findByText(/Configuration & Secrets/)).toBeInTheDocument()
    expect(screen.getByText('shared-credentials')).toBeInTheDocument()
    expect(screen.getByText(/\(ns: sandbox-recipes, mcp-server\)/)).toBeInTheDocument()
    expect(screen.getAllByText('Pending secret value')).toHaveLength(1)
    expect(screen.queryByPlaceholderText('Enter value for api_key')).not.toBeInTheDocument()
  })

  it('detects UI workload envSecret targets in sandbox-ui before deploy', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: SANDBOX_UI_WORKLOAD_ENV_SECRET_JSON } })
    reviewAndProceedToDeploy()

    expect(await screen.findByText(/Configuration & Secrets/)).toBeInTheDocument()
    expect(screen.getByText('ui-credentials')).toBeInTheDocument()
    expect(screen.getByText(/\(ns: sandbox-ui\)/)).toBeInTheDocument()
    expect(screen.getByText('UI_TOKEN')).toBeInTheDocument()
    expect(screen.getAllByText('Pending secret value')).toHaveLength(1)
  })

  it('creates a recipe with pending snippet Secret refs without pre-creating Secrets', async () => {
    vi.mocked(api.validateRecipeServer).mockResolvedValueOnce({
      valid: true,
      pendingCredentials: [
        {
          kind: 'snippet',
          secretName: 'coingecko-api',
          namespace: 'sandbox-recipes',
          keys: ['coingecko_api_key'],
          field: 'spec.steps[0].run.capabilities.secrets[0].secretRef',
        },
      ],
    })

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: SNIPPET_SECRET_JSON } })
    reviewAndProceedToDeploy()

    fireEvent.click(await screen.findByText('Deploy plugin'))

    await waitFor(() => expect(api.createRecipe).toHaveBeenCalled())
    expect(api.validateRecipeServer).toHaveBeenCalledTimes(1)
    const validateOrder = vi.mocked(api.validateRecipeServer).mock.invocationCallOrder[0]
    const createOrder = vi.mocked(api.createRecipe).mock.invocationCallOrder[0]
    expect(validateOrder).toBeLessThan(createOrder)

    const createPayload = vi.mocked(api.createRecipe).mock.calls[0][0]
    expect(JSON.stringify(createPayload)).toContain('"secretRef"')
  })

  it('creates a recipe with pending workload envSecret refs without pre-creating Secrets', async () => {
    vi.mocked(api.validateRecipeServer).mockResolvedValueOnce({
      valid: true,
      pendingCredentials: [
        {
          kind: 'workload',
          secretName: 'postgres-credentials',
          namespace: 'sandbox-recipes',
          keys: ['POSTGRES_PASSWORD'],
          field: 'spec.workloads[0].envSecret',
        },
      ],
    })

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: WORKLOAD_ENV_SECRET_JSON } })
    reviewAndProceedToDeploy()

    fireEvent.click(await screen.findByText('Deploy plugin'))

    await waitFor(() => expect(api.createRecipe).toHaveBeenCalled())
    const createPayload = vi.mocked(api.createRecipe).mock.calls[0][0]
    expect(JSON.stringify(createPayload)).toContain('"envSecret"')
  })

  it('keeps shared snippet and transport workload Secret refs pending across both runtime namespaces', async () => {
    vi.mocked(api.validateRecipeServer).mockResolvedValueOnce({
      valid: true,
      pendingCredentials: [
        {
          kind: 'snippet',
          secretName: 'shared-credentials',
          namespace: 'sandbox-recipes',
          keys: ['api_key'],
          field: 'spec.steps[0].run.capabilities.secrets[0].secretRef',
        },
        {
          kind: 'workload',
          secretName: 'shared-credentials',
          namespace: 'mcp-server',
          keys: ['api_key'],
          field: 'spec.workloads[0].envSecret',
        },
      ],
    })

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: TRANSPORT_WORKLOAD_ENV_SECRET_JSON } })
    reviewAndProceedToDeploy()

    fireEvent.click(await screen.findByText('Deploy plugin'))

    await waitFor(() => expect(api.createRecipe).toHaveBeenCalled())
    const createPayload = vi.mocked(api.createRecipe).mock.calls[0][0]
    expect(JSON.stringify(createPayload)).toContain('"secretRef"')
    expect(JSON.stringify(createPayload)).toContain('"envSecret"')
  })

  it('creates a recipe when snippet Secret fields are left empty', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: SNIPPET_SECRET_JSON } })
    reviewAndProceedToDeploy()
    await screen.findByText('Pending secret value')

    fireEvent.click(await screen.findByText('Deploy plugin'))

    await waitFor(() => expect(api.validateRecipeServer).toHaveBeenCalled())
    expect(api.createRecipe).toHaveBeenCalled()
  })

  it('does not offer credential rotation inputs from the recipe editor', async () => {
    vi.mocked(api.validateRecipeServer).mockResolvedValueOnce({ valid: true })

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: SNIPPET_SECRET_JSON } })
    reviewAndProceedToDeploy()
    expect(await screen.findByText('Pending secret value')).toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText('Enter value for coingecko_api_key')
    ).not.toBeInTheDocument()
    fireEvent.click(await screen.findByText('Deploy plugin'))

    await waitFor(() => expect(api.createRecipe).toHaveBeenCalled())
    expect(api.validateRecipeServer).toHaveBeenCalledTimes(1)
    const validateOrder = vi.mocked(api.validateRecipeServer).mock.invocationCallOrder[0]
    const createOrder = vi.mocked(api.createRecipe).mock.invocationCallOrder[0]
    expect(validateOrder).toBeLessThan(createOrder)
  })

  it('does not create the recipe when L2 rejects a non-secret error', async () => {
    vi.mocked(api.validateRecipeServer).mockResolvedValueOnce({
      valid: false,
      errors: [
        {
          field: 'metadata.name',
          rule: 'recipeNameTaken',
          message: 'Recipe already exists.',
        },
      ],
    })

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: SNIPPET_SECRET_JSON } })
    reviewAndProceedToDeploy()
    await screen.findByText('Pending secret value')
    fireEvent.click(await screen.findByText('Deploy plugin'))

    await waitFor(() => expect(api.validateRecipeServer).toHaveBeenCalled())
    expect(api.createRecipe).not.toHaveBeenCalled()
  })

  it('shows error message when createRecipe rejects', async () => {
    vi.mocked(api.createRecipe).mockRejectedValueOnce(new Error('500 Server Error'))
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()
    const deployBtn = await screen.findByText('Deploy plugin')
    fireEvent.click(deployBtn)
    await waitFor(() => {
      expect(screen.getByText('500 Server Error')).toBeInTheDocument()
    })
  })

  it('shows access-empty warning in create mode when no trigger access has been authorized', async () => {
    // UX regression guard: operator creates a recipe, forgets to click "Add" in
    // the Authorized users panel, and deploys. Without this warning the recipe
    // ships but nobody on Desktop App can trigger it — silent dead-letter.
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()
    await screen.findByText('Deploy plugin')
    const warning = screen.getByTestId('access-empty-warning')
    expect(warning).toBeInTheDocument()
    expect(warning.textContent).toMatch(/No trigger access/i)
    expect(warning.textContent).toMatch(/Desktop App/i)
  })

  it('hides access-empty warning in edit mode (does not apply to updates)', async () => {
    // Edit mode commits grants live via setWorkflowGrants — the warning is
    // only relevant to the two-step create flow. This guard prevents
    // future refactors from surfacing the banner on Edit by accident.
    render(
      <RecipeEditor
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        initial={{
          metadata: { name: 'existing-recipe', namespace: 'sandbox-recipes' },
          spec: {},
        }}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()
    // Edit mode keeps the Deploy-family button, but never surfaces the
    // create-only grants warning.
    await screen.findByText(/Deploy plugin|Save Changes|Update plugin/)
    expect(screen.queryByTestId('access-empty-warning')).not.toBeInTheDocument()
  })

  it("shows 'Deploying…' while deploy is in progress", async () => {
    // Never resolves during test — simulates slow network on createRecipe.
    // L2 pre-flight resolves synchronously in the mock, so the button
    // briefly shows 'Validating…' and then transitions to 'Deploying…'
    // once createRecipe is awaited.
    vi.mocked(api.createRecipe).mockReturnValueOnce(new Promise(() => undefined))
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()
    const deployBtn = await screen.findByText('Deploy plugin')
    fireEvent.click(deployBtn)
    await waitFor(() => expect(screen.getByText('Deploying…')).toBeInTheDocument())
  })
})

/* ── Per-step requiresApproval UI ─────────────────────────────────────────── */

const STEPS_JSON_BASE = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'approval-recipe' },
  spec: {
    triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
    workloads: [{ id: 'api', type: 'deployment', image: 'my-api:latest' }],
    steps: [{ id: 'deploy', instruction: 'Deploy to prod' }],
  },
}

const STEPS_JSON_NO_APPROVAL = JSON.stringify(STEPS_JSON_BASE, null, 2)

const STEPS_JSON_WITH_APPROVAL = JSON.stringify(
  {
    ...STEPS_JSON_BASE,
    spec: {
      ...STEPS_JSON_BASE.spec,
      steps: [
        {
          id: 'deploy',
          instruction: 'Deploy to prod',
          requiresApproval: {
            target: { userId: 'alice' },
            message: 'Approve the deploy?',
            timeoutSeconds: 3600,
          },
        },
      ],
    },
  },
  null,
  2
)

function getTextareaWithValue(): HTMLTextAreaElement {
  // The first textarea is the JSON editor; find it by role + name-less filtering.
  const areas = screen.getAllByRole('textbox') as HTMLTextAreaElement[]
  const jsonArea = areas.find(a => a.value.includes('apiVersion'))
  if (!jsonArea) throw new Error('JSON textarea not found')
  return jsonArea
}

describe('RecipeEditor — per-step requiresApproval', () => {
  it('hides User/Team/message/timeout fields when checkbox is off', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const jsonArea = getTextareaWithValue()
    fireEvent.change(jsonArea, { target: { value: STEPS_JSON_NO_APPROVAL } })
    // Expand the step row
    fireEvent.click(screen.getByText(/Step: deploy/))
    expect(screen.queryByRole('radio', { name: /User ID/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Approval message/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Approval timeout seconds/)).not.toBeInTheDocument()
  })

  it('toggling checkbox shows approval fields', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const jsonArea = getTextareaWithValue()
    fireEvent.change(jsonArea, { target: { value: STEPS_JSON_NO_APPROVAL } })
    fireEvent.click(screen.getByText(/Step: deploy/))
    const checkbox = screen.getByLabelText(/Requires human approval before step runs/)
    fireEvent.click(checkbox)
    expect(screen.getByRole('radio', { name: /User ID/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Team ID/ })).toBeInTheDocument()
    expect(screen.getByLabelText(/Approval message/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Approval timeout seconds/)).toBeInTheDocument()
  })

  it('serializes form to CRD schema { target: { userId }, message, timeoutSeconds }', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const jsonArea = getTextareaWithValue()
    fireEvent.change(jsonArea, { target: { value: STEPS_JSON_NO_APPROVAL } })
    fireEvent.click(screen.getByText(/Step: deploy/))
    fireEvent.click(screen.getByLabelText(/Requires human approval before step runs/))
    fireEvent.change(screen.getByLabelText(/Approval target value/), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/Approval message/), {
      target: { value: 'ok' },
    })
    fireEvent.change(screen.getByLabelText(/Approval timeout seconds/), {
      target: { value: 3600 },
    })
    const updated = JSON.parse(getTextareaWithValue().value) as {
      spec: { steps: Array<{ requiresApproval?: unknown }> }
    }
    expect(updated.spec.steps[0].requiresApproval).toEqual({
      target: { userId: 'alice' },
      message: 'ok',
      timeoutSeconds: 3600,
    })
  })

  it('loads existing YAML with requiresApproval into populated form fields', () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const jsonArea = getTextareaWithValue()
    fireEvent.change(jsonArea, { target: { value: STEPS_JSON_WITH_APPROVAL } })
    fireEvent.click(screen.getByText(/Step: deploy/))
    const checkbox = screen.getByLabelText(
      /Requires human approval before step runs/
    ) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    const userRadio = screen.getByRole('radio', { name: /User ID/ }) as HTMLInputElement
    expect(userRadio.checked).toBe(true)
    const targetInput = screen.getByLabelText(/Approval target value/) as HTMLInputElement
    expect(targetInput.value).toBe('alice')
    const messageArea = screen.getByLabelText(/Approval message/) as HTMLTextAreaElement
    expect(messageArea.value).toBe('Approve the deploy?')
    const timeoutInput = screen.getByLabelText(/Approval timeout seconds/) as HTMLInputElement
    expect(timeoutInput.value).toBe('3600')
  })

  it('shows validation error when message is missing and blocks deploy', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const jsonArea = getTextareaWithValue()
    fireEvent.change(jsonArea, { target: { value: STEPS_JSON_NO_APPROVAL } })
    fireEvent.click(screen.getByText(/Step: deploy/))
    fireEvent.click(screen.getByLabelText(/Requires human approval before step runs/))
    fireEvent.change(screen.getByLabelText(/Approval target value/), {
      target: { value: 'alice' },
    })
    // message intentionally left blank
    // Global banner should surface
    await waitFor(() => {
      expect(
        screen.getByText(/steps have approval enabled but are missing target or message/i)
      ).toBeInTheDocument()
    })
    // Validation phase should also report the schema error.
    clickReviewManifest()
    expect(screen.getByText(/Manifest review failed/)).toBeInTheDocument()
    expect(screen.getByText(/message is required/)).toBeInTheDocument()
    expect(screen.queryByText('Deploy plugin')).not.toBeInTheDocument()
  })

  it('shows validation error when target value is missing and blocks deploy', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const jsonArea = getTextareaWithValue()
    fireEvent.change(jsonArea, { target: { value: STEPS_JSON_NO_APPROVAL } })
    fireEvent.click(screen.getByText(/Step: deploy/))
    fireEvent.click(screen.getByLabelText(/Requires human approval before step runs/))
    fireEvent.change(screen.getByLabelText(/Approval message/), {
      target: { value: 'Please approve' },
    })
    // target intentionally left blank
    await waitFor(() => {
      expect(
        screen.getByText(/steps have approval enabled but are missing target or message/i)
      ).toBeInTheDocument()
    })
  })
})

// ── Policy pre-flight (L1 + L2) + grants panel + create/grants flow ─────────

const AGENTIC_NO_FLAG_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'agentic-block' },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [{ id: 's1', instruction: 'do x' }],
      contextRef: 'ctx1',
    },
  },
  null,
  2
)

const AGENTIC_FLAG_JSON = JSON.stringify(
  {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'agentic-allow' },
    spec: {
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [{ id: 's1', instruction: 'do x' }],
      contextRef: 'ctx1',
      security: { allowContextRef: true },
    },
  },
  null,
  2
)

describe('RecipeEditor — pre-flight policy (L1)', () => {
  it('renders L1 banner and disables Deploy when agentic+contextRef lacks allowContextRef', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: AGENTIC_NO_FLAG_JSON } })
    reviewAndProceedToDeploy()

    await waitFor(() =>
      expect(screen.getByText(/Cannot deploy: policy violation/)).toBeInTheDocument()
    )
    // The actionable L1 message mentions both the opt-in path
    // (allowContextRef) and the private auto-context alternative.
    expect(screen.getByText(/allowContextRef.*true/)).toBeInTheDocument()
    expect(screen.getByText(/remove.*spec\.contextRef|auto-create.*private/i)).toBeInTheDocument()
    // L1 disables the Deploy button.
    const deployBtn = screen.getByRole('button', { name: /Deploy plugin/ })
    expect(deployBtn).toBeDisabled()
  })

  it('clears L1 banner when user sets allowContextRef=true', async () => {
    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: AGENTIC_NO_FLAG_JSON } })
    reviewAndProceedToDeploy()
    await waitFor(() =>
      expect(screen.getByText(/Cannot deploy: policy violation/)).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: /Manifest/ }))
    const updatedTextarea = screen.getByRole('textbox')
    fireEvent.change(updatedTextarea, { target: { value: AGENTIC_FLAG_JSON } })
    reviewAndProceedToDeploy()
    await waitFor(() =>
      expect(screen.queryByText(/Cannot deploy: policy violation/)).not.toBeInTheDocument()
    )
  })
})

describe('RecipeEditor — pre-flight policy (L2)', () => {
  it('renders L2 banner on 422 from validateRecipeServer and keeps Deploy available for retry', async () => {
    vi.mocked(api.validateRecipeServer).mockResolvedValueOnce({
      valid: false,
      errors: [
        {
          field: 'spec.contextRef',
          rule: 'agenticWorkflowContextRefBlocked',
          message: 'no matching WorkflowRecipePolicy in sandbox-recipes',
        },
      ],
    })

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: AGENTIC_FLAG_JSON } })
    reviewAndProceedToDeploy()
    fireEvent.click(await screen.findByRole('button', { name: /Deploy plugin/ }))

    await waitFor(() =>
      expect(screen.getByText(/no matching WorkflowRecipePolicy/)).toBeInTheDocument()
    )
    expect(api.createRecipe).not.toHaveBeenCalled()
    // Button returns to idle — user can retry after fixing upstream.
    expect(screen.getByRole('button', { name: /Deploy plugin/ })).toBeInTheDocument()
  })
})

describe('RecipeEditor — grants in editor', () => {
  it('create flow: selects a user, Deploy issues createRecipe THEN setWorkflowGrants in order', async () => {
    vi.mocked(api.getAdminUsers).mockResolvedValue({
      items: [
        {
          id: 'u-1',
          email: 'alice@example.com',
          name: 'Alice',
          picture: null,
          displayName: null,
          activeTeamCount: 1,
        },
      ],
    })
    vi.mocked(api.createRecipe).mockResolvedValue({
      metadata: { name: 'my-recipe', namespace: 'sandbox-recipes' },
    } as WorkflowRecipeResource)

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()

    // Pick user in the create-mode grants picker.
    await screen.findByLabelText('Search users...')
    fireEvent.click(await screen.findByRole('option', { name: /Alice|alice@example.com/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add member$/ }))

    fireEvent.click(screen.getByRole('button', { name: /Deploy plugin/ }))

    await waitFor(() => expect(api.createRecipe).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(api.setWorkflowGrants).toHaveBeenCalledWith('sandbox-recipes', 'my-recipe', ['u-1'])
    )
    await waitFor(() =>
      expect(api.setWorkflowTeamGrants).toHaveBeenCalledWith('sandbox-recipes', 'my-recipe', [])
    )
    // Call order: create first, grants second.
    const createCallOrder = vi.mocked(api.createRecipe).mock.invocationCallOrder[0]
    const grantsCallOrder = vi.mocked(api.setWorkflowGrants).mock.invocationCallOrder[0]
    expect(createCallOrder).toBeLessThan(grantsCallOrder)
  })

  it('create flow: workflow access panel buffers selection locally — no PUT per click', async () => {
    vi.mocked(api.getAdminUsers).mockResolvedValue({
      items: [
        {
          id: 'u-1',
          email: 'alice@example.com',
          name: null,
          picture: null,
          displayName: null,
          activeTeamCount: 1,
        },
      ],
    })

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()

    await screen.findByLabelText('Search users...')
    fireEvent.click(await screen.findByRole('option', { name: /Alice|alice@example.com/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add member$/ }))

    // Buffer semantics: clicking Grant in create mode DOES NOT call the API.
    // (It only enqueues; setWorkflowGrants runs once on Deploy.)
    expect(api.setWorkflowGrants).not.toHaveBeenCalled()
    expect(api.setWorkflowTeamGrants).not.toHaveBeenCalled()
    // UI reflects the buffered user.
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
  })

  it('create flow: saves trigger team grants and approval target teams as separate contracts', async () => {
    vi.mocked(api.getAdminTeams).mockResolvedValue({
      items: [
        { id: 'team-trigger', name: 'Trigger Team', memberCount: 2 },
        { id: 'team-approval', name: 'Approval Team', memberCount: 2 },
      ],
    })
    vi.mocked(api.createRecipe).mockResolvedValue({
      metadata: { name: 'my-recipe', namespace: 'sandbox-recipes' },
    } as WorkflowRecipeResource)

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()

    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    await screen.findByLabelText('Search teams...')
    fireEvent.click(await screen.findByRole('option', { name: 'Trigger Team' }))
    fireEvent.click(screen.getByRole('button', { name: /^Add team$/ }))

    fireEvent.click(screen.getByRole('tab', { name: /Approval target teams/ }))
    await screen.findByLabelText('Search teams...')
    fireEvent.click(await screen.findByRole('option', { name: 'Approval Team' }))
    fireEvent.click(screen.getByRole('button', { name: /^Allow team$/ }))

    fireEvent.click(screen.getByRole('button', { name: /Deploy plugin/ }))

    await waitFor(() =>
      expect(api.setWorkflowTeamGrants).toHaveBeenCalledWith('sandbox-recipes', 'my-recipe', [
        'team-trigger',
      ])
    )
    await waitFor(() =>
      expect(api.allowWorkflowApprovalTeam).toHaveBeenCalledWith(
        'sandbox-recipes',
        'my-recipe',
        'team-approval'
      )
    )
    expect(api.setWorkflowTeamGrants).not.toHaveBeenCalledWith('sandbox-recipes', 'my-recipe', [
      'team-approval',
    ])
  })

  it('create flow: approval target team alone does not imply a team trigger grant', async () => {
    vi.mocked(api.getAdminTeams).mockResolvedValue({
      items: [{ id: 'team-approval', name: 'Approval Team', memberCount: 2 }],
    })
    vi.mocked(api.createRecipe).mockResolvedValue({
      metadata: { name: 'my-recipe', namespace: 'sandbox-recipes' },
    } as WorkflowRecipeResource)

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()

    fireEvent.click(screen.getByRole('tab', { name: /Approval target teams/ }))
    await screen.findByLabelText('Search teams...')
    fireEvent.click(await screen.findByRole('option', { name: 'Approval Team' }))
    fireEvent.click(screen.getByRole('button', { name: /^Allow team$/ }))

    fireEvent.click(screen.getByRole('button', { name: /Deploy plugin/ }))

    await waitFor(() =>
      expect(api.setWorkflowTeamGrants).toHaveBeenCalledWith('sandbox-recipes', 'my-recipe', [])
    )
    await waitFor(() =>
      expect(api.allowWorkflowApprovalTeam).toHaveBeenCalledWith(
        'sandbox-recipes',
        'my-recipe',
        'team-approval'
      )
    )
  })

  it('edit flow: grants a new user on an installed recipe without updating the CRD body', async () => {
    vi.mocked(api.getAdminUsers).mockResolvedValue({
      items: [
        {
          id: 'u-1',
          email: 'alice@example.com',
          name: 'Alice',
          picture: null,
          displayName: null,
          activeTeamCount: 1,
        },
        {
          id: 'u-2',
          email: 'bob@example.com',
          name: 'Bob',
          picture: null,
          displayName: null,
          activeTeamCount: 1,
        },
      ],
    })
    vi.mocked(api.listWorkflowGrants)
      .mockResolvedValueOnce({
        items: [
          {
            id: 'u-1',
            email: 'alice@example.com',
            name: 'Alice',
            displayName: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'u-1',
            email: 'alice@example.com',
            name: 'Alice',
            displayName: null,
          },
          {
            id: 'u-2',
            email: 'bob@example.com',
            name: 'Bob',
            displayName: null,
          },
        ],
      })

    render(
      <RecipeEditor
        initial={
          {
            apiVersion: 'clerum.io/v1alpha1',
            kind: 'WorkflowRecipe',
            metadata: { name: 'installed-recipe', namespace: 'sandbox-recipes' },
            spec: JSON.parse(VALID_JSON).spec,
          } as WorkflowRecipeResource
        }
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    reviewAndProceedToDeploy()
    await screen.findByText(/Deploy plugin|Save Changes|Update plugin/)
    await screen.findByLabelText('Search users...')
    await waitFor(() => expect(screen.getByText(/alice@example\.com/)).toBeInTheDocument())
    fireEvent.click(await screen.findByRole('option', { name: /Bob/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add member$/ }))

    await waitFor(() =>
      expect(api.setWorkflowGrants).toHaveBeenCalledWith('sandbox-recipes', 'installed-recipe', [
        'u-1',
        'u-2',
      ])
    )
    await waitFor(() => expect(screen.getByText(/bob@example\.com/)).toBeInTheDocument())
    expect(api.updateRecipe).not.toHaveBeenCalled()
  })

  it('Flow E: create succeeds but grants fails → editor transitions to Edit mode + inline error', async () => {
    vi.mocked(api.getAdminUsers).mockResolvedValue({
      items: [
        {
          id: 'u-1',
          email: 'alice@example.com',
          name: null,
          picture: null,
          displayName: null,
          activeTeamCount: 1,
        },
      ],
    })
    vi.mocked(api.createRecipe).mockResolvedValueOnce({
      metadata: { name: 'my-recipe', namespace: 'sandbox-recipes' },
    } as WorkflowRecipeResource)
    vi.mocked(api.setWorkflowGrants).mockRejectedValueOnce(new Error('postgres unavailable'))

    render(<RecipeEditor onSaved={vi.fn()} onCancel={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: VALID_JSON } })
    reviewAndProceedToDeploy()

    await screen.findByLabelText('Search users...')
    fireEvent.click(await screen.findByRole('option', { name: /Alice|alice@example.com/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add member$/ }))
    fireEvent.click(screen.getByRole('button', { name: /Deploy plugin/ }))

    // Editor re-renders as Edit mode with the just-created recipe.
    await waitFor(() => expect(screen.getByText(/Edit Plugin: my-recipe/)).toBeInTheDocument())
    // Inline error surfaces in the grants panel.
    expect(screen.getByText(/could not be saved/)).toBeInTheDocument()
  })
})
