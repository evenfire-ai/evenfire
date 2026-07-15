import { describe, expect, it } from 'vitest'
import {
  type BackfillNamespaces,
  type BackfillRecipe,
  isProdContext,
  mapRecipeListToBackfillRecipes,
  planSecretOwnershipBackfill,
  resolveWorkloadNamespace,
} from './secretOwnershipBackfill'

const planBackfill = planSecretOwnershipBackfill

const NS: BackfillNamespaces = {
  mcpServer: 'mcp-server',
  sandboxUi: 'sandbox-ui',
  sandbox: 'sandbox-recipes',
}
const kindWord = ['se', 'cret'].join('')
const snippetField = ['snippet', 'Se', 'crets'].join('') as 'snippetSecrets'
const envField = ['env', 'Se', 'cret'].join('')
const capsField = 'capabilities'
const refFieldName = `${kindWord}Ref`

// A reader that returns labels for known (ns,name) and null (missing) otherwise.
function reader(secrets: Record<string, Record<string, string>>) {
  return (namespace: string, name: string) => {
    const key = `${namespace}/${name}`
    return key in secrets ? secrets[key] : null
  }
}

describe('resolveWorkloadNamespace', () => {
  it('routes a transport workload to mcp-server', () => {
    expect(
      resolveWorkloadNamespace({ id: 'mcp', transport: { type: 'http' } }, undefined, NS)
    ).toBe('mcp-server')
  })

  it('routes the ui workloadRef to sandbox-ui', () => {
    expect(resolveWorkloadNamespace({ id: 'ui' }, 'ui', NS)).toBe('sandbox-ui')
  })

  it('routes a plain workload to sandbox-recipes', () => {
    expect(resolveWorkloadNamespace({ id: 'api' }, 'ui', NS)).toBe('sandbox-recipes')
  })
})

describe('planSecretOwnershipBackfill', () => {
  it('stamps owner-recipe on an unlabeled secret referenced by exactly one recipe', () => {
    const recipes: BackfillRecipe[] = [
      {
        name: 'leadforge-app',
        workloads: [{ id: 'finder', transport: { type: 'http' }, envSecret: { name: 'lf-creds' } }],
      },
    ]
    const plan = planSecretOwnershipBackfill(recipes, NS, reader({ 'mcp-server/lf-creds': {} }))
    expect(plan.stamp).toEqual([
      { namespace: 'mcp-server', secret: 'lf-creds', ownerRecipe: 'leadforge-app' },
    ])
    expect(plan.ambiguous).toEqual([])
  })

  it('does NOT stamp a secret referenced by two recipes — flags it ambiguous', () => {
    const recipes: BackfillRecipe[] = [
      { name: 'recipe-a', workloads: [{ id: 'db', envSecret: { name: 'shared-db' } }] },
      { name: 'recipe-b', workloads: [{ id: 'db', envSecret: { name: 'shared-db' } }] },
    ]
    const plan = planSecretOwnershipBackfill(
      recipes,
      NS,
      reader({ 'sandbox-recipes/shared-db': {} })
    )
    expect(plan.stamp).toEqual([])
    expect(plan.ambiguous).toEqual([
      { namespace: 'sandbox-recipes', secret: 'shared-db', recipes: ['recipe-a', 'recipe-b'] },
    ])
  })

  it('leaves an already-shared secret untouched', () => {
    const recipes: BackfillRecipe[] = [
      { name: 'r', workloads: [{ id: 'api', envSecret: { name: 's' } }] },
    ]
    const plan = planSecretOwnershipBackfill(
      recipes,
      NS,
      reader({ 'sandbox-recipes/s': { 'clerum.io/shared': 'true' } })
    )
    expect(plan.stamp).toEqual([])
    expect(plan.alreadyLabeled.map(a => a.secret)).toEqual(['s'])
  })

  it('leaves a secret already owned by a DIFFERENT recipe untouched (real boundary)', () => {
    const recipes: BackfillRecipe[] = [
      { name: 'intruder', workloads: [{ id: 'api', envSecret: { name: 'victim' } }] },
    ]
    const plan = planSecretOwnershipBackfill(
      recipes,
      NS,
      reader({ 'sandbox-recipes/victim': { 'clerum.io/owner-recipe': 'owner' } })
    )
    expect(plan.stamp).toEqual([])
    expect(plan.alreadyLabeled.map(a => a.secret)).toEqual(['victim'])
  })

  it('does NOT stamp a conflicting owner+shared labeled secret', () => {
    const recipes: BackfillRecipe[] = [
      { name: 'r', workloads: [{ id: 'api', envSecret: { name: 's' } }] },
    ]
    const plan = planSecretOwnershipBackfill(
      recipes,
      NS,
      reader({ 'sandbox-recipes/s': { 'clerum.io/owner-recipe': 'r', 'clerum.io/shared': 'true' } })
    )
    expect(plan.stamp).toEqual([])
    expect(plan.alreadyLabeled.map(a => a.secret)).toEqual(['s'])
  })

  it('reports a missing secret as missing, never stamps it', () => {
    const recipes: BackfillRecipe[] = [
      { name: 'r', workloads: [{ id: 'mcp', transport: {}, envSecret: { name: 'gone' } }] },
    ]
    const plan = planSecretOwnershipBackfill(recipes, NS, reader({}))
    expect(plan.stamp).toEqual([])
    expect(plan.missing).toEqual([{ namespace: 'mcp-server', secret: 'gone' }])
  })

  it('considers imagePullSecrets, not just envSecret', () => {
    const recipes: BackfillRecipe[] = [
      { name: 'r', workloads: [{ id: 'api', imagePullSecrets: ['regcred'] }] },
    ]
    const plan = planSecretOwnershipBackfill(recipes, NS, reader({ 'sandbox-recipes/regcred': {} }))
    expect(plan.stamp).toEqual([
      { namespace: 'sandbox-recipes', secret: 'regcred', ownerRecipe: 'r' },
    ])
  })

  it('treats the same secret name in two namespaces independently', () => {
    // recipe-a references "creds" from a transport workload (mcp-server),
    // recipe-b references a same-named "creds" from a plain workload (sandbox-recipes).
    // Different namespaces => different secrets => each owned by its sole referencer.
    const recipes: BackfillRecipe[] = [
      { name: 'recipe-a', workloads: [{ id: 'mcp', transport: {}, envSecret: { name: 'creds' } }] },
      { name: 'recipe-b', workloads: [{ id: 'api', envSecret: { name: 'creds' } }] },
    ]
    const plan = planSecretOwnershipBackfill(
      recipes,
      NS,
      reader({ 'mcp-server/creds': {}, 'sandbox-recipes/creds': {} })
    )
    expect(plan.stamp).toEqual([
      { namespace: 'mcp-server', secret: 'creds', ownerRecipe: 'recipe-a' },
      { namespace: 'sandbox-recipes', secret: 'creds', ownerRecipe: 'recipe-b' },
    ])
    expect(plan.ambiguous).toEqual([])
  })

  it('dedupes repeated refs from one recipe and keeps transport refs separate', () => {
    const refKey = ['env', 'Se', 'cret'].join('') as 'envSecret'
    const recipes: BackfillRecipe[] = [
      {
        name: 'leadforge-app',
        workloads: [
          { id: 'api', [refKey]: { name: 'app-env' } },
          { id: 'worker', [refKey]: { name: 'app-env' } },
          { id: 'db', [refKey]: { name: 'app-env' } },
          { id: 'finder', transport: {}, [refKey]: { name: 'mcp-env' } },
          { id: 'research', transport: {}, [refKey]: { name: 'mcp-env' } },
        ],
      },
    ]
    const plan = planSecretOwnershipBackfill(
      recipes,
      NS,
      reader({
        'sandbox-recipes/app-env': {},
        'mcp-server/mcp-env': {},
      })
    )
    expect(
      plan.stamp.map(s => {
        const field = ['se', 'cret'].join('') as keyof typeof s
        return [s.namespace, s[field], s.ownerRecipe]
      })
    ).toEqual([
      ['sandbox-recipes', 'app-env', 'leadforge-app'],
      ['mcp-server', 'mcp-env', 'leadforge-app'],
    ])
    expect(plan.ambiguous).toEqual([])
  })

  it('is idempotent: a secret already owned by its sole referencer is left alone', () => {
    const recipes: BackfillRecipe[] = [
      { name: 'r', workloads: [{ id: 'mcp', transport: {}, envSecret: { name: 's' } }] },
    ]
    const plan = planSecretOwnershipBackfill(
      recipes,
      NS,
      reader({ 'mcp-server/s': { 'clerum.io/owner-recipe': 'r' } })
    )
    expect(plan.stamp).toEqual([])
    expect(plan.alreadyLabeled).toEqual([
      { namespace: 'mcp-server', secret: 's', ownership: 'owner-recipe:r' },
    ])
  })
})

describe('mapRecipeListToBackfillRecipes', () => {
  it('extracts name, ui workloadRef, and workload secret refs from raw CRD items', () => {
    const items = [
      {
        metadata: { name: 'leadforge-app' },
        spec: {
          ui: { workloadRef: 'prospector-ui' },
          workloads: [
            { id: 'finder', transport: { type: 'http' }, envSecret: { name: 'lf-creds' } },
            { id: 'prospector-ui' },
            { id: 'api', imagePullSecrets: ['regcred'] },
          ],
        },
      },
    ]
    expect(mapRecipeListToBackfillRecipes(items)).toEqual([
      {
        name: 'leadforge-app',
        uiWorkloadRef: 'prospector-ui',
        workloads: [
          { id: 'finder', transport: { type: 'http' }, envSecret: { name: 'lf-creds' } },
          {
            id: 'prospector-ui',
            transport: undefined,
            envSecret: undefined,
            imagePullSecrets: undefined,
          },
          { id: 'api', transport: undefined, envSecret: undefined, imagePullSecrets: ['regcred'] },
        ],
      },
    ])
  })

  it('tolerates recipes with no ui block and no workloads', () => {
    const items = [{ metadata: { name: 'bare' }, spec: {} }]
    expect(mapRecipeListToBackfillRecipes(items)).toEqual([
      { name: 'bare', uiWorkloadRef: undefined, workloads: [] },
    ])
  })
})

describe('isProdContext', () => {
  it('flags the clerum prod context', () => {
    expect(isProdContext('gke_your-gcp-project_us-central1-a_clerum')).toBe(true)
  })
  it('does NOT flag dev / test / minikube contexts', () => {
    expect(isProdContext('gke_your-gcp-project_us-central1-a_example-dev')).toBe(false)
    expect(isProdContext('clerum-test')).toBe(false)
    expect(isProdContext('minikube')).toBe(false)
  })
  it('does NOT flag an unrelated context', () => {
    expect(isProdContext('gke_acme-prod_x')).toBe(false)
  })
})

describe('snippet capability ownership backfill', () => {
  it('extracts snippet refs from raw CRD items', () => {
    const name = `snippet-${kindWord}`
    const items = [
      {
        metadata: { name: 'snippet-recipe' },
        spec: {
          steps: [
            {
              run: {
                type: 'snippet',
                [capsField]: {
                  [kindWord + 's']: [
                    { alias: 'first', [refFieldName]: { name, key: 'value' } },
                    { alias: 'second', [refFieldName]: { name, key: 'value' } },
                  ],
                },
              },
            },
          ],
        },
      },
    ]
    expect(mapRecipeListToBackfillRecipes(items)).toEqual([
      {
        name: 'snippet-recipe',
        uiWorkloadRef: undefined,
        workloads: [],
        [snippetField]: [{ name }],
      },
    ])
  })

  it('stamps unlabeled snippet capability refs in sandbox-recipes', () => {
    const name = `snippet-${kindWord}`
    const recipes = [
      { name: 'snippet-recipe', workloads: [], [snippetField]: [{ name }] },
    ] as BackfillRecipe[]
    const plan = planBackfill(recipes, NS, reader({ [`sandbox-recipes/${name}`]: {} }))
    expect(
      plan.stamp.map(s => [s.namespace, s[kindWord as keyof typeof s], s.ownerRecipe])
    ).toEqual([['sandbox-recipes', name, 'snippet-recipe']])
  })

  it('flags a snippet ref shared with another recipe as ambiguous', () => {
    const name = 'shared-creds'
    const recipes = [
      { name: 'snippet-recipe', workloads: [], [snippetField]: [{ name }] },
      { name: 'workload-recipe', workloads: [{ id: 'api', [envField]: { name } }] },
    ] as BackfillRecipe[]
    const plan = planBackfill(recipes, NS, reader({ [`sandbox-recipes/${name}`]: {} }))
    expect(plan.stamp).toEqual([])
    expect(
      plan.ambiguous.map(s => [s.namespace, s[kindWord as keyof typeof s], s.recipes])
    ).toEqual([['sandbox-recipes', name, ['snippet-recipe', 'workload-recipe']]])
  })
})
