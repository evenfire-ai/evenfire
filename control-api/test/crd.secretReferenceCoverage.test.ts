import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  SECRET_REFERENCE_CONTRACT_ANNOTATION,
  SECRET_REFERENCE_CONTRACT_VERSION,
  SECRET_REFERENCE_CRD_CONTRACTS,
  SECRET_REFERENCE_SCOPES,
  type SecretReferenceCrdContract,
  type SecretReferenceFieldContract,
  type SecretReferenceNamespaceBinding,
} from '../src/services/secretReferenceService.js'

const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')

const namespaceBindings = new Set<SecretReferenceNamespaceBinding>([
  'resource',
  'host-secret',
  'reference-value',
  'workflow-recipe',
  'workflow-workload',
])

/**
 * Every schema field whose name looks reference/credential-related must be
 * classified. These paths are explicitly non-Secret references (or keys
 * inside an already-contracted Secret reference). A new `*Ref`, `*Secret`, or
 * `*Credential*` field therefore fails closed until a reviewer puts it in the
 * runtime contract or this narrow exclusion inventory.
 */
const NON_SECRET_REFERENCE_PATHS = new Set([
  'communicationchannel.yaml:spec.hostRef',
  'host.yaml:spec.contextRef',
  'host.yaml:spec.llmPolicy.fallbacks[].credentialSlot',
  'llmhook.yaml:spec.target.image.ref',
  'mcpserver.yaml:spec.auth.secretKey',
  'mcpserver.yaml:spec.contextRef',
  'mcpserver.yaml:spec.envSecret.keys[].secretKey',
  'workflowrecipe.yaml:spec.agent.soulRef',
  'workflowrecipe.yaml:spec.agent.soulRef.storageRef',
  'workflowrecipe.yaml:spec.contextRef',
  'workflowrecipe.yaml:spec.security.allowContextRef',
  'workflowrecipe.yaml:spec.steps[].run.capabilities.secrets',
  'workflowrecipe.yaml:spec.ui.egress.internal[].workloadRef',
  'workflowrecipe.yaml:spec.ui.workloadRef',
  'workflowrecipe.yaml:spec.webhooks[].workloadRef',
  'workflowrecipe.yaml:spec.workloads[].envSecret.keys[].secretKey',
  'workflowrecipe.yaml:status.pluginWorkloadSdk.defaultTargetRef',
  'workflowrecipepolicy.yaml:spec.allowContextRef',
])

type OpenApiSchema = {
  description?: unknown
  properties?: unknown
  items?: unknown
  allOf?: unknown
  anyOf?: unknown
  oneOf?: unknown
}

type CrdSource = {
  file: string
  document: Record<string, unknown>
}

type ParsedCrd = CrdSource & {
  plural: string
  schemas: OpenApiSchema[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeContracts(
  contracts: readonly SecretReferenceCrdContract[]
): Array<{ plural: string; fields: SecretReferenceFieldContract[] }> {
  return contracts
    .map(contract => ({
      plural: contract.plural,
      fields: [...contract.fields].sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.namespaceBinding.localeCompare(right.namespaceBinding)
      ),
    }))
    .sort((left, right) => left.plural.localeCompare(right.plural))
}

function loadCrdSources(): CrdSource[] {
  return readdirSync(crdsDir)
    .filter(file => file.endsWith('.yaml'))
    .sort()
    .map(file => {
      const document = asRecord(parse(readFileSync(resolve(crdsDir, file), 'utf8')))
      if (!document) throw new Error(`Invalid CRD document: ${file}`)
      return { file, document }
    })
}

function parseCrd(source: CrdSource, errors: string[]): ParsedCrd | undefined {
  const metadata = asRecord(source.document.metadata)
  const spec = asRecord(source.document.spec)
  const names = asRecord(spec?.names)
  const plural = typeof names?.plural === 'string' ? names.plural : undefined
  const versions = spec?.versions
  if (!metadata || !spec || !plural || !Array.isArray(versions)) {
    errors.push(`${source.file}: invalid CRD metadata, names.plural, or versions`)
    return undefined
  }

  const schemas = versions.flatMap((version, index) => {
    const schema = asRecord(asRecord(asRecord(version)?.schema)?.openAPIV3Schema)
    if (!schema) {
      errors.push(`${source.file}: version ${index} has no openAPIV3Schema`)
      return []
    }
    return [schema]
  })

  return { ...source, plural, schemas }
}

function isContractPath(path: string): boolean {
  return /^spec(?:\.[A-Za-z][A-Za-z0-9]*(?:\[\])?)+$/.test(path)
}

function isNamespaceBinding(value: unknown): value is SecretReferenceNamespaceBinding {
  return (
    typeof value === 'string' && namespaceBindings.has(value as SecretReferenceNamespaceBinding)
  )
}

function parseCrdContract(
  crd: ParsedCrd,
  errors: string[]
): SecretReferenceCrdContract | undefined {
  const annotations = asRecord(asRecord(crd.document.metadata)?.annotations)
  const rawContract = annotations?.[SECRET_REFERENCE_CONTRACT_ANNOTATION]
  if (typeof rawContract !== 'string') {
    errors.push(`${crd.file}: missing ${SECRET_REFERENCE_CONTRACT_ANNOTATION} annotation`)
    return undefined
  }

  let value: unknown
  try {
    value = JSON.parse(rawContract)
  } catch {
    errors.push(`${crd.file}: ${SECRET_REFERENCE_CONTRACT_ANNOTATION} must contain JSON`)
    return undefined
  }

  const contract = asRecord(value)
  if (!contract || contract.version !== SECRET_REFERENCE_CONTRACT_VERSION) {
    errors.push(
      `${crd.file}: ${SECRET_REFERENCE_CONTRACT_ANNOTATION} must declare version ${SECRET_REFERENCE_CONTRACT_VERSION}`
    )
    return undefined
  }
  if (typeof contract.plural !== 'string' || contract.plural.length === 0) {
    errors.push(`${crd.file}: Secret reference contract must declare a plural`)
    return undefined
  }
  if (!Array.isArray(contract.fields)) {
    errors.push(`${crd.file}: Secret reference contract fields must be an array`)
    return undefined
  }

  const fields: SecretReferenceFieldContract[] = []
  const paths = new Set<string>()
  contract.fields.forEach((value, index) => {
    const field = asRecord(value)
    const path = field?.path
    const namespaceBinding = field?.namespaceBinding
    if (
      typeof path !== 'string' ||
      !isContractPath(path) ||
      !isNamespaceBinding(namespaceBinding)
    ) {
      errors.push(`${crd.file}: invalid Secret reference contract field at index ${index}`)
      return
    }
    if (paths.has(path)) {
      errors.push(`${crd.file}: duplicate Secret reference contract path ${path}`)
      return
    }
    paths.add(path)
    fields.push({ path, namespaceBinding })
  })

  return { plural: contract.plural, fields }
}

function schemaAtPath(schema: OpenApiSchema, path: string): OpenApiSchema | undefined {
  let current: OpenApiSchema | undefined = schema
  for (const token of path.split('.')) {
    const isArray = token.endsWith('[]')
    const fieldName = isArray ? token.slice(0, -2) : token
    const properties = asRecord(current?.properties)
    const field = asRecord(properties?.[fieldName])
    if (!field) return undefined
    current = isArray ? (asRecord(field.items) as OpenApiSchema | undefined) : field
    if (!current) return undefined
  }
  return current
}

function hasDescription(schema: OpenApiSchema): boolean {
  return typeof schema.description === 'string' && schema.description.trim().length > 0
}

/**
 * The contract is the source of truth; this narrow structural check only keeps
 * an obvious new credential-shaped object from being added without a contract.
 * It deliberately ignores generic `{ name, key }` objects whose field name has
 * no Secret/credential meaning, avoiding broad `*Ref` false positives.
 */
function isSecretReferenceCandidate(fieldName: string, schema: OpenApiSchema): boolean {
  void schema
  return /(secret|credential)/i.test(fieldName) || /ref$/i.test(fieldName)
}

function collectSecretReferenceCandidates(schema: OpenApiSchema, path = ''): string[] {
  const candidates = new Set<string>()

  const walk = (current: OpenApiSchema, prefix: string): void => {
    const properties = asRecord(current.properties)
    if (properties) {
      for (const [fieldName, value] of Object.entries(properties)) {
        const field = asRecord(value) as OpenApiSchema | undefined
        if (!field) continue
        const fieldPath = prefix ? `${prefix}.${fieldName}` : fieldName
        if (isSecretReferenceCandidate(fieldName, field)) candidates.add(fieldPath)
        walk(field, fieldPath)
      }
    }

    const items = asRecord(current.items) as OpenApiSchema | undefined
    if (items) walk(items, `${prefix}[]`)
    for (const branches of [current.allOf, current.anyOf, current.oneOf]) {
      if (Array.isArray(branches)) {
        branches.forEach(branch => {
          const branchSchema = asRecord(branch) as OpenApiSchema | undefined
          if (branchSchema) walk(branchSchema, prefix)
        })
      }
    }
  }

  walk(schema, path)
  return [...candidates].sort()
}

function auditCrdContracts(
  sources: readonly CrdSource[],
  runtimeContracts: readonly SecretReferenceCrdContract[] = SECRET_REFERENCE_CRD_CONTRACTS
): string[] {
  const errors: string[] = []
  const contracts: SecretReferenceCrdContract[] = []
  const crdPlurals = new Set<string>()
  const seenNonSecretPaths = new Set<string>()

  for (const source of sources) {
    const crd = parseCrd(source, errors)
    if (!crd) continue
    if (crdPlurals.has(crd.plural)) {
      errors.push(`${crd.file}: duplicate CRD plural ${crd.plural}`)
      continue
    }
    crdPlurals.add(crd.plural)

    const contract = parseCrdContract(crd, errors)
    if (!contract) continue
    if (contract.plural !== crd.plural) {
      errors.push(
        `${crd.file}: contract plural ${contract.plural} does not match CRD plural ${crd.plural}`
      )
    }

    const contractPaths = new Set(contract.fields.map(field => field.path))
    for (const field of contract.fields) {
      crd.schemas.forEach((schema, versionIndex) => {
        const fieldSchema = schemaAtPath(schema, field.path)
        if (!fieldSchema) {
          errors.push(
            `${crd.file}: contract path ${field.path} does not resolve in version ${versionIndex}`
          )
          return
        }
        if (!hasDescription(fieldSchema)) {
          errors.push(`${crd.file}: contract path ${field.path} must have a non-empty description`)
        }
      })
    }

    for (const schema of crd.schemas) {
      for (const candidatePath of collectSecretReferenceCandidates(schema)) {
        if (contractPaths.has(candidatePath)) continue
        const inventoryKey = `${crd.file}:${candidatePath}`
        if (NON_SECRET_REFERENCE_PATHS.has(inventoryKey)) {
          seenNonSecretPaths.add(inventoryKey)
        } else {
          errors.push(
            `${crd.file}: secret-shaped field ${candidatePath} is absent from the explicit contract`
          )
        }
      }
    }

    contracts.push(contract)
  }

  if (
    JSON.stringify(normalizeContracts(contracts)) !==
    JSON.stringify(normalizeContracts(runtimeContracts))
  ) {
    errors.push(
      'CRD Secret reference contracts do not match the runtime plural, field, and namespace-binding contract'
    )
  }

  for (const inventoryKey of NON_SECRET_REFERENCE_PATHS) {
    if (!seenNonSecretPaths.has(inventoryKey)) {
      errors.push(`stale non-Secret reference classification: ${inventoryKey}`)
    }
  }

  return errors
}

function cloneSources(): CrdSource[] {
  return JSON.parse(JSON.stringify(loadCrdSources())) as CrdSource[]
}

function workflowRecipeSchema(sources: readonly CrdSource[]): OpenApiSchema {
  const source = sources.find(candidate => candidate.file === 'workflowrecipe.yaml')
  if (!source) throw new Error('WorkflowRecipe CRD fixture is missing')
  const spec = asRecord(source.document.spec)
  const versions = spec?.versions
  if (!Array.isArray(versions)) throw new Error('WorkflowRecipe CRD versions are missing')
  const schema = asRecord(asRecord(asRecord(versions[0])?.schema)?.openAPIV3Schema)
  if (!schema) throw new Error('WorkflowRecipe CRD schema is missing')
  return schema
}

describe('Secret reference CRD coverage', () => {
  it('keeps the explicit CRD contracts in parity with the runtime scanner', () => {
    expect(auditCrdContracts(loadCrdSources())).toEqual([])

    expect(
      normalizeContracts(SECRET_REFERENCE_SCOPES.map(({ plural, fields }) => ({ plural, fields })))
    ).toEqual(
      normalizeContracts(
        SECRET_REFERENCE_CRD_CONTRACTS.filter(contract => contract.fields.length > 0)
      )
    )
  })

  it('rejects lowercase paths, missing descriptions, uncontracted credentials, and new CRDs without a contract', () => {
    const lowercasePath = cloneSources()
    const lowercaseProperties = asRecord(
      schemaAtPath(workflowRecipeSchema(lowercasePath), 'spec.steps[].run.capabilities.secrets[]')
        ?.properties
    )
    if (!lowercaseProperties?.secretRef)
      throw new Error('WorkflowRecipe secretRef fixture is missing')
    lowercaseProperties.secretref = lowercaseProperties.secretRef
    delete lowercaseProperties.secretRef
    expect(auditCrdContracts(lowercasePath)).toContain(
      'workflowrecipe.yaml: contract path spec.steps[].run.capabilities.secrets[].secretRef does not resolve in version 0'
    )

    const missingDescription = cloneSources()
    const envSecretSchema = schemaAtPath(
      workflowRecipeSchema(missingDescription),
      'spec.workloads[].envSecret'
    )
    if (!envSecretSchema) throw new Error('WorkflowRecipe envSecret fixture is missing')
    delete envSecretSchema.description
    expect(auditCrdContracts(missingDescription)).toContain(
      'workflowrecipe.yaml: contract path spec.workloads[].envSecret must have a non-empty description'
    )

    const uncontractedTokenRef = cloneSources()
    const tokenRefSpecProperties = asRecord(workflowRecipeSchema(uncontractedTokenRef).properties)
    const tokenRefRecipeProperties = asRecord(asRecord(tokenRefSpecProperties?.spec)?.properties)
    if (!tokenRefRecipeProperties) throw new Error('WorkflowRecipe properties fixture is missing')
    tokenRefRecipeProperties.tokenRef = {
      type: 'string',
      description: 'a lowercase secret reference',
    }
    expect(auditCrdContracts(uncontractedTokenRef)).toContain(
      'workflowrecipe.yaml: secret-shaped field spec.tokenRef is absent from the explicit contract'
    )

    const extraCredentials = cloneSources()
    const workflowSpecProperties = asRecord(workflowRecipeSchema(extraCredentials).properties)
    if (!workflowSpecProperties?.spec) throw new Error('WorkflowRecipe spec fixture is missing')
    const recipeProperties = asRecord(asRecord(workflowSpecProperties.spec)?.properties)
    if (!recipeProperties) throw new Error('WorkflowRecipe properties fixture is missing')
    recipeProperties.extraCredentials = {
      type: 'object',
      description: 'Extra credential reference.',
      properties: {
        name: { type: 'string' },
        key: { type: 'string' },
      },
    }
    expect(auditCrdContracts(extraCredentials)).toContain(
      'workflowrecipe.yaml: secret-shaped field spec.extraCredentials is absent from the explicit contract'
    )

    const missingContract = cloneSources()
    missingContract.push({
      file: 'newresource.yaml',
      document: {
        metadata: { name: 'newresources.clerum.io' },
        spec: {
          names: { plural: 'newresources' },
          versions: [
            {
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: { spec: { type: 'object' } },
                },
              },
            },
          ],
        },
      },
    })
    expect(auditCrdContracts(missingContract)).toContain(
      `newresource.yaml: missing ${SECRET_REFERENCE_CONTRACT_ANNOTATION} annotation`
    )
  })
})
