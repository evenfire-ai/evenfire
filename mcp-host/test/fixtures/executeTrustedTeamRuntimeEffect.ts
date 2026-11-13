import { executeRuntimeEffect } from '../../src/runtime/actionAuthority.js'

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? '') as {
    context: Parameters<typeof executeRuntimeEffect>[0]['context']
    operationId: Parameters<typeof executeRuntimeEffect>[0]['operationId']
  }
  const bindings: unknown[] = []
  let effects = 0
  const result = await executeRuntimeEffect({
    context: input.context,
    operationId: input.operationId,
    checkpoint: async binding => {
      bindings.push(binding)
      return 'allowed'
    },
    effect: async () => {
      effects += 1
      return 'authorized'
    },
  })

  process.stdout.write(JSON.stringify({ result, bindings, effects }))
}

void main()
