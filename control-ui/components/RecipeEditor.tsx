'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import { useToast } from '@/components/Toast'
import { Button } from '@/components/ui'
import type {
  AdminUser,
  ServerValidationError,
  TeamListItem,
  WorkflowRecipeResource,
} from '../lib/api'
import {
  allowWorkflowApprovalTeam,
  createRecipe,
  getAdminTeams,
  getAdminUsers,
  getControlUINamespaces,
  setWorkflowGrants,
  setWorkflowTeamGrants,
  updateRecipe,
  validateRecipeServer,
} from '../lib/api'
import {
  CODEX_CONNECTION_REF_ANNOTATION,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexSubscriptionConnectionView,
  isAssignableCodexGrant,
  listCodexSubscriptionConnections,
} from '../lib/codexSubscription'
import { isDisabledCapabilityError } from '../lib/codexSubscriptionFeature'
import { analyzeWorkflowRecipeEgress } from '../lib/egressModel'
import type { EgressBinding, EgressEditorStatus } from '../lib/egressModel'
import { OPENAI_SUBSCRIPTION_PROVIDER, brokerBackedRecipeAuthoringError } from '../lib/llm'
import { credentialSelectValue, parseCredentialSelect } from '../lib/llmCredentialSelect'
import { DEFAULT_OPERATOR_DEFAULTS, applyDefaults } from '../lib/recipeDefaults'
import {
  type RecipeSecretNamespaces,
  resolveRecipeSecretNamespaces,
} from '../lib/recipeSecretNamespaces'
import type {
  EnrichmentResult,
  OperatorDefaults,
  ValidationResult,
  WorkflowRecipeSpec,
} from '../lib/recipeTypes'
import { validateRecipe } from '../lib/recipeValidator'
import { CreateFlowPanel } from './CreateFlowPanel'
import { CreateStepFlow } from './CreateStepFlow'
import { EgressEditor } from './EgressEditor'
import { LlmSecretSelect, type LlmSecretSelectOption } from './LlmSecretSelect'
import { RecipeDefaultsPanel } from './RecipeDefaultsPanel'
import { WorkflowAccessPanel } from './WorkflowAccessPanel'

/**
 * Client-side (L1) policy check — fast path for the three recipe fields
 * that control the `agenticWorkflowContextRefBlocked` invariant (spec
 * §270-271 / §1441). L1 does NOT know whether a matching
 * `WorkflowRecipePolicy` exists in the target namespace — that requires
 * cluster state and is covered by L2 (`POST /admin/recipes/validate`).
 *
 * Returns an error when the recipe is agentic (`spec.steps[]`) + declares
 * `spec.contextRef` + does NOT set `spec.security.allowContextRef=true`.
 * All other combinations resolve client-side.
 */
function checkPolicyL1(parsed: { spec?: unknown } | null): ServerValidationError | null {
  // Cast to the canonical spec type once. `spec` at the parser boundary is
  // `unknown` because the JSON came from a textarea; this assertion is the
  // single trust boundary. Downstream reads are type-safe.
  const spec = parsed?.spec as WorkflowRecipeSpec | undefined
  const isAgentic = Array.isArray(spec?.steps) && spec.steps.length > 0
  const hasContextRef = typeof spec?.contextRef === 'string' && spec.contextRef.length > 0
  if (isAgentic && hasContextRef && spec?.security?.allowContextRef !== true) {
    const ctxRef = spec!.contextRef!
    return {
      field: 'spec.security.allowContextRef',
      rule: 'agenticWorkflowContextRefBlocked',
      message:
        `This agentic recipe references the shared Context "${ctxRef}". ` +
        `Choose one of two paths:\n` +
        `  • Option A — opt in to sharing: add \`"security": { "allowContextRef": true }\` to spec, ` +
        `and ensure a WorkflowRecipePolicy with \`allowContextRef: true\` exists in the target namespace.\n` +
        `  • Option B — keep it private: remove \`spec.contextRef\` entirely. ` +
        `WRC will auto-create a private Context "wf-<recipeName>" for this recipe, ` +
        `with no first-party server sharing and no policy required.`,
    }
  }
  return null
}

function readRecipeAgentProvider(spec: unknown): string {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ''
  const agent = (spec as { agent?: unknown }).agent
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return ''
  return typeof (agent as { provider?: unknown }).provider === 'string'
    ? (agent as { provider: string }).provider.trim()
    : ''
}

function readRecipeCodexGrantAnnotation(
  resource?: { metadata?: { annotations?: Record<string, string> } } | null
): string {
  const raw = resource?.metadata?.annotations?.[CODEX_CONNECTION_REF_ANNOTATION]
  return typeof raw === 'string' ? raw.trim() : ''
}

function recipeGrantAnnotations(provider: string, connectionRef: string): Record<string, string> {
  if (provider !== OPENAI_SUBSCRIPTION_PROVIDER) {
    return { [CODEX_CONNECTION_REF_ANNOTATION]: '' }
  }
  const parsed = parseCredentialSelect(credentialSelectValue('', connectionRef))
  return {
    [CODEX_CONNECTION_REF_ANNOTATION]: parsed.kind === 'subscription' ? parsed.connectionKey : '',
  }
}

type TransportWorkloadEditorTarget = {
  index: number
  id: string
  bindings?: EgressBinding[]
}

function workflowTransportWorkloads(
  parsed: { spec?: unknown } | null
): TransportWorkloadEditorTarget[] {
  const spec = parsed?.spec as { workloads?: unknown } | undefined
  const workloads = Array.isArray(spec?.workloads) ? spec.workloads : []
  return workloads.flatMap((workload, index) => {
    if (!workload || typeof workload !== 'object') return []
    const typed = workload as { id?: unknown; transport?: unknown; egressBindings?: unknown }
    if (!typed.transport) return []
    return [
      {
        index,
        id: typeof typed.id === 'string' && typed.id.trim() ? typed.id : `workload-${index}`,
        bindings: Array.isArray(typed.egressBindings)
          ? (typed.egressBindings as EgressBinding[])
          : undefined,
      },
    ]
  })
}

function applyWorkflowWorkloadEgress(
  rawManifest: string,
  workloadIndex: number,
  bindings: EgressBinding[] | undefined
): string {
  const parsed = JSON.parse(rawManifest) as {
    spec?: { workloads?: unknown[] }
    workloads?: unknown[]
  }
  const spec = parsed.spec ?? parsed
  if (!Array.isArray(spec.workloads)) {
    throw new Error('Recipe manifest has no spec.workloads array')
  }
  const workload = spec.workloads[workloadIndex]
  if (!workload || typeof workload !== 'object') {
    throw new Error(`Recipe workload at index ${workloadIndex} is not editable`)
  }
  const nextWorkload = { ...(workload as Record<string, unknown>) }
  if (bindings && bindings.length > 0) {
    nextWorkload.egressBindings = bindings
  } else {
    delete nextWorkload.egressBindings
  }
  spec.workloads = spec.workloads.map((item, index) =>
    index === workloadIndex ? nextWorkload : item
  )
  if (parsed.spec) parsed.spec = spec as { workloads?: unknown[] }
  return JSON.stringify(parsed, null, 2)
}

type DeployPhase = 'idle' | 'validating' | 'creating' | 'saving-access'

type Props = {
  /** When provided, editor is in "edit" mode (update existing recipe) */
  initial?: WorkflowRecipeResource
  onSaved: () => void
  onCancel: () => void
  pageHeader?: ReactNode
}

const DEFAULT_WEB_SEARCH_ENGINE_GUIDANCE =
  'Use only the default DuckDuckGo search engine; do not pass an engines list.'

const WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS = [{ egressClass: 'public-web' }]

const WEB_SEARCH_WORKLOAD_ENV = [
  { name: 'DEFAULT_SEARCH_ENGINE', value: 'duckduckgo' },
  { name: 'ALLOWED_SEARCH_ENGINES', value: 'duckduckgo' },
  { name: 'ENABLE_CORS', value: 'true' },
]

type RecipeTemplate = { label: string; json: string; localOnly?: boolean }

const TEMPLATES: RecipeTemplate[] = [
  {
    label: 'MongoDB Connector Stack (Workload)',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'mongodb-mcp-stack' },
        spec: {
          contextRef: 'context1',
          workloads: [
            {
              id: 'mongodb',
              type: 'statefulset',
              image: 'mongo:7.0',
              env: [{ name: 'MONGO_INITDB_ROOT_USERNAME', value: 'admin' }],
              envSecret: {
                name: 'mongodb-credentials',
                keys: [{ secretKey: 'rootPassword', envVar: 'MONGO_INITDB_ROOT_PASSWORD' }],
              },
              volumeMounts: [{ name: 'mongodata', mountPath: '/data/db' }],
              volumeClaimTemplates: [
                {
                  name: 'mongodata',
                  storageClass: 'standard-rwo',
                  accessMode: 'ReadWriteOnce',
                  size: '1Gi',
                },
              ],
              security: {
                runAsUser: 999,
                runAsGroup: 999,
                fsGroup: 999,
                addCapabilities: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
              },
            },
            {
              id: 'mongodb-mcp',
              type: 'deployment',
              image: 'us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum/mcp-mongodb:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
              envSecret: {
                name: 'mongodb-credentials',
                keys: [{ secretKey: 'mongoUrl', envVar: 'MONGO_URL' }],
              },
            },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Agentic Workflow (PDF Report)',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'research-summary-workflow' },
        spec: {
          agent: {
            provider: 'zai',
            model: 'glm-4.7',
          },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          mcpServers: [{ id: 'web-search' }],
          steps: [
            {
              id: 'research',
              instruction:
                'Research the following topic thoroughly using the search tool: {{inputs.topic}}. ' +
                `${DEFAULT_WEB_SEARCH_ENGINE_GUIDANCE} ` +
                "Use the 'search' tool to find relevant results and collect key details from titles, descriptions, and source URLs. " +
                'Collect key facts, recent developments, and important context.',
              mcpServers: ['web-search'],
              allowedTools: { include: ['web-search__search'] },
              timeoutSeconds: 600,
            },
            {
              id: 'summarize',
              instruction:
                'Using the following research results:\n\n{{research:output}}\n\n' +
                'Produce a structured summary with: executive overview, key findings, ' +
                'timeline of events, and recommended next steps. Use markdown headings.',
              dependsOn: ['research'],
              timeoutSeconds: 600,
            },
            {
              id: 'generate-report',
              instruction:
                'You MUST call the clerum__generate_pdf tool to create the final report.\n\n' +
                'filename: "research-summary.pdf"\n' +
                'title: "Research Summary: {{inputs.topic}}"\n' +
                'body:\n{{summarize:output}}',
              allowedTools: { include: ['clerum__generate_pdf'] },
              dependsOn: ['summarize'],
              timeoutSeconds: 600,
            },
          ],
          output: {
            name: 'research-summary',
            destination: 'pvc',
            format: 'pdf',
            storageSize: '64Mi',
          },
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'ghcr.io/aas-ee/open-web-search:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
              env: WEB_SEARCH_WORKLOAD_ENV,
              egressBindings: WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS,
            },
          ],
          inputContract: {
            properties: {
              topic: { type: 'string', default: 'latest advances in multi-agent AI systems' },
            },
          },
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Agentic Workflow (Codex Subscription)',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'codex-subscription-workflow' },
        spec: {
          agent: {
            provider: 'codex-subscription',
            model: 'gpt-5.1',
          },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          steps: [
            {
              id: 'draft',
              instruction: 'Draft a concise answer for: {{inputs.topic}}',
              timeoutSeconds: 600,
            },
          ],
          inputContract: {
            properties: {
              topic: { type: 'string', default: 'summarize this change' },
            },
          },
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Agentic Workload Template Resolution',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'agentic-workload-template-resolution' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          inputContract: {
            properties: {
              db_name: { type: 'string', default: 'clerum' },
              shell_bin: { type: 'string', default: 'sh' },
            },
          },
          computed: [{ name: 'db_mode', expression: "'readonly'" }],
          workloads: [
            {
              id: 'postgres',
              type: 'statefulset',
              image: 'postgres:16-alpine',
              port: 5432,
              security: {
                runAsUser: 70,
                runAsGroup: 70,
                fsGroup: 70,
              },
              env: [
                { name: 'POSTGRES_DB', value: '{{inputs.db_name}}' },
                { name: 'POSTGRES_USER', value: 'clerum' },
              ],
              envSecret: {
                name: 'agentic-template-postgres-auth',
                keys: [{ secretKey: 'password', envVar: 'POSTGRES_PASSWORD' }],
              },
            },
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'busybox:1.36',
              port: 8080,
              env: [
                {
                  name: 'DATABASE_URL',
                  value: 'postgres://clerum@{{postgres:host}}:{{postgres:port}}/{{inputs.db_name}}',
                },
                { name: 'DB_MODE', value: '{{computed.db_mode}}' },
              ],
              command: ['{{inputs.shell_bin}}', '-c'],
              args: [
                'echo "db=$DATABASE_URL host={{postgres:host}} port={{postgres:port}} mode={{computed.db_mode}}"; sleep 3600',
              ],
            },
          ],
          steps: [
            {
              id: 'verify-template-resolution',
              instruction:
                'Confirm that qa-api received resolved PostgreSQL service host and port values in its workload configuration.',
              timeoutSeconds: 600,
            },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Layer 3A Snippet Direct DB',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'layer3a-snippet-direct-db' },
        spec: {
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          workloads: [
            {
              id: 'postgres',
              type: 'statefulset',
              image: 'postgres:16-alpine',
              port: 5432,
              env: [
                { name: 'POSTGRES_DB', value: 'clerum' },
                { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
              ],
              envSecret: {
                name: 'pg-auth',
                keys: [{ secretKey: 'password', envVar: 'POSTGRES_PASSWORD' }],
              },
            },
          ],
          steps: [
            {
              id: 'query-postgres',
              run: {
                type: 'snippet',
                language: 'typescript',
                code:
                  'const ref = { workload: "postgres", database: "clerum", user: "postgres", passwordSecretAlias: "pg_password" };\n' +
                  'await sdk.postgres.execute(ref, { sql: "create table if not exists recipe_template_probe(id int primary key, ok boolean)" });\n' +
                  'await sdk.postgres.execute(ref, { sql: "insert into recipe_template_probe(id, ok) values ($1, $2) on conflict (id) do update set ok = excluded.ok", values: [1, true] });\n' +
                  'const rows = await sdk.postgres.query(ref, { sql: "select id, ok from recipe_template_probe where id = $1", values: [1] });\n' +
                  'return { source: "postgres", rows }',
                capabilities: {
                  secrets: [
                    {
                      alias: 'pg_password',
                      secretRef: { name: 'pg-auth', key: 'password' },
                    },
                  ],
                  postgres: { workloads: ['postgres'], access: 'readWrite' },
                },
              },
              timeoutSeconds: 600,
            },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Layer 3A Snippet Hybrid Agentic',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'layer3a-snippet-hybrid-agentic' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          inputContract: {
            properties: {
              topic: { type: 'string', default: 'workflow template resolution' },
            },
          },
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'ghcr.io/aas-ee/open-web-search:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
              env: WEB_SEARCH_WORKLOAD_ENV,
              egressBindings: WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS,
            },
          ],
          steps: [
            {
              id: 'prepare-context',
              run: {
                type: 'snippet',
                language: 'typescript',
                code: 'return { source: "snippet", prepared: true }',
                capabilities: {
                  secrets: [
                    {
                      alias: 'optional_api_key',
                      secretRef: { name: 'snippet-credentials', key: 'apiKey' },
                    },
                  ],
                },
              },
              timeoutSeconds: 600,
            },
            {
              id: 'research',
              instruction:
                'Research {{inputs.topic}} using the web-search tools. Previous context: {{prepare-context:output}}',
              dependsOn: ['prepare-context'],
              mcpServers: ['web-search'],
              allowedTools: { include: ['web-search__search'] },
              timeoutSeconds: 600,
            },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Layer 3B Custom Coordinator - Deterministic (Advanced, Local Images)',
    localOnly: true,
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: {
          name: 'layer3b-custom-coordinator-deterministic',
          annotations: {
            'clerum.io/template-note':
              'Advanced E2E template: requires locally built clerum/workflow-custom-sdk-e2e:test and clerum/mock-mcp-server:test images.',
          },
        },
        spec: {
          description:
            'Advanced local/E2E custom coordinator template. Requires locally built clerum/workflow-custom-sdk-e2e:test and clerum/mock-mcp-server:test images.',
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          runtimeEgress: { http: { allowedHosts: ['api.github.com'] } },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          inputContract: {
            properties: {
              requestId: { type: 'string', default: 'deterministic-run' },
            },
          },
          workloads: [
            {
              id: 'business-api',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3001,
              healthCheck: { type: 'tcp', port: 3001 },
            },
          ],
          output: {
            destination: 'pvc',
            name: 'custom-coordinator-output',
            format: 'json',
            storageSize: '128Mi',
          },
          steps: [{ id: 'prepare' }, { id: 'emit-artifacts', dependsOn: ['prepare'] }],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Layer 3B Custom Coordinator - Broker Backed (Advanced, Local Images)',
    localOnly: true,
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: {
          name: 'layer3b-custom-coordinator-broker-backed',
          annotations: {
            'clerum.io/template-note':
              'Advanced E2E template: requires locally built clerum/workflow-custom-sdk-e2e:test and clerum/mock-mcp-server:test images plus a WorkflowRecipePolicy allowing contextRef.',
          },
        },
        spec: {
          description:
            'Advanced local/E2E custom coordinator template. Requires locally built clerum/workflow-custom-sdk-e2e:test and clerum/mock-mcp-server:test images plus a WorkflowRecipePolicy allowing contextRef.',
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          contextRef: 'context1',
          security: { allowContextRef: true },
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          workloads: [
            {
              id: 'business-api',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3001,
              healthCheck: { type: 'tcp', port: 3001 },
            },
            {
              id: 'mock-tools',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              healthCheck: { type: 'tcp', port: 3001 },
            },
          ],
          output: {
            destination: 'pvc',
            name: 'custom-coordinator-broker-output',
            format: 'multi',
            storageSize: '256Mi',
          },
          steps: [
            { id: 'prepare' },
            {
              id: 'call-mcp',
              dependsOn: ['prepare'],
              instruction:
                'Use the mock-tools add tool exactly once with a=40 and b=2. Return a concise JSON summary.',
              mcpServers: ['mock-tools'],
              allowedTools: { include: ['mock-tools__add'] },
            },
            { id: 'emit-artifacts', dependsOn: ['call-mcp'] },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Competitive Intel Report (PDF)',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'competitive-intel-report' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          inputContract: {
            properties: {
              industry: { type: 'string', default: 'enterprise AI orchestration platforms' },
              competitors: { type: 'string', default: 'LangChain, CrewAI, AutoGen' },
              focus_areas: {
                type: 'string',
                default: 'pricing, features, market share, developer experience',
              },
            },
          },
          mcpServers: [{ id: 'web-search' }],
          steps: [
            {
              id: 'research-competitors',
              instruction:
                'Research each competitor in detail: {{inputs.competitors}}.\n' +
                'Industry: {{inputs.industry}}. Focus areas: {{inputs.focus_areas}}.\n\n' +
                `${DEFAULT_WEB_SEARCH_ENGINE_GUIDANCE}\n\n` +
                'For EACH competitor, use search to find:\n' +
                '1. Official website pricing and plans\n' +
                '2. Recent product announcements (last 6 months)\n' +
                '3. GitHub stars, community size, and adoption metrics\n' +
                '4. Key differentiators and unique features\n' +
                '5. Known limitations or complaints from users\n\n' +
                'Structure your output as a detailed dossier per competitor.',
              mcpServers: ['web-search'],
              allowedTools: {
                include: ['web-search__search'],
              },
              timeoutSeconds: 1800,
            },
            {
              id: 'analyze-market',
              instruction:
                'Using the competitor research below, perform a strategic analysis:\n\n' +
                '{{research-competitors:output}}\n\n' +
                'Produce:\n1. SWOT analysis for each competitor\n' +
                '2. Feature comparison matrix (table format)\n' +
                '3. Pricing comparison (normalized to per-seat/month)\n' +
                '4. Market positioning map\n' +
                '5. Key trends and predictions for next 12 months\n' +
                '6. Strategic recommendations (3-5 actionable items)\n\n' +
                'Format as structured markdown with clear headers and tables.',
              dependsOn: ['research-competitors'],
              timeoutSeconds: 1800,
            },
            {
              id: 'deslop',
              instruction:
                'Review the analysis below and remove all AI-generated slop:\n\n' +
                '{{analyze-market:output}}\n\n' +
                'What to remove:\n' +
                '- Extra comments or filler text that add no value\n' +
                '- Exaggerated claims or unsupported assumptions (hallucinations)\n' +
                '- Repetitive phrases, hedging language, or unnecessary qualifiers\n' +
                "- Emoji or AI-typical patterns (e.g. 'Certainly!', 'Great question!')\n" +
                '- Vague statements without specific data backing them\n' +
                "- Any content that reads as 'predicted next token' rather than grounded fact\n\n" +
                'Preserve:\n' +
                '- All factual data points (numbers, dates, names, URLs)\n' +
                '- Structured tables and comparison matrices\n' +
                '- Concrete recommendations with rationale\n\n' +
                'Output the cleaned analysis in the same markdown format. ' +
                'End with a 1-3 sentence summary of what was removed.',
              dependsOn: ['analyze-market'],
              timeoutSeconds: 1800,
            },
            {
              id: 'generate-report',
              instruction:
                'You MUST call the clerum__generate_pdf tool to generate the final PDF report.\n' +
                'Use the following cleaned analysis as the body content.\n\n' +
                'filename: "competitive-intelligence-report.pdf"\n' +
                'title: "Competitive Intelligence Report: {{inputs.industry}}"\n' +
                'body:\n{{deslop:output}}\n\n' +
                'Include: Executive summary, full analysis with tables, ' +
                'and appendix with data sources.',
              allowedTools: { include: ['clerum__generate_pdf'] },
              dependsOn: ['deslop'],
              timeoutSeconds: 1800,
            },
          ],
          output: {
            destination: 'pvc',
            name: 'competitive-intel-report',
            format: 'pdf',
            storageSize: '256Mi',
          },
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'ghcr.io/aas-ee/open-web-search:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
              env: WEB_SEARCH_WORKLOAD_ENV,
              egressBindings: WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS,
            },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Market Data Dashboard (Excel)',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'market-data-dashboard' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          inputContract: {
            properties: {
              assets: { type: 'string', default: 'Bitcoin, Ethereum, Solana, Avalanche, Polkadot' },
              metrics: {
                type: 'string',
                default: 'price, market_cap, 24h_volume, 7d_change, 30d_change, TVL',
              },
              timeframe: { type: 'string', default: 'last 30 days' },
            },
          },
          mcpServers: [{ id: 'web-search' }],
          steps: [
            {
              id: 'collect-data',
              instruction:
                'Research current market data for: {{inputs.assets}}.\n' +
                'Metrics to collect: {{inputs.metrics}}. Timeframe: {{inputs.timeframe}}.\n\n' +
                `${DEFAULT_WEB_SEARCH_ENGINE_GUIDANCE}\n\n` +
                'Use search to find the MOST RECENT data from:\n' +
                'CoinGecko, CoinMarketCap, DeFiLlama, Messari.\n\n' +
                'For each asset, produce a structured data object with ALL metrics.\n' +
                'Include historical data points where available (weekly snapshots).\n' +
                'Output as structured JSON-like format for spreadsheet rows.',
              mcpServers: ['web-search'],
              allowedTools: { include: ['web-search__search'] },
              timeoutSeconds: 600,
            },
            {
              id: 'analyze-trends',
              instruction:
                'Analyze the collected market data and identify trends:\n\n' +
                '{{collect-data:output}}\n\n' +
                'Produce:\n1. Performance ranking (best to worst by 30d change)\n' +
                '2. Correlation analysis between assets\n' +
                '3. Volume/market cap ratio analysis\n' +
                '4. TVL trends and DeFi dominance per chain\n' +
                '5. Risk assessment (volatility, drawdown from ATH)\n' +
                '6. Summary narrative for each asset\n' +
                '7. Portfolio allocation recommendation (conservative, moderate, aggressive)\n\n' +
                'Structure ALL numerical data as clean tables with headers.',
              dependsOn: ['collect-data'],
              timeoutSeconds: 600,
            },
            {
              id: 'generate-excel',
              instruction:
                'You MUST call the clerum__generate_xlsx tool to generate a comprehensive Excel workbook.\n\n' +
                'filename: "market-data-dashboard.xlsx"\n' +
                'Structure the data from the analysis below into multiple sheets:\n\n' +
                '{{analyze-trends:output}}\n\n' +
                'Sheet 1 "Overview": All assets with current metrics\n' +
                'Sheet 2 "Performance": Ranked performance with changes\n' +
                'Sheet 3 "Risk Analysis": Volatility, drawdown, risk score\n' +
                'Sheet 4 "DeFi Metrics": TVL, TVL/mcap ratio, top DApps\n' +
                'Sheet 5 "Portfolio Models": Conservative/Moderate/Aggressive allocations\n' +
                'Sheet 6 "Raw Data": All collected data points\n\n' +
                'Title: "Market Data Dashboard - {{inputs.timeframe}}"',
              allowedTools: { include: ['clerum__generate_xlsx'] },
              dependsOn: ['analyze-trends'],
              timeoutSeconds: 600,
            },
          ],
          output: {
            destination: 'pvc',
            name: 'market-data-dashboard',
            format: 'xlsx',
            storageSize: '128Mi',
          },
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'ghcr.io/aas-ee/open-web-search:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
              env: WEB_SEARCH_WORKLOAD_ENV,
              egressBindings: WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS,
            },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    label: 'Due Diligence Package (PDF+Excel)',
    json: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'due-diligence-package' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: {
            onDemand: {
              allowedActors: ['user', 'autonomous'],
            },
          },
          inputContract: {
            properties: {
              target: { type: 'string', default: 'Anthropic (AI safety company)' },
              scope: {
                type: 'string',
                default: 'technology, team, funding, market position, risks',
              },
              depth: { type: 'string', default: 'comprehensive' },
            },
          },
          mcpServers: [{ id: 'web-search' }],
          steps: [
            {
              id: 'research-company',
              instruction:
                'Perform deep research on: {{inputs.target}}.\n' +
                'Scope: {{inputs.scope}}. Depth: {{inputs.depth}}.\n\n' +
                `${DEFAULT_WEB_SEARCH_ENGINE_GUIDANCE}\n\n` +
                'Use search extensively. Research:\n' +
                '1. Company overview: founding date, HQ, mission, key products\n' +
                '2. Leadership team: founders, C-suite, board members\n' +
                '3. Funding history: all rounds, investors, valuations\n' +
                '4. Technology: core products, patents, open source\n' +
                '5. Market position: competitors, market share\n' +
                '6. Revenue model: pricing, customers, ARR estimates\n' +
                '7. Recent news: last 6 months of announcements',
              mcpServers: ['web-search'],
              allowedTools: {
                include: ['web-search__search'],
              },
              timeoutSeconds: 600,
            },
            {
              id: 'research-risks',
              instruction:
                'Research risks and concerns about: {{inputs.target}}.\n\n' +
                `${DEFAULT_WEB_SEARCH_ENGINE_GUIDANCE}\n\n` +
                'Use search to investigate:\n' +
                '1. Regulatory risks: pending legislation, compliance\n' +
                '2. Legal issues: lawsuits, IP disputes\n' +
                '3. Technical risks: security incidents, outages\n' +
                '4. Market risks: competitor threats, disruption\n' +
                '5. Team risks: key person dependency, departures\n' +
                '6. Financial risks: burn rate, funding runway\n' +
                '7. Reputation: controversies, negative press\n\n' +
                'For each risk, assess: severity (low/medium/high), likelihood, mitigation.',
              mcpServers: ['web-search'],
              allowedTools: { include: ['web-search__search'] },
              timeoutSeconds: 600,
            },
            {
              id: 'synthesize-analysis',
              instruction:
                'Synthesize a comprehensive due diligence analysis:\n\n' +
                '=== COMPANY RESEARCH ===\n{{research-company:output}}\n\n' +
                '=== RISK ASSESSMENT ===\n{{research-risks:output}}\n\n' +
                'Produce:\n1. Executive Summary (1 page)\n' +
                '2. Company Scorecard: rate 1-10 on Technology, Team, Market, Financials, Risk\n' +
                '3. SWOT Analysis\n4. Detailed findings by scope area\n' +
                '5. Risk matrix (severity x likelihood)\n' +
                '6. Bull case vs Bear case\n' +
                '7. Unanswered questions for further DD\n' +
                '8. Recommendation: Strong Buy / Buy / Hold / Avoid\n\n' +
                'Structure ALL quantitative data as tables.',
              dependsOn: ['research-company', 'research-risks'],
              timeoutSeconds: 600,
            },
            {
              id: 'generate-pdf-report',
              instruction:
                'You MUST call the clerum__generate_pdf tool to generate a professional Due Diligence PDF report.\n\n' +
                'Title: "Due Diligence Report: {{inputs.target}}"\n\n' +
                '{{synthesize-analysis:output}}\n\n' +
                'Format as a professional investment memo with cover page, ' +
                'table of contents, full analysis, risk matrix, scorecard, ' +
                'and appendix with methodology.',
              allowedTools: { include: ['clerum__generate_pdf'] },
              dependsOn: ['synthesize-analysis'],
              timeoutSeconds: 600,
            },
            {
              id: 'generate-excel-data',
              instruction:
                'You MUST call the clerum__generate_xlsx tool to generate an Excel workbook ' +
                'with all quantitative data:\n\n' +
                '{{synthesize-analysis:output}}\n\n' +
                'filename: "dd-data-{{inputs.target}}.xlsx"\n' +
                'sheets:\n' +
                'Sheet 1 "Scorecard": Company metrics with scores 1-10\n' +
                'Sheet 2 "Funding History": All rounds with date, amount, investors\n' +
                'Sheet 3 "Risk Matrix": Each risk with severity, likelihood, mitigation\n' +
                'Sheet 4 "Competitor Comparison": Feature comparison table\n' +
                'Sheet 5 "SWOT": Structured format\n' +
                'Sheet 6 "Key Metrics": All financial/operational metrics\n' +
                'Sheet 7 "Questions": Open questions for further DD',
              allowedTools: { include: ['clerum__generate_xlsx'] },
              dependsOn: ['synthesize-analysis'],
              timeoutSeconds: 600,
            },
          ],
          output: {
            destination: 'pvc',
            name: 'due-diligence-package',
            format: 'multi',
            storageSize: '512Mi',
          },
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'ghcr.io/aas-ee/open-web-search:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
              env: WEB_SEARCH_WORKLOAD_ENV,
              egressBindings: WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS,
            },
          ],
        },
      },
      null,
      2
    ),
  },
]

const EXAMPLE_JSON = TEMPLATES[0].json

function getVisibleTemplates(): RecipeTemplate[] {
  const showLocalTemplates = process.env.NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES === 'true'
  return TEMPLATES.filter(template => !template.localOnly || showLocalTemplates)
}

/* ── Secret detection ──────────────────────────────────────────────────────── */

interface DetectedSecret {
  secretName: string
  targetNamespaces: string[]
  keys: Array<{
    secretKey: string
    label: string
    targetNamespaces: string[]
  }>
}

/**
 * Scan a parsed WorkflowRecipe manifest for Kubernetes Secret references owned
 * by the recipe. The CRD carries only references; values are completed after
 * recipe creation from the dedicated Secrets UI.
 */
export function extractSecrets(
  parsed: Record<string, unknown>,
  sandboxNs: string,
  mcpServerNs: string
): DetectedSecret[] {
  const spec = parsed.spec as Record<string, unknown> | undefined
  const secretMap = new Map<string, DetectedSecret>()

  const addSecretKey = (
    secretName: string | undefined,
    secretKey: string | undefined,
    namespace: string,
    label?: string
  ) => {
    if (!secretName || !secretKey) return
    const displayLabel = label || secretKey
    const existing = secretMap.get(secretName)
    if (!existing) {
      secretMap.set(secretName, {
        secretName,
        targetNamespaces: [namespace],
        keys: [{ secretKey, label: displayLabel, targetNamespaces: [namespace] }],
      })
      return
    }
    if (!existing.targetNamespaces.includes(namespace)) {
      existing.targetNamespaces.push(namespace)
    }
    const existingKey = existing.keys.find(k => k.secretKey === secretKey)
    if (!existingKey) {
      existing.keys.push({
        secretKey,
        label: displayLabel,
        targetNamespaces: [namespace],
      })
    } else if (!existingKey.targetNamespaces.includes(namespace)) {
      existingKey.targetNamespaces.push(namespace)
    }
  }

  const steps = spec?.steps as Array<Record<string, unknown>> | undefined
  for (const step of steps ?? []) {
    const run = step.run as Record<string, unknown> | undefined
    if (run?.type !== 'snippet') continue
    const capabilities = run.capabilities as Record<string, unknown> | undefined
    const secrets = capabilities?.secrets as
      | Array<{
          alias?: string
          secretRef?: { name?: string; key?: string }
        }>
      | undefined
    if (!secrets) continue

    for (const secret of secrets) {
      const secretName = secret.secretRef?.name
      const secretKey = secret.secretRef?.key
      const label = secret.alias ? `${secret.alias}` : secretKey
      addSecretKey(secretName, secretKey, sandboxNs, label)
    }
  }

  const workloads = spec?.workloads as Array<Record<string, unknown>> | undefined
  const uiRef = (spec?.ui as Record<string, unknown> | undefined)?.workloadRef
  for (const workload of workloads ?? []) {
    const envSecret = workload.envSecret as
      { name?: string; keys?: Array<{ secretKey?: string; envVar?: string }> } | undefined
    if (!envSecret?.name || !Array.isArray(envSecret.keys)) continue
    const namespace =
      workload.transport !== undefined && workload.transport !== null
        ? mcpServerNs
        : typeof uiRef === 'string' && uiRef && workload.id === uiRef
          ? 'sandbox-ui'
          : sandboxNs
    for (const key of envSecret.keys) {
      addSecretKey(envSecret.name, key.secretKey, namespace, key.envVar || key.secretKey)
    }
  }

  const oauthClients = spec?.oauthClients as
    | Array<{
        clientIdRef?: { name?: string; key?: string }
        clientSecretRef?: { name?: string; key?: string }
      }>
    | undefined
  for (const client of oauthClients ?? []) {
    addSecretKey(client.clientIdRef?.name, client.clientIdRef?.key, sandboxNs)
    addSecretKey(client.clientSecretRef?.name, client.clientSecretRef?.key, sandboxNs)
  }

  return Array.from(secretMap.values())
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const { showToast } = useToast()
  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      showToast('Copied to clipboard.', { tone: 'success' })
    })
  }
  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      style={{
        padding: '2px 8px',
        borderRadius: 4,
        border: '1px solid var(--cu-border)',
        background: 'var(--cu-bg-elevated)',
        color: 'var(--cu-text-soft)',
        cursor: 'pointer',
        fontSize: '0.75rem',
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  )
}

type Step = 'input' | 'validate' | 'defaults' | 'confirm'

const EDITOR_STEP_ORDER: Step[] = ['input', 'validate', 'defaults', 'confirm']

const EDITOR_STEP_LABELS = ['Manifest', 'Review', 'Defaults', 'Access & deploy'] as const

const EDITOR_STEP_DETAILS = [
  {
    description: 'Paste or edit the manifest',
    title: 'Plugin manifest',
    subtitle: 'Paste or edit the WorkflowRecipe JSON and approval settings.',
  },
  {
    description: 'Policy, secrets, and egress',
    title: 'Review findings',
    subtitle: 'Check manifest structure, policy, secrets, and egress before deploy.',
  },
  {
    description: 'Review platform defaults',
    title: 'Operator defaults',
    subtitle: 'Review platform defaults and generated changes before deploy.',
  },
  {
    description: 'Set access and deploy',
    title: 'Access & deploy',
    subtitle: 'Set trigger access, provide required secrets, and deploy the plugin.',
  },
] as const

/* ── Per-step requiresApproval form ──────────────────────────────────────── */

type ApprovalFormState = {
  enabled: boolean
  targetKind: 'userId' | 'teamId'
  targetValue: string
  message: string
  timeoutSeconds: number
  errors: { target?: string; message?: string }
}

function deriveApprovalFormState(step: Record<string, unknown> | undefined): ApprovalFormState {
  const ra = step?.requiresApproval as Record<string, unknown> | undefined
  if (!ra || typeof ra !== 'object') {
    return {
      enabled: false,
      targetKind: 'userId',
      targetValue: '',
      message: '',
      timeoutSeconds: 3600,
      errors: {},
    }
  }
  const target = (ra.target as Record<string, unknown> | undefined) ?? {}
  const userId = typeof target.userId === 'string' ? target.userId : ''
  const teamId = typeof target.teamId === 'string' ? target.teamId : ''
  const targetKind: 'userId' | 'teamId' = teamId && !userId ? 'teamId' : 'userId'
  return {
    enabled: true,
    targetKind,
    targetValue: targetKind === 'teamId' ? teamId : userId,
    message: typeof ra.message === 'string' ? ra.message : '',
    timeoutSeconds:
      typeof ra.timeoutSeconds === 'number' && Number.isFinite(ra.timeoutSeconds)
        ? (ra.timeoutSeconds as number)
        : 3600,
    errors: {},
  }
}

function serializeApproval(s: ApprovalFormState): {
  target: { userId?: string; teamId?: string }
  message: string
  timeoutSeconds: number
} | null {
  if (!s.enabled) return null
  const trimmed = s.targetValue.trim()
  if (!trimmed || !s.message.trim()) return null
  const target = s.targetKind === 'teamId' ? { teamId: trimmed } : { userId: trimmed }
  return { target, message: s.message, timeoutSeconds: s.timeoutSeconds }
}

function StepsApprovalPanel({
  jsonInput,
  onChange,
  onValidationChange,
  selectedApprovalTeamIds,
}: {
  jsonInput: string
  onChange: (next: string) => void
  onValidationChange: (hasErrors: boolean) => void
  selectedApprovalTeamIds: string[]
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [approvalUsers, setApprovalUsers] = useState<AdminUser[] | null>(null)
  const [approvalTeams, setApprovalTeams] = useState<TeamListItem[] | null>(null)
  const [directoryError, setDirectoryError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [users, teams] = await Promise.all([getAdminUsers(''), getAdminTeams()])
        if (cancelled) return
        setApprovalUsers(users.items ?? [])
        setApprovalTeams(teams.items ?? [])
        setDirectoryError(null)
      } catch (error) {
        if (cancelled) return
        setDirectoryError(
          error instanceof Error ? error.message : 'Failed to load approval targets'
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Try parsing the current JSON; if it fails, we render nothing but hooks still run.
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(jsonInput) as Record<string, unknown>
  } catch {
    parsed = null
  }
  const spec = (parsed?.spec as Record<string, unknown> | undefined) ?? undefined
  const steps = Array.isArray(spec?.steps)
    ? (spec!.steps as Array<Record<string, unknown>>)
    : undefined

  // Aggregate validation errors to lift up. Must run unconditionally (rules of hooks).
  let anyError = false
  if (steps) {
    for (const s of steps) {
      const ra = s.requiresApproval as Record<string, unknown> | undefined
      if (!ra) continue
      const target = ra.target as Record<string, unknown> | undefined
      const userId = typeof target?.userId === 'string' ? target.userId.trim() : ''
      const teamId = typeof target?.teamId === 'string' ? target.teamId.trim() : ''
      const message = typeof ra.message === 'string' ? ra.message.trim() : ''
      if (!userId && !teamId) anyError = true
      if (!message) anyError = true
    }
  }
  React.useEffect(() => {
    onValidationChange(anyError)
  }, [anyError, onValidationChange])

  if (!steps || steps.length === 0) {
    return null
  }

  function updateStep(index: number, next: ApprovalFormState) {
    if (!parsed) return
    const parsedCopy = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
    const specCopy = parsedCopy.spec as Record<string, unknown>
    const stepsCopy = specCopy.steps as Array<Record<string, unknown>>
    const stepCopy = { ...stepsCopy[index] }
    if (!next.enabled) {
      delete stepCopy.requiresApproval
    } else {
      const serialized = serializeApproval(next)
      if (serialized) {
        stepCopy.requiresApproval = serialized
      } else {
        // Enabled but incomplete — still persist a draft so validation can report errors.
        const targetObj: Record<string, string> = {}
        if (next.targetValue.trim()) {
          targetObj[next.targetKind] = next.targetValue.trim()
        }
        stepCopy.requiresApproval = {
          target: targetObj,
          message: next.message,
          timeoutSeconds: next.timeoutSeconds,
        }
      }
    }
    stepsCopy[index] = stepCopy
    onChange(JSON.stringify(parsedCopy, null, 2))
  }

  return (
    <div className="cu-steps-approval">
      <div className="cu-steps-approval__title">Steps — Approval Gating</div>
      <div className="cu-steps-approval__list">
        {steps.map((step, i) => {
          const stepId = (step.id as string) ?? `step-${i}`
          const form = deriveApprovalFormState(step)
          const isOpen = expanded[stepId] ?? false
          return (
            <div
              key={stepId}
              data-testid={`step-approval-${stepId}`}
              className="cu-steps-approval__item"
            >
              <button
                type="button"
                onClick={() => setExpanded(prev => ({ ...prev, [stepId]: !isOpen }))}
                className="cu-steps-approval__toggle"
              >
                <span>{isOpen ? '\u25BC' : '\u25B6'}</span>
                <span>Step: {stepId}</span>
                {form.enabled && (
                  <span className="cu-steps-approval__badge">approval required</span>
                )}
              </button>

              {isOpen && (
                <div className="cu-steps-approval__body">
                  <label className="cu-steps-approval__check">
                    <input
                      type="checkbox"
                      aria-label={`Requires human approval before step runs (${stepId})`}
                      checked={form.enabled}
                      onChange={e => updateStep(i, { ...form, enabled: e.target.checked })}
                    />
                    Requires human approval before step runs
                  </label>

                  {form.enabled && (
                    <div
                      data-testid={`approval-fields-${stepId}`}
                      className="cu-steps-approval__fields"
                    >
                      <div className="cu-steps-approval__target-kind">
                        <label className="cu-steps-approval__radio">
                          <input
                            type="radio"
                            name={`approval-target-kind-${stepId}`}
                            value="userId"
                            checked={form.targetKind === 'userId'}
                            onChange={() =>
                              updateStep(i, { ...form, targetKind: 'userId', targetValue: '' })
                            }
                          />
                          User ID
                        </label>
                        <label className="cu-steps-approval__radio">
                          <input
                            type="radio"
                            name={`approval-target-kind-${stepId}`}
                            value="teamId"
                            checked={form.targetKind === 'teamId'}
                            onChange={() =>
                              updateStep(i, { ...form, targetKind: 'teamId', targetValue: '' })
                            }
                          />
                          Team ID
                        </label>
                      </div>

                      {directoryError && (
                        <div role="alert" className="cu-field__error">
                          {directoryError}. Manual id entry remains available.
                        </div>
                      )}

                      {form.targetKind === 'userId' &&
                        approvalUsers &&
                        approvalUsers.length > 0 && (
                          <label className="cu-steps-approval__field">
                            Known user
                            <select
                              className="cu-input cu-input--compact"
                              aria-label={`Known approval user (${stepId})`}
                              value={
                                approvalUsers.some(user => user.id === form.targetValue)
                                  ? form.targetValue
                                  : ''
                              }
                              onChange={e =>
                                updateStep(i, { ...form, targetValue: e.target.value })
                              }
                            >
                              <option value="">Select a user or enter an id below</option>
                              {approvalUsers.map(user => (
                                <option key={user.id} value={user.id}>
                                  {user.displayName || user.name || user.email} ({user.email})
                                </option>
                              ))}
                            </select>
                          </label>
                        )}

                      {form.targetKind === 'teamId' &&
                        approvalTeams &&
                        approvalTeams.length > 0 && (
                          <label className="cu-steps-approval__field">
                            Known team
                            <select
                              className="cu-input cu-input--compact"
                              aria-label={`Known approval team (${stepId})`}
                              value={
                                approvalTeams.some(team => team.id === form.targetValue)
                                  ? form.targetValue
                                  : ''
                              }
                              onChange={e =>
                                updateStep(i, { ...form, targetValue: e.target.value })
                              }
                            >
                              <option value="">Select a team or enter an id below</option>
                              {approvalTeams.map(team => (
                                <option key={team.id} value={team.id}>
                                  {team.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}

                      <label className="cu-steps-approval__field">
                        {form.targetKind === 'teamId' ? 'Team ID' : 'User ID'}
                        <input
                          type="text"
                          aria-label={`Approval target value (${stepId})`}
                          value={form.targetValue}
                          onChange={e => updateStep(i, { ...form, targetValue: e.target.value })}
                          className="cu-steps-approval__input"
                        />
                        {!form.targetValue.trim() && (
                          <span className="cu-recipe-inline-error">
                            Required when approval is enabled.
                          </span>
                        )}
                        {form.targetKind === 'teamId' &&
                          form.targetValue.trim() &&
                          !selectedApprovalTeamIds.includes(form.targetValue.trim()) && (
                            <span className="cu-field__hint">
                              This team is selected as an approval target but is not yet in the
                              Approval target teams access section.
                            </span>
                          )}
                      </label>

                      <label className="cu-steps-approval__field">
                        Message to approver
                        <textarea
                          aria-label={`Approval message (${stepId})`}
                          value={form.message}
                          maxLength={2000}
                          rows={3}
                          onChange={e => updateStep(i, { ...form, message: e.target.value })}
                          className="cu-steps-approval__input cu-steps-approval__textarea"
                        />
                        {!form.message.trim() && (
                          <span className="cu-recipe-inline-error">
                            Required when approval is enabled.
                          </span>
                        )}
                      </label>

                      <label className="cu-steps-approval__field cu-steps-approval__field--timeout">
                        Timeout (seconds)
                        <input
                          type="number"
                          aria-label={`Approval timeout seconds (${stepId})`}
                          min={30}
                          max={604800}
                          value={form.timeoutSeconds}
                          onChange={e => {
                            const n = Number(e.target.value)
                            updateStep(i, {
                              ...form,
                              timeoutSeconds: Number.isFinite(n) ? n : 3600,
                            })
                          }}
                          className="cu-steps-approval__input"
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function RecipeEditor({ initial, onSaved, onCancel, pageHeader }: Props) {
  const [currentInitial, setCurrentInitial] = useState<WorkflowRecipeResource | undefined>(initial)
  const isEdit = !!currentInitial

  // ── Recipe-secret namespaces (MCC tenant-awareness) ──────────────────────
  // Recipe Secret refs are displayed with the namespace control-api enforces.
  // EDIT mode derives it from the recipe's own namespace synchronously; CREATE
  // mode learns the server's configured namespaces from /admin/auth/me. Both
  // fall back to the bare single-tenant defaults.
  const [fetchedNamespaces, setFetchedNamespaces] = useState<RecipeSecretNamespaces | null>(null)
  useEffect(() => {
    let cancelled = false
    void getControlUINamespaces().then(ns => {
      if (!cancelled) setFetchedNamespaces(ns)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void listCodexSubscriptionConnections()
      .then(rows => {
        if (!cancelled) {
          setCodexConnections(rows)
          setCodexGrantLoadError('')
        }
      })
      .catch(err => {
        if (!cancelled) {
          setCodexConnections([])
          if (!isDisabledCapabilityError(err)) {
            setCodexGrantLoadError(
              err instanceof Error ? err.message : 'Could not load ChatGPT subscriptions'
            )
          } else {
            setCodexGrantLoadError('')
          }
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setCodexConnectionRef(readRecipeCodexGrantAnnotation(currentInitial))
  }, [currentInitial])
  const secretNamespaces = useMemo(
    () =>
      resolveRecipeSecretNamespaces({
        recipeNamespace: currentInitial?.metadata?.namespace,
        fetched: fetchedNamespaces,
      }),
    [currentInitial, fetchedNamespaces]
  )

  const [jsonInput, setJsonInput] = useState<string>(() => {
    if (initial) {
      return JSON.stringify(initial, null, 2)
    }
    return EXAMPLE_JSON
  })
  const [codexConnections, setCodexConnections] = useState<CodexSubscriptionConnectionView[]>([])
  const [codexGrantLoadError, setCodexGrantLoadError] = useState('')
  const [codexConnectionRef, setCodexConnectionRef] = useState(() =>
    readRecipeCodexGrantAnnotation(initial)
  )

  const [step, setStep] = useState<Step>('input')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [defaults, setDefaults] = useState<OperatorDefaults>(DEFAULT_OPERATOR_DEFAULTS)
  const [enrichment, setEnrichment] = useState<EnrichmentResult | null>(null)
  const [showDefaults, setShowDefaults] = useState(false)
  const [deployPhase, setDeployPhase] = useState<DeployPhase>('idle')
  const [deployError, setDeployError] = useState('')
  const [detectedSecrets, setDetectedSecrets] = useState<DetectedSecret[]>([])
  const visibleTemplates = getVisibleTemplates()
  const [secretsExpanded, setSecretsExpanded] = useState(true)
  const [approvalHasErrors, setApprovalHasErrors] = useState(false)
  const [egressEditError, setEgressEditError] = useState('')

  // Workflow access state — lifted from the panel so handleDeploy can read
  // buffered create-mode selections and the panel can reflect live server
  // state in edit mode.
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([])
  const [selectedApprovalTeamIds, setSelectedApprovalTeamIds] = useState<string[]>([])
  const [accessInlineError, setAccessInlineError] = useState<string | null>(null)

  // Server-side (L2) validation result — only set when `handleDeploy`
  // calls `validateRecipeServer` at submit time. L2 is NOT debounced on
  // typing; it runs exactly on the Deploy click.
  const [serverValidation, setServerValidation] = useState<{
    valid: boolean
    errors?: ServerValidationError[]
  } | null>(null)

  // L1 live check — re-derives on every keystroke via cheap JSON.parse.
  // Silent when JSON is invalid (the client validator handles structural
  // errors). Covers only the three recipe fields that don't need cluster
  // state: isAgentic, hasContextRef, security.allowContextRef.
  const l1Live = useMemo<ServerValidationError | null>(() => {
    try {
      const parsed = JSON.parse(jsonInput) as { spec?: unknown }
      return checkPolicyL1(parsed)
    } catch {
      return null
    }
  }, [jsonInput])

  const isCodexRecipe = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonInput) as { spec?: unknown }
      return readRecipeAgentProvider(parsed.spec) === OPENAI_SUBSCRIPTION_PROVIDER
    } catch {
      return false
    }
  }, [jsonInput])

  const codexGrantOptions = useMemo<LlmSecretSelectOption[]>(() => {
    const options: LlmSecretSelectOption[] = codexConnections
      .filter(isAssignableCodexGrant)
      .map(row => ({
        group: 'ChatGPT subscriptions',
        value: credentialSelectValue('', row.connectionKey),
        label: row.displayName || row.connectionKey,
        meta: 'ChatGPT subscription',
        providers: [{ id: 'codex-subscription', label: 'ChatGPT Subscription' }],
      }))
    if (
      codexConnectionRef &&
      codexConnectionRef !== CODEX_UNASSIGNED_CONNECTION_KEY &&
      !codexConnections.some(
        row => row.connectionKey === codexConnectionRef && isAssignableCodexGrant(row)
      )
    ) {
      options.unshift({
        group: 'ChatGPT subscriptions',
        value: credentialSelectValue('', codexConnectionRef),
        label: `${codexConnectionRef} (unavailable)`,
        meta: 'ChatGPT subscription',
        providers: [{ id: 'codex-subscription', label: 'ChatGPT Subscription' }],
      })
    }
    return options
  }, [codexConnections, codexConnectionRef])

  const deploying = deployPhase !== 'idle'

  // If the resolved recipe-secret namespaces change after refs were detected
  // (e.g. the CREATE-mode /admin/auth/me fetch resolves), re-stamp the displayed
  // target namespaces.
  useEffect(() => {
    setDetectedSecrets(prev => {
      if (prev.length === 0 || !validation?.parsed) return prev
      return extractSecrets(
        validation.parsed as Record<string, unknown>,
        secretNamespaces.sandbox,
        secretNamespaces.mcpServer
      )
    })
    // Re-stamp only on namespace change; handleValidate re-detects on (re)validation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretNamespaces])

  function handleValidate() {
    const result = validateRecipe(jsonInput, defaults)
    setValidation(result)
    setEnrichment(null)
    setStep('validate')
    setEgressEditError('')

    // Detect secrets when validation passes
    const hasErr = result.issues.some(i => i.severity === 'error')
    if (!hasErr && result.parsed) {
      setDetectedSecrets(
        extractSecrets(
          result.parsed as Record<string, unknown>,
          secretNamespaces.sandbox,
          secretNamespaces.mcpServer
        )
      )
    } else {
      setDetectedSecrets([])
    }
  }

  function handleApplyDefaults() {
    if (!validation?.parsed?.spec) return
    const result = applyDefaults(validation.parsed.spec, defaults)
    setEnrichment(result)
    setStep('defaults')
  }

  function handleProceedToConfirm() {
    setStep('confirm')
  }

  async function handleDeploy() {
    // L1 is a parallel check to the existing structural validator. Button is
    // already disabled when l1Live is non-null, but we re-check defensively
    // in case the user bypasses by keyboard shortcut.
    if (l1Live) {
      setServerValidation({ valid: false, errors: [l1Live] })
      return
    }

    setDeployError('')
    setServerValidation(null)
    setAccessInlineError(null)

    const name = validation?.parsed?.metadata?.name ?? ''
    const specToUse = enrichment
      ? (enrichment.enriched as Record<string, unknown>)
      : (validation?.parsed?.spec as Record<string, unknown>)
    const bodyMeta = (validation?.parsed?.metadata ?? { name }) as {
      name: string
      namespace?: string
    }
    const grantAnnotations = recipeGrantAnnotations(
      readRecipeAgentProvider(specToUse),
      codexConnectionRef
    )

    try {
      // Resolve namespaces before grants fallback below. Secret values are not
      // materialized here: declarative refs are allowed to remain pending until
      // the operator completes them from the dedicated Secrets UI.
      let nsPair = secretNamespaces
      if (!isEdit && fetchedNamespaces === null) {
        const fetched = await getControlUINamespaces()
        setFetchedNamespaces(fetched)
        nsPair = resolveRecipeSecretNamespaces({
          recipeNamespace: currentInitial?.metadata?.namespace,
          fetched,
        })
      }
      // L2 decides if the CRD is structurally and policy-valid. Missing
      // declarative Secret refs come back as pending credentials and do not
      // block creation; real validation errors still fail closed here.
      const brokerError = brokerBackedRecipeAuthoringError(specToUse, codexConnectionRef)
      if (brokerError) {
        setServerValidation({
          valid: false,
          errors: [{ field: 'spec.agent', rule: 'codexBrokerAuthoring', message: brokerError }],
        })
        return
      }

      setDeployPhase('validating')
      const l2 = await validateRecipeServer(
        {
          metadata: { name: bodyMeta.name, annotations: grantAnnotations },
          spec: specToUse,
        },
        { mode: isEdit ? 'edit' : 'create' }
      )
      if (!l2.valid) {
        setServerValidation(l2)
        setDeployPhase('idle')
        return
      }

      if (isEdit) {
        setDeployPhase('creating')
        await updateRecipe(name, {
          spec: specToUse,
          metadata: { annotations: grantAnnotations },
        })
        setDetectedSecrets([])
        // Edit-mode workflow access is already persisted live by the panel on
        // each click; nothing to do here.
        setDeployPhase('idle')
        onSaved()
        return
      }

      // Create flow. The admin API decides the CRD storage namespace server-
      // side (Phase 8 split). Response body carries the resolved namespace
      // so the grants PUT can target it exactly without client inference.
      setDeployPhase('creating')
      const created = await createRecipe({
        metadata: { name, annotations: grantAnnotations },
        spec: specToUse,
      })
      setDetectedSecrets([])

      if (
        selectedUserIds.length > 0 ||
        selectedTeamIds.length > 0 ||
        selectedApprovalTeamIds.length > 0
      ) {
        setDeployPhase('saving-access')
        const ns = created?.metadata?.namespace ?? nsPair.sandbox
        try {
          const errors: string[] = []
          await setWorkflowGrants(ns, name, selectedUserIds)
          await setWorkflowTeamGrants(ns, name, selectedTeamIds)
          for (const teamId of selectedApprovalTeamIds) {
            try {
              await allowWorkflowApprovalTeam(ns, name, teamId)
            } catch (error) {
              errors.push(error instanceof Error ? error.message : String(error))
            }
          }
          if (errors.length > 0) {
            throw new Error(errors.join('; '))
          }
        } catch (e) {
          // Flow E: create succeeded, workflow access did not. Transition
          // editor into Edit mode with the created recipe preloaded so the
          // panel switches to live-save semantics and keeps selections visible.
          setCurrentInitial(created)
          setAccessInlineError(
            `Recipe created but workflow access could not be saved: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
          setDeployPhase('idle')
          return
        }
      }
      setDeployPhase('idle')
      onSaved()
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : 'Deploy failed')
      setDeployPhase('idle')
    }
  }

  const hasErrors = validation?.issues.some(i => i.severity === 'error') ?? false
  const errorIssues = validation?.issues.filter(i => i.severity === 'error') ?? []
  const warningIssues = validation?.issues.filter(i => i.severity === 'warning') ?? []
  const infoIssues = validation?.issues.filter(i => i.severity === 'info') ?? []
  const egressFindings = validation?.parsed ? analyzeWorkflowRecipeEgress(validation.parsed) : []
  const transportEgressTargets = validation?.parsed
    ? workflowTransportWorkloads(validation.parsed)
    : []
  const errorCount = errorIssues.length
  const warningCount = warningIssues.length
  const infoCount = infoIssues.length
  const serverValidationMessages =
    serverValidation?.valid === false
      ? Array.from(new Set((serverValidation.errors ?? []).map(err => err.message)))
      : []
  const renderIssueGroup = (
    title: string,
    issues: NonNullable<ValidationResult['issues']>,
    tone: 'error' | 'warning' | 'info'
  ) => {
    if (issues.length === 0) return null
    return (
      <div className={`cu-recipe-issue-group cu-recipe-issue-group--${tone}`}>
        <div className="cu-recipe-issue-group__title">{title}</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {issues.map((issue, i) => (
            <li
              key={`${issue.severity}-${issue.phase}-${issue.path ?? ''}-${i}`}
              className="cu-recipe-issue-group__item"
            >
              <strong>[{issue.phase}]</strong>
              {issue.path ? ` ${issue.path}:` : ''} {issue.message}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const updateWorkflowEgress = useCallback(
    (target: TransportWorkloadEditorTarget, bindings: EgressBinding[] | undefined) => {
      try {
        const nextJson = applyWorkflowWorkloadEgress(jsonInput, target.index, bindings)
        const nextValidation = validateRecipe(nextJson, defaults)
        setJsonInput(nextJson)
        setValidation(nextValidation)
        setEnrichment(null)
        setDetectedSecrets([])
        setStep('validate')
        setEgressEditError('')
      } catch (error) {
        setEgressEditError(error instanceof Error ? error.message : String(error))
      }
    },
    [defaults, jsonInput]
  )

  const currentEditorStep = Math.max(0, EDITOR_STEP_ORDER.indexOf(step))
  function canSelectEditorStep(targetStep: number) {
    if (targetStep <= currentEditorStep) return true
    if (targetStep === 1) return jsonInput.trim().length > 0
    if (targetStep === 2) return Boolean(validation && !hasErrors)
    return Boolean(validation && !hasErrors)
  }

  function handleEditorStepChange(targetStep: number) {
    const nextStep = EDITOR_STEP_ORDER[targetStep]
    if (!nextStep) return
    if (nextStep === 'validate' && !validation) {
      handleValidate()
      return
    }
    if (nextStep === 'defaults' && validation && !hasErrors && !enrichment) {
      handleApplyDefaults()
      return
    }
    setStep(nextStep)
  }

  function handleBackAction() {
    if (step === 'input') {
      onCancel()
      return
    }
    const previousStep = EDITOR_STEP_ORDER[Math.max(0, currentEditorStep - 1)]
    if (previousStep) setStep(previousStep)
  }

  function handlePrimaryAction() {
    if (step === 'input') {
      handleValidate()
      return
    }
    if (step === 'validate') {
      handleApplyDefaults()
      return
    }
    if (step === 'defaults') {
      handleProceedToConfirm()
      return
    }
    void handleDeploy()
  }

  const primaryActionLabel =
    step === 'input'
      ? 'Review manifest'
      : step === 'validate'
        ? 'Apply defaults'
        : step === 'defaults'
          ? 'Continue to access'
          : deployPhase === 'validating'
            ? 'Validating…'
            : deployPhase === 'creating'
              ? isEdit
                ? 'Updating…'
                : 'Deploying…'
              : deployPhase === 'saving-access'
                ? 'Saving access…'
                : isEdit
                  ? 'Update plugin'
                  : 'Deploy plugin'

  const primaryActionDisabled =
    (step === 'validate' && (!validation || hasErrors)) ||
    (step === 'confirm' && (deploying || approvalHasErrors || l1Live !== null))

  const primaryActionTitle =
    step === 'confirm'
      ? l1Live
        ? l1Live.message
        : approvalHasErrors
          ? 'Resolve approval configuration errors before deploying'
          : undefined
      : undefined

  const editorContent = (
    <>
      <CreateStepFlow
        ariaLabel="Install plugin steps"
        className="cu-create-step-flow--4"
        currentStep={currentEditorStep}
        onStepChange={handleEditorStepChange}
        canSelectStep={canSelectEditorStep}
        steps={EDITOR_STEP_DETAILS}
        stepLabels={EDITOR_STEP_LABELS}
        titleId="recipe-editor-step-title"
      >
        {!pageHeader ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, color: 'var(--cu-text)' }}>
              {isEdit ? `Edit Plugin: ${currentInitial?.metadata?.name}` : 'Install Plugin'}
            </h3>
            <button
              aria-label="Close editor"
              onClick={onCancel}
              title="Close editor"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--cu-text-soft)',
                cursor: 'pointer',
                fontSize: '1.2rem',
              }}
            >
              ✕
            </button>
          </div>
        ) : null}

        {step === 'input' ? (
          <>
            <div className="cu-recipe-manifest-editor">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label
                    style={{
                      color: 'var(--cu-text-soft)',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                    }}
                  >
                    Recipe JSON (WorkflowRecipe manifest)
                  </label>
                  <CopyButton text={jsonInput} label="Copy" />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.78rem' }}>
                    Templates:
                  </span>
                  <select
                    aria-label="Load recipe template"
                    defaultValue=""
                    onChange={e => {
                      const tpl = visibleTemplates.find(t => t.label === e.target.value)
                      if (tpl) {
                        setJsonInput(tpl.json)
                        setValidation(null)
                        setEnrichment(null)
                        setDetectedSecrets([])
                        setStep('input')
                        e.target.value = ''
                      }
                    }}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--cu-border)',
                      background: 'var(--cu-bg-elevated)',
                      color: 'var(--cu-text-soft)',
                      fontSize: '0.78rem',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="" disabled>
                      — load template —
                    </option>
                    {visibleTemplates.map(t => (
                      <option key={t.label} value={t.label}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <textarea
                className="cu-recipe-manifest-editor__textarea"
                aria-label="Recipe JSON (WorkflowRecipe manifest)"
                value={jsonInput}
                onChange={e => {
                  setJsonInput(e.target.value)
                  setValidation(null)
                  setEnrichment(null)
                  setDetectedSecrets([])
                  setStep('input')
                }}
                spellCheck={false}
              />
            </div>

            <StepsApprovalPanel
              jsonInput={jsonInput}
              onChange={next => {
                setJsonInput(next)
                setValidation(null)
                setEnrichment(null)
                setDetectedSecrets([])
                setStep('input')
              }}
              onValidationChange={setApprovalHasErrors}
              selectedApprovalTeamIds={selectedApprovalTeamIds}
            />

            {approvalHasErrors && (
              <div className="cu-recipe-status-panel cu-recipe-status-panel--error" role="alert">
                One or more steps have approval enabled but are missing target or message.
              </div>
            )}
          </>
        ) : null}

        {/* Validation results */}
        {step === 'validate' && validation && (
          <div
            className={`cu-recipe-status-panel cu-recipe-status-panel--${
              hasErrors ? 'error' : 'success'
            }`}
          >
            <div
              className={`cu-recipe-status-panel__title cu-recipe-status-panel__title--${
                hasErrors ? 'error' : 'success'
              }`}
            >
              {hasErrors
                ? `Manifest review failed — ${errorCount} error(s)${warningCount > 0 ? `, ${warningCount} warning(s)` : ''}`
                : `Manifest review passed${warningCount > 0 ? ` (${warningCount} warning(s))` : infoCount > 0 ? ` (${infoCount} info)` : ''}`}
            </div>
            {renderIssueGroup('Blocking errors', errorIssues, 'error')}
            {renderIssueGroup('Warnings', warningIssues, 'warning')}
            {renderIssueGroup('Informational notes', infoIssues, 'info')}

            {!hasErrors && step === 'validate' && (
              <p className="cu-recipe-status-panel__copy">
                The manifest is ready for operator defaults review.
              </p>
            )}
          </div>
        )}

        {step === 'validate' && validation && transportEgressTargets.length > 0 && (
          <div
            style={{
              border: '1px solid var(--cu-border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--cu-bg-elevated)',
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--cu-text)', marginBottom: 8 }}>
              External Egress Editor
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {transportEgressTargets.map(target => (
                <EgressEditor
                  key={`${target.index}-${target.id}-${JSON.stringify(target.bindings ?? [])}`}
                  initialBindings={target.bindings}
                  emitInitial={false}
                  title={`Transport workload "${target.id}"`}
                  description="Edit this workload's spec.workloads[].egressBindings before deploy."
                  onChange={(bindings: EgressBinding[] | undefined, status: EgressEditorStatus) => {
                    if (status.errors.length > 0) {
                      setEgressEditError(status.errors[0])
                      return
                    }
                    updateWorkflowEgress(target, bindings)
                  }}
                />
              ))}
            </div>
            {egressEditError ? (
              <div className="cu-banner cu-banner--error" role="alert" style={{ marginTop: 10 }}>
                {egressEditError}
              </div>
            ) : null}
          </div>
        )}

        {step === 'validate' && validation && egressFindings.length > 0 && (
          <div
            style={{
              border: '1px solid var(--cu-border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--cu-bg-elevated)',
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--cu-text)', marginBottom: 8 }}>
              External Egress Review
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {egressFindings.map(finding => (
                <div
                  key={finding.key}
                  className={
                    finding.severity === 'error'
                      ? 'cu-banner cu-banner--error'
                      : finding.severity === 'warning'
                        ? 'cu-warning-card'
                        : 'cu-banner cu-banner--info'
                  }
                  role={
                    finding.severity === 'error' || finding.severity === 'warning'
                      ? 'alert'
                      : 'status'
                  }
                >
                  <div style={{ fontWeight: 700 }}>{finding.label}</div>
                  <div>{finding.message}</div>
                  {finding.targets?.length ? (
                    <div style={{ marginTop: 4, color: 'var(--cu-text-muted)' }}>
                      Targets: <code>{finding.targets.join(', ')}</code>
                    </div>
                  ) : null}
                  {finding.ports?.length ? (
                    <div style={{ marginTop: 4, color: 'var(--cu-text-muted)' }}>
                      Ports: <code>{finding.ports.join(', ')}</code>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 'defaults' ? (
          <div>
            <button
              onClick={() => setShowDefaults(v => !v)}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid var(--cu-border)',
                background: showDefaults ? 'var(--cu-accent-muted)' : 'var(--cu-bg-elevated)',
                color: 'var(--cu-text-soft)',
                cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              {showDefaults ? '▲ Hide' : '▼ Show'} Operator Defaults
            </button>
            {showDefaults && (
              <div style={{ marginTop: 10 }}>
                <RecipeDefaultsPanel defaults={defaults} onChange={setDefaults} />
              </div>
            )}
          </div>
        ) : null}

        {step === 'defaults' && enrichment && (
          <div
            style={{
              border: '1px solid var(--cu-border-subtle)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--cu-bg-elevated)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <div style={{ fontWeight: 700, color: 'var(--cu-text-soft)' }}>
                Operator Defaults Applied — {enrichment.diffs.length} change(s)
              </div>
              <CopyButton
                text={JSON.stringify({ ...validation?.parsed, spec: enrichment.enriched }, null, 2)}
                label="Copy Enriched JSON"
              />
            </div>
            {enrichment.diffs.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--cu-text-soft)', fontSize: '0.85rem' }}>
                No changes — recipe already satisfies all operator defaults.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {enrichment.diffs.map((d, i) => (
                  <li
                    key={i}
                    style={{ fontSize: '0.85rem', color: 'var(--cu-text-soft)', marginBottom: 4 }}
                  >
                    <code style={{ color: 'var(--cu-text-soft)' }}>{d.path}</code>
                    {' — '}
                    <span style={{ color: 'var(--cu-text-muted)' }}>{d.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Configure WorkflowRecipe Secrets */}
        {step === 'confirm' && detectedSecrets.length > 0 && !hasErrors && validation && (
          <div
            style={{
              border: '1px solid var(--cu-border)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--cu-bg-elevated)',
            }}
          >
            <button
              onClick={() => setSecretsExpanded(v => !v)}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
              }}
            >
              <span style={{ color: 'var(--cu-text)', fontWeight: 700, fontSize: '0.9rem' }}>
                {secretsExpanded ? '\u25BC' : '\u25B6'} Configuration & Secrets
              </span>
              <span
                style={{
                  background: 'var(--cu-accent-muted)',
                  color: 'var(--cu-text-soft)',
                  padding: '1px 8px',
                  borderRadius: 10,
                  fontSize: '0.75rem',
                  fontWeight: 600,
                }}
              >
                {detectedSecrets.length} secret{detectedSecrets.length > 1 ? 's' : ''} detected
              </span>
            </button>

            {secretsExpanded && (
              <div style={{ marginTop: 12, display: 'grid', gap: 14 }}>
                <div
                  style={{
                    border: '1px solid var(--cu-border)',
                    borderRadius: 6,
                    padding: '8px 10px',
                    background: 'var(--cu-surface-hover)',
                    color: 'var(--cu-text-soft)',
                    fontSize: '0.82rem',
                    lineHeight: 1.45,
                  }}
                >
                  These credential values are not stored from the recipe editor. Deploy the recipe
                  with pending secrets, then add or rotate the real values from Secrets.
                </div>
                {detectedSecrets.map(secret => (
                  <div
                    key={secret.secretName}
                    style={{
                      border: '1px solid var(--cu-border)',
                      borderRadius: 8,
                      padding: 12,
                      background: 'var(--cu-bg-elevated)',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        color: 'var(--cu-text-soft)',
                        fontSize: '0.85rem',
                        marginBottom: 10,
                      }}
                    >
                      Secret: <code style={{ color: 'var(--cu-text)' }}>{secret.secretName}</code>
                      <span
                        style={{
                          color: 'var(--cu-text-muted)',
                          fontWeight: 400,
                          marginLeft: 8,
                          fontSize: '0.78rem',
                        }}
                      >
                        (ns: {secret.targetNamespaces.join(', ')})
                      </span>
                      {isEdit ? (
                        <Link
                          href={CONTROL_ROUTES.secrets.editRecipe(secret.secretName)}
                          style={{
                            marginLeft: 12,
                            fontSize: '0.78rem',
                            fontWeight: 500,
                          }}
                        >
                          Edit stored values →
                        </Link>
                      ) : (
                        <span
                          style={{
                            marginLeft: 12,
                            color: 'var(--cu-text-muted)',
                            fontSize: '0.78rem',
                            fontWeight: 500,
                          }}
                        >
                          Pending after deploy
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'grid', gap: 8 }}>
                      {secret.keys.map(k => (
                        <div key={k.secretKey}>
                          <label
                            style={{
                              display: 'block',
                              color: 'var(--cu-text-soft)',
                              fontSize: '0.8rem',
                              marginBottom: 3,
                            }}
                          >
                            {k.label}{' '}
                            <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.75rem' }}>
                              ({k.secretKey}; ns: {k.targetNamespaces.join(', ')})
                            </span>
                          </label>
                          <div
                            style={{
                              border: '1px solid var(--cu-border)',
                              borderRadius: 6,
                              background: 'var(--cu-bg)',
                              color: 'var(--cu-text-muted)',
                              fontSize: '0.8rem',
                              padding: '7px 10px',
                            }}
                          >
                            Pending secret value
                          </div>
                        </div>
                      ))}
                    </div>

                    <p
                      style={{
                        margin: '10px 0 0 0',
                        color: 'var(--cu-text-muted)',
                        fontSize: '0.75rem',
                        lineHeight: 1.4,
                      }}
                    >
                      Runtime remains pending until the required keys exist in the listed
                      namespaces.
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Workflow access panel — rendered before Deploy so the admin defines
          trigger users, trigger teams, and approval target teams at the same
          moment they define the recipe. Create mode buffers selections; edit
          mode persists each click live via the access APIs. */}
        {step === 'confirm' &&
          (isEdit && currentInitial ? (
            <WorkflowAccessPanel
              mode="edit"
              namespace={currentInitial.metadata?.namespace ?? secretNamespaces.sandbox}
              recipeName={currentInitial.metadata?.name ?? ''}
              selectedUserIds={selectedUserIds}
              selectedTeamIds={selectedTeamIds}
              selectedApprovalTeamIds={selectedApprovalTeamIds}
              onSelectedUserIdsChange={setSelectedUserIds}
              onSelectedTeamIdsChange={setSelectedTeamIds}
              onSelectedApprovalTeamIdsChange={setSelectedApprovalTeamIds}
              inlineError={accessInlineError}
            />
          ) : (
            <WorkflowAccessPanel
              mode="create"
              selectedUserIds={selectedUserIds}
              selectedTeamIds={selectedTeamIds}
              selectedApprovalTeamIds={selectedApprovalTeamIds}
              onSelectedUserIdsChange={setSelectedUserIds}
              onSelectedTeamIdsChange={setSelectedTeamIds}
              onSelectedApprovalTeamIdsChange={setSelectedApprovalTeamIds}
              inlineError={accessInlineError}
              showHeader={false}
            />
          ))}

        {step === 'confirm' && isCodexRecipe ? (
          <div className="cu-recipe-status-panel" data-testid="codex-recipe-grant">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>ChatGPT grant</div>
            <p style={{ margin: '0 0 10px', color: 'var(--cu-text-muted)' }}>
              Choose an existing ChatGPT grant. The recipe stores it as{' '}
              <code>clerum.io/codex-connection-ref</code>.
            </p>
            <LlmSecretSelect
              id="codex-recipe-grant"
              ariaLabel="ChatGPT grant"
              value={credentialSelectValue('', codexConnectionRef)}
              onChange={value => {
                const parsed = parseCredentialSelect(value)
                setCodexConnectionRef(parsed.kind === 'subscription' ? parsed.connectionKey : '')
              }}
              options={codexGrantOptions}
              placeholder="Choose a ChatGPT grant"
            />
            {codexGrantLoadError ? (
              <div className="cu-banner cu-banner--error" role="alert" style={{ marginTop: 10 }}>
                {codexGrantLoadError}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Policy banner — appears when L1 (client) or L2 (server) rejects. */}
        {step === 'confirm' && (l1Live || serverValidationMessages.length > 0) && (
          <div className="cu-recipe-status-panel cu-recipe-status-panel--error" role="alert">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Cannot deploy: policy violation</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {l1Live && (
                <li key="l1" style={{ whiteSpace: 'pre-line' }}>
                  {l1Live.message}
                </li>
              )}
              {serverValidationMessages.map((message, idx) => (
                <li key={`l2-${idx}`} style={{ whiteSpace: 'pre-line' }}>
                  {message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Deploy confirmation */}
        {step === 'confirm' && (
          <div className="cu-recipe-status-panel cu-recipe-status-panel--success">
            <div style={{ marginBottom: 8, color: 'var(--cu-success)', fontWeight: 700 }}>
              Ready to {isEdit ? 'update' : 'deploy'} &quot;{validation?.parsed?.metadata?.name}
              &quot;
            </div>

            {/*
            Workflow access advisory — only in create mode, only when no users
            or teams were authorized in the access panel above. Non-blocking: the
            recipe still deploys, but it becomes invisible to every Desktop App
            user because trigger authorization rejects callers without a direct
            user grant or context-bound team grant. Admins can still see it in
            the Control UI, so this often goes unnoticed until a user asks why
            the recipe isn't in their list.
          */}
            {!isEdit && selectedUserIds.length === 0 && selectedTeamIds.length === 0 && (
              <div
                data-testid="access-empty-warning"
                role="status"
                className="cu-recipe-access-warning"
              >
                <div style={{ fontWeight: 700, marginBottom: 2 }}>
                  No trigger access — recipe will not appear in any Desktop App
                </div>
                <div className="cu-recipe-access-warning__copy">
                  Deploy will succeed, but end users can&apos;t trigger this workflow until you add
                  a trigger user or trigger team in the access panel above. You can add access later
                  from the recipes list.
                </div>
              </div>
            )}
          </div>
        )}

        <div className="cu-create-actions">
          <Button onClick={handleBackAction} size="sm" variant="ghost" disabled={deploying}>
            {step === 'input' ? 'Cancel' : 'Back'}
          </Button>
          <Button
            disabled={primaryActionDisabled}
            onClick={handlePrimaryAction}
            size="sm"
            title={primaryActionTitle}
            variant="primary"
          >
            {primaryActionLabel}
          </Button>
          {step === 'confirm' && deployError ? (
            <span className="cu-recipe-deploy-error">{deployError}</span>
          ) : null}
        </div>
      </CreateStepFlow>
    </>
  )

  if (pageHeader) {
    return <CreateFlowPanel header={pageHeader}>{editorContent}</CreateFlowPanel>
  }

  return <div className="cu-agent-create-panel">{editorContent}</div>
}
