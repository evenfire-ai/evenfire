#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

// The CI contract is a literal service list. Refuse expressions or a changed
// matrix shape instead of silently checking a partial list. The parser reads
// only the consecutive literal entries under `matrix.service`; sibling matrix
// metadata such as `include` ends that collection.
function checkServices(workflow, localServices) {
  const matrices = [...(workflow + '\n').matchAll(/^      matrix:\n((?: {8}.*\n|\n)*)/gm)]
  const lists = []
  for (const match of matrices) {
    const lines = match[1].split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'))
    const serviceKeys = lines.reduce((keys, line, index) => {
      if (/^ {8}service:(?:\s|$)/.test(line)) keys.push(index)
      return keys
    }, [])
    if (serviceKeys.length > 1) throw new Error('Expected one literal CI service matrix')
    const serviceKey = serviceKeys[0] ?? -1
    if (serviceKey === -1) continue
    if (serviceKey !== 0 || lines[0] !== '        service:') {
      throw new Error('Expected one literal CI service matrix')
    }

    const services = []
    let cursor = 1
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (/^          - /.test(line)) {
        const entry = line.match(/^          - ([a-z0-9][a-z0-9/-]*)\s*$/)
        if (!entry || entry[1].split('/').some((part) => !part)) {
          throw new Error('Unsupported CI service entry')
        }
        services.push(entry[1])
        cursor++
        continue
      }
      // A key at the matrix level or dedent ends the service list. Deeper or
      // differently indented content inside the list is a malformed entry.
      if (/^ {8}\S/.test(line) || /^ {0,7}\S/.test(line)) break
      throw new Error('Unsupported CI service entry')
    }
    if (services.length < 1) throw new Error('Expected one literal CI service matrix')
    const metadata = lines.slice(cursor)
    if (metadata.some((line) => /^ {8}exclude:/.test(line))) {
      throw new Error('Unsupported CI matrix metadata: exclude removes required service coverage')
    }
    const includeKeys = metadata.filter((line) => /^ {8}include:/.test(line))
    if (includeKeys.length > 1 || (includeKeys.length === 1 && includeKeys[0] !== '        include:')) {
      throw new Error('Unsupported CI matrix metadata')
    }
    if (includeKeys.length === 1) {
      const includeIndex = metadata.indexOf(includeKeys[0])
      const includeEntries = []
      let serviceValues = null
      const finishEntry = () => {
        if (serviceValues === null) return
        if (serviceValues.length !== 1) throw new Error('Unsupported CI include entry: expected one service property')
        includeEntries.push(serviceValues[0])
        serviceValues = null
      }
      const readProperty = (text) => {
        const property = text.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/)
        if (!property) throw new Error(`Unsupported CI include entry: ${text}`)
        if (property[1] !== 'service') return
        const service = property[2].match(/^[a-z0-9][a-z0-9/-]*$/)
        if (!service || service[0].split('/').some((part) => !part)) {
          throw new Error(`Unsupported CI include service: ${property[2]}`)
        }
        serviceValues.push(service[0])
      }
      for (const line of metadata.slice(includeIndex + 1)) {
        if (/^ {8}\S/.test(line)) break
        if (/^          - /.test(line)) {
          finishEntry()
          serviceValues = []
          readProperty(line.slice(12))
          continue
        }
        if (serviceValues === null) throw new Error('Unsupported CI include entry')
        if (/^ {14}/.test(line)) continue
        if (!/^ {12}\S/.test(line)) throw new Error('Unsupported CI include entry')
        readProperty(line.slice(12))
      }
      finishEntry()
      if (includeEntries.length === 0) throw new Error('Unsupported CI include entry: no entries')
      for (const service of includeEntries) {
        if (!services.includes(service)) {
          throw new Error(`Include-only CI service: ${service}`)
        }
      }
    }
    lists.push(services)
  }
  if (lists.length !== 1) throw new Error('Expected one literal CI service matrix')
  const services = lists[0]
  for (const [label, entries] of [['CI', services], ['Makefile', localServices]]) {
    if (new Set(entries).size !== entries.length) throw new Error(`${label} contains duplicate services`)
  }
  const missing = services.filter((service) => !localServices.includes(service))
  const extra = localServices.filter((service) => !services.includes(service))
  if (missing.length || extra.length) {
    throw new Error(`Test service drift: missing from Makefile: ${missing.join(', ') || 'none'}; absent from CI: ${extra.join(', ') || 'none'}`)
  }
  return services.length
}

if (require.main === module) {
  try {
    const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci-public.yml'), 'utf8')
    const count = checkServices(workflow, process.argv.slice(2))
    console.log(`PASS: Makefile and CI cover the same ${count} test services`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { checkServices }
