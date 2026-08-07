/**
 * YAML Loader Utility
 *
 * Uses js-yaml for robust YAML parsing of test fixtures.
 */
import yaml from 'js-yaml'

/**
 * Load and parse a YAML string
 */
export function loadYaml(content: string): any {
  try {
    return yaml.load(content)
  } catch (error) {
    throw new Error(
      `Failed to parse YAML: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Load and parse a YAML file
 */
export async function loadYamlFile(path: string): Promise<any> {
  const { readFile } = await import('fs/promises')
  const content = await readFile(path, 'utf-8')
  return loadYaml(content)
}
