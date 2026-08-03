import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES,
  WORKFLOW_RECIPE_DENIED_CAPABILITIES,
} from '@clerum/workflow-recipe-capability-policy'

const crdPath = path.resolve(__dirname, '../../../../charts/clerum-crds/crds/workflowrecipe.yaml')
const mcpServerCrdPath = path.resolve(
  __dirname,
  '../../../../charts/clerum-crds/crds/mcpserver.yaml'
)

type JsonObject = Record<string, unknown>

function readYamlObject(filePath: string): JsonObject {
  const parsed = load(fs.readFileSync(filePath, 'utf8'))
  expect(parsed).toEqual(expect.any(Object))
  return parsed as JsonObject
}

function readSchemaPath(root: JsonObject, schemaPath: Array<string | number>): unknown {
  return schemaPath.reduce<unknown>((current, segment) => {
    expect(current).toEqual(expect.any(Object))
    return (current as Record<string | number, unknown>)[segment]
  }, root)
}

function readEnum(root: JsonObject, schemaPath: Array<string | number>): string[] {
  const enumValues = readSchemaPath(root, schemaPath)
  expect(Array.isArray(enumValues)).toBe(true)
  return enumValues as string[]
}

function readCrdVersionSchema(root: JsonObject, versionName = 'v1alpha1'): JsonObject {
  const versions = readSchemaPath(root, ['spec', 'versions'])
  expect(Array.isArray(versions)).toBe(true)

  const version = (versions as JsonObject[]).find(candidate => candidate.name === versionName)
  expect(version).toEqual(expect.any(Object))
  return readSchemaPath(version as JsonObject, ['schema', 'openAPIV3Schema']) as JsonObject
}

describe('WorkflowRecipe CRD snippet step schema', () => {
  const crd = fs.readFileSync(crdPath, 'utf8')
  const mcpServerCrd = fs.readFileSync(mcpServerCrdPath, 'utf8')
  const crdObject = readYamlObject(crdPath)
  const mcpServerCrdObject = readYamlObject(mcpServerCrdPath)
  const workflowRecipeSchema = readCrdVersionSchema(crdObject)
  const mcpServerSchema = readCrdVersionSchema(mcpServerCrdObject)

  it('defines snippet-only run steps', () => {
    expect(crd).toContain('run:')
    expect(crd).toMatch(/message: ['"]run must define type=snippet with language and code['"]/)
    expect(crd).toContain('enum: [snippet]')
    expect(crd).toContain('code:')
  })

  it('keeps built-in step shape strict while allowing custom coordinator id-only steps', () => {
    expect(crd).toContain('!(has(self.run) && has(self.instruction))')
    expect(crd).toContain(
      'has(self.coordinatorImage) || self.steps.all(s, has(s.run) != has(s.instruction))'
    )
    expect(crd).toContain(
      'step must have exactly one of: run, instruction unless spec.coordinatorImage is set'
    )
  })

  it('does not require instruction on every step', () => {
    const stepsItemStart = crd.indexOf('                steps:')
    const runStart = crd.indexOf('                      run:', stepsItemStart)
    const stepsItem = crd.slice(stepsItemStart, runStart)
    expect(stepsItem).toContain('required:')
    expect(stepsItem).toContain('- id')
    expect(stepsItem).not.toContain('- instruction')
  })

  it('keeps workflow list ceilings aligned with runtime limits', () => {
    const stepsStart = crd.indexOf('                steps:')
    const triggersStart = crd.indexOf('                triggers:', stepsStart)
    const stepsSchema = crd.slice(stepsStart, triggersStart)
    const workloadsStart = crd.indexOf('                workloads:')
    const workloadsResourcesStart = crd.indexOf('                resources:', workloadsStart)
    const workloadsSchema = crd.slice(workloadsStart, workloadsResourcesStart)
    const uiStart = crd.indexOf('                ui:')
    const webhooksStart = crd.indexOf('                webhooks:', uiStart)
    const uiSchema = crd.slice(uiStart, webhooksStart)

    expect(workloadsSchema).toContain('maxItems: 25')
    expect(uiSchema).toContain('internal:\n                          type: array')
    expect(uiSchema).toContain('maxItems: 25')
    expect(stepsSchema).toContain('maxItems: 100')

    const dependsOnStart = stepsSchema.indexOf('                      dependsOn:')
    const mcpServersStart = stepsSchema.indexOf('                      mcpServers:')
    const dependsOnSchema = stepsSchema.slice(dependsOnStart, mcpServersStart)
    expect(dependsOnSchema).toContain('maxItems: 100')

    const allowedToolsStart = stepsSchema.indexOf('                      allowedTools:')
    const maxIterationsStart = stepsSchema.indexOf(
      '                      maxIterations:',
      allowedToolsStart
    )
    const allowedToolsSchema = stepsSchema.slice(allowedToolsStart, maxIterationsStart)
    expect(allowedToolsSchema).toContain('maxItems: 100')

    const resourcesStart = stepsSchema.indexOf('                      resources:', mcpServersStart)
    const mcpServersSchema = stepsSchema.slice(mcpServersStart, resourcesStart)
    expect(mcpServersSchema).toContain('maxItems: 20')
  })

  it('admits the explicit stepless promptBridge binding and closes SDK-only workflow fields', () => {
    const validations = readSchemaPath(workflowRecipeSchema, [
      'properties',
      'spec',
      'x-kubernetes-validations',
    ])
    expect(Array.isArray(validations)).toBe(true)
    const rules = (validations as Array<{ rule?: string; message?: string }>).map(validation =>
      String(validation.rule ?? '')
    )

    expect(rules).toContain(
      '!has(self.agent) || (has(self.steps) && size(self.steps) > 0) || (has(self.pluginWorkloadSdk) && has(self.pluginWorkloadSdk.promptBridge))'
    )
    expect(rules).toContain(
      '!has(self.pluginWorkloadSdk) || (has(self.steps) && size(self.steps) > 0) || (!has(self.triggers) && !has(self.scheduling) && !has(self.coordinatorImage))'
    )
    expect(crd).toContain(
      'agent requires non-empty workflow steps or spec.pluginWorkloadSdk.promptBridge'
    )
    expect(crd).toContain(
      'spec.pluginWorkloadSdk without workflow steps cannot define triggers, scheduling, or coordinatorImage'
    )
  })

  it('keeps expensive step graph checks in control-api and WRC instead of CRD CEL', () => {
    expect(crd).not.toContain('s.dependsOn.all(dep, self.steps.exists(t, t.id == dep))')
    expect(crd).toContain('duplicate step IDs are not allowed')
  })

  it('declares external workflow output claim validation', () => {
    expect(crd).toContain('claimName:')
    expect(crd).toContain('Existing output PVC in sandbox-recipes')
    expect(crd).toContain('output.claimName requires output.destination=pvc')
    expect(crd).not.toContain('(?!')
  })

  it('declares persisted step status metadata', () => {
    const statusStepsStart = crd.indexOf(
      '                steps:',
      crd.indexOf('            status:')
    )
    const artifactsStart = crd.indexOf('                artifacts:', statusStepsStart)
    const statusSteps = crd.slice(statusStepsStart, artifactsStart)

    expect(statusSteps).toContain('executor:')
    expect(statusSteps).toContain('enum: [agentic, snippet, custom]')
    expect(statusSteps).toContain('outputTruncated:')
    expect(statusSteps).toContain('outputLength:')
    expect(statusSteps).toContain('outputPreviewMaxChars:')
    expect(statusSteps).toContain('modelUsed:')
    expect(statusSteps).toContain('toolsCalled:')
    expect(statusSteps).toContain('approvalBindingSha256:')
  })

  it('defines TypeScript snippet run capabilities with CRD-safe guards', () => {
    expect(crd).toContain('language:')
    expect(crd).toContain('enum: [typescript]')
    expect(crd).toContain('capabilities:')
    expect(crd).toContain('enum: [read, readWrite]')
    expect(crd).toContain('snippet mcp allowedTools.include must not contain wildcards')
    expect(crd).toContain('snippet mcp servers require explicit allowedTools.include')
  })

  it('declares shared runtimeEgress HTTP intent for workflow runtimes', () => {
    expect(crd).toContain('runtimeEgress:')
    expect(crd).toContain('Shared WorkflowRecipe runtime egress intent')
    expect(crd).toContain('egressClass:')
    expect(crd).toContain(
      'enum:\n                            - exact-host\n                            - public-web'
    )
    expect(crd).toContain('allowedHosts:')
    expect(crd).toContain(
      'runtimeEgress.http.allowedHosts must contain public DNS hostnames for exact-host and must be omitted for public-web'
    )
    expect(crd).toContain("!h.matches('^([0-9]{1,3}[.]){3}[0-9]{1,3}$')")
    expect(crd).toContain("!h.endsWith('.internal')")
    expect(crd).toContain("!h.endsWith('.cluster.local')")
    expect(crd).toContain("h != 'metadata.goog'")
    expect(crd).toContain(
      'snippet HTTP exact-host allowedHosts must be declared in spec.runtimeEgress.http.allowedHosts; public-web requires spec.runtimeEgress.http.egressClass public-web and no allowedHosts'
    )
    expect(crd).toContain('steps:\n                  type: array\n                  maxItems: 100')
    expect(crd).toContain(
      'dependsOn:\n                        type: array\n                        maxItems: 100'
    )
  })

  it('keeps workload addCapabilities enum aligned with the shared policy', () => {
    const enumValues = readEnum(workflowRecipeSchema, [
      'properties',
      'spec',
      'properties',
      'workloads',
      'items',
      'properties',
      'security',
      'properties',
      'addCapabilities',
      'items',
      'enum',
    ])

    expect(enumValues).toEqual([...WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES])
    WORKFLOW_RECIPE_DENIED_CAPABILITIES.forEach(cap => {
      expect(enumValues).not.toContain(cap)
    })
  })

  it('exposes explicit workload PVC ownership preparation as an opt-in boolean', () => {
    const prepareVolumeOwnership = readSchemaPath(workflowRecipeSchema, [
      'properties',
      'spec',
      'properties',
      'workloads',
      'items',
      'properties',
      'security',
      'properties',
      'prepareVolumeOwnership',
    ])

    expect(prepareVolumeOwnership).toMatchObject({ type: 'boolean' })
  })

  it('keeps McpServer addCapabilities enum aligned with the shared policy', () => {
    const enumValues = readEnum(mcpServerSchema, [
      'properties',
      'spec',
      'properties',
      'security',
      'properties',
      'addCapabilities',
      'items',
      'enum',
    ])

    expect(enumValues).toEqual([...WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES])
    WORKFLOW_RECIPE_DENIED_CAPABILITIES.forEach(cap => {
      expect(enumValues).not.toContain(cap)
    })
  })
})
