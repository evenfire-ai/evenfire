#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const previousRef = argValue('--previous')
const currentRef = argValue('--current') || 'HEAD'

const PROJECTS = [
  {
    name: 'external-rest-api',
    packagePath: 'external-rest-api/package.json',
    codePrefixes: ['external-rest-api/src/', 'external-rest-api/test/'],
    codeFiles: ['external-rest-api/tsconfig.json'],
    ignoredFiles: ['external-rest-api/src/releaseManifest.ts'],
  },
  {
    name: 'rpc-proxy',
    packagePath: 'rpc-proxy/package.json',
    codePrefixes: ['rpc-proxy/src/', 'rpc-proxy/test/'],
    codeFiles: ['rpc-proxy/tsconfig.json'],
  },
]

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function packageVersionAt(ref, filePath) {
  const raw = git(['show', `${ref}:${filePath}`])
  return String(JSON.parse(raw).version || '')
}

function changedFiles() {
  if (!previousRef || /^0+$/.test(previousRef)) return []
  return git(['diff', '--name-only', `${previousRef}..${currentRef}`])
    .split('\n')
    .map(filePath => filePath.trim())
    .filter(Boolean)
}

function codeChanged(project, files) {
  return files.some(filePath => {
    if (project.ignoredFiles?.includes(filePath)) return false
    return (
      project.codePrefixes.some(prefix => filePath.startsWith(prefix)) ||
      project.codeFiles.includes(filePath)
    )
  })
}

if (!previousRef || /^0+$/.test(previousRef)) {
  console.log('Skipping version bump validation because no previous commit is available.')
  process.exit(0)
}

const files = changedFiles()
const failures = []

for (const project of PROJECTS) {
  if (!codeChanged(project, files)) continue

  const previousVersion = packageVersionAt(previousRef, project.packagePath)
  const currentVersion = packageVersionAt(currentRef, project.packagePath)
  if (previousVersion === currentVersion) {
    failures.push(
      `${project.name} code changed but ${project.packagePath} stayed at ${currentVersion}`
    )
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`::error::${failure}`)
  }
  process.exit(1)
}

console.log('Release package version bumps are valid.')
