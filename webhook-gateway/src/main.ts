import { loadGatewayConfig, loadServerOptions } from './config'
import { Metrics } from './metrics'
import { start } from './server'

function readRecipeId(): { namespace: string; name: string } {
  const namespace = process.env.GATEWAY_RECIPE_NAMESPACE
  const name = process.env.GATEWAY_RECIPE_NAME
  if (!namespace || !name) {
    throw new Error(
      'GATEWAY_RECIPE_NAMESPACE and GATEWAY_RECIPE_NAME must be set (set via the Downward API in the WRC reconciler)'
    )
  }
  return { namespace, name }
}

async function main(): Promise<void> {
  const options = loadServerOptions()
  const { namespace, name } = readRecipeId()
  const config = loadGatewayConfig(options.configPath)
  const metrics = new Metrics()
  const handle = start({
    config,
    metrics,
    recipeNamespace: namespace,
    recipeName: name,
    budgets: options.budgets,
    options,
  })

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ svc: 'webhook-gateway', msg: `shutdown:${signal}` }))
    await handle.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ svc: 'webhook-gateway', fatal: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
