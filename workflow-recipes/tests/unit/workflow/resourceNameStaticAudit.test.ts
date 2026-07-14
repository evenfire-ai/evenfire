import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const WRC_SRC = path.resolve(__dirname, '../../../src')
const RESOURCE_BUILDER = path.join(WRC_SRC, 'reconciler/resourceBuilder.ts')

type ManifestSite = {
  functionName: string
  kind: string
  nameExpression: string
  line: number
}

type BuilderRule = {
  functionName: string
  kind: string
  nameExpression: string
  requiredResolver: string
}

const WORKLOAD_RUNTIME_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'CronJob',
  'Job',
  'DaemonSet',
  'Service',
])

const BUILDER_RULES: BuilderRule[] = [
  {
    functionName: 'buildDeployment',
    kind: 'Deployment',
    nameExpression: 'resourceName',
    requiredResolver: 'resolveWorkloadResourceName(recipe, workload.id)',
  },
  {
    functionName: 'buildStatefulSet',
    kind: 'StatefulSet',
    nameExpression: 'resourceName',
    requiredResolver: 'resolveStatefulSetResourceName(recipe, workload.id)',
  },
  {
    functionName: 'buildStatefulSet',
    kind: 'Service',
    nameExpression: 'svcName',
    requiredResolver: 'resolveStatefulSetHeadlessServiceName(recipe, workload)',
  },
  {
    functionName: 'buildCronJob',
    kind: 'CronJob',
    nameExpression: 'resourceName',
    requiredResolver: 'resolveCronJobResourceName(recipe, workload.id)',
  },
  {
    functionName: 'buildJob',
    kind: 'Job',
    nameExpression: 'resourceName',
    requiredResolver: 'resolveWorkloadResourceName(recipe, workload.id)',
  },
  {
    functionName: 'buildDaemonSet',
    kind: 'DaemonSet',
    nameExpression: 'resourceName',
    requiredResolver: 'resolveWorkloadResourceName(recipe, workload.id)',
  },
  {
    functionName: 'buildService',
    kind: 'Service',
    nameExpression: 'resourceName',
    requiredResolver: 'resolveWorkloadRuntimeResourceName(recipe, workload)',
  },
]

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text
  return undefined
}

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return obj.properties.find(p => ts.isPropertyAssignment(p) && propName(p.name) === name) as
    | ts.PropertyAssignment
    | undefined
}

function stringLiteral(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function parseResourceBuilder(): ts.SourceFile {
  return ts.createSourceFile(
    RESOURCE_BUILDER,
    fs.readFileSync(RESOURCE_BUILDER, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
}

function findFunction(sourceFile: ts.SourceFile, functionName: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  if (!found) throw new Error(`Missing ${functionName} in resourceBuilder.ts`)
  return found
}

function collectManifestSites(sourceFile: ts.SourceFile): ManifestSite[] {
  const sites: ManifestSite[] = []

  function visit(node: ts.Node, functionName = ''): void {
    const activeFunctionName =
      ts.isFunctionDeclaration(node) && node.name ? node.name.text : functionName

    if (ts.isObjectLiteralExpression(node)) {
      const kindProp = prop(node, 'kind')
      const metadataProp = prop(node, 'metadata')
      const kind = kindProp ? stringLiteral(kindProp.initializer) : undefined

      if (kind && metadataProp && ts.isObjectLiteralExpression(metadataProp.initializer)) {
        const nameProp = prop(metadataProp.initializer, 'name')
        if (nameProp) {
          const pos = sourceFile.getLineAndCharacterOfPosition(
            nameProp.initializer.getStart(sourceFile)
          )
          sites.push({
            functionName: activeFunctionName,
            kind,
            nameExpression: nameProp.initializer.getText(sourceFile).replace(/\s+/g, ' '),
            line: pos.line + 1,
          })
        }
      }
    }

    ts.forEachChild(node, child => visit(child, activeFunctionName))
  }

  visit(sourceFile)
  return sites
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ')
}

describe('resource name static audit', () => {
  it('keeps workload runtime manifests on the type-specific name resolvers', () => {
    const sourceFile = parseResourceBuilder()
    const sites = collectManifestSites(sourceFile)

    for (const rule of BUILDER_RULES) {
      const fn = findFunction(sourceFile, rule.functionName)
      expect(compact(fn.getText(sourceFile)), `${rule.functionName} resolver`).toContain(
        compact(rule.requiredResolver)
      )

      expect(
        sites,
        `${rule.functionName} must set ${rule.kind}.metadata.name from ${rule.nameExpression}`
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            functionName: rule.functionName,
            kind: rule.kind,
            nameExpression: rule.nameExpression,
          }),
        ])
      )
    }
  })

  it('fails when resourceBuilder adds an unaudited workload runtime manifest', () => {
    const sourceFile = parseResourceBuilder()
    const sites = collectManifestSites(sourceFile).filter(site =>
      WORKLOAD_RUNTIME_KINDS.has(site.kind)
    )
    const audited = new Set(
      BUILDER_RULES.map(rule => `${rule.functionName}:${rule.kind}:${rule.nameExpression}`)
    )
    const unaudited = sites
      .filter(site => !audited.has(`${site.functionName}:${site.kind}:${site.nameExpression}`))
      .map(
        site =>
          `${site.functionName || '<module>'}:${site.kind}:${site.line}:${site.nameExpression}`
      )

    expect(unaudited).toEqual([])
  })
})
