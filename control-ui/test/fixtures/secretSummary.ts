export type ProducerSecretSummary = {
  name: string
  keys: string[]
}

export function buildSecretSummary(input: {
  name: string
  keys?: readonly string[]
}): ProducerSecretSummary {
  return { name: input.name, keys: [...(input.keys ?? [])] }
}

export function buildSecretList(items: readonly ProducerSecretSummary[] = []) {
  return { items: [...items] }
}
