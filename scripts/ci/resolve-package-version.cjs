#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const packagePathArgument = process.argv[2]
if (!packagePathArgument) {
  throw new Error('package path is required')
}

const packagePath = path.resolve(process.cwd(), packagePathArgument)
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

if (typeof packageJson.version !== 'string' || !versionPattern.test(packageJson.version)) {
  throw new Error(`package version is missing or not canonical: ${packagePath}`)
}

process.stdout.write(packageJson.version)
