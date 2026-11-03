const fs = require('node:fs')
const path = require('node:path')

function readStore() {
  const file = process.env.EVENFIRE_TEST_KEYTAR_PATH
  if (!file) throw new Error('isolated keytar store is not configured')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw error
  }
}

function writeStore(store) {
  const file = process.env.EVENFIRE_TEST_KEYTAR_PATH
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

exports.getPassword = async (service, account) => {
  return readStore()[`${service}::${account}`] ?? null
}

exports.setPassword = async (service, account, value) => {
  const store = readStore()
  store[`${service}::${account}`] = value
  writeStore(store)
}

exports.deletePassword = async (service, account) => {
  const store = readStore()
  const key = `${service}::${account}`
  const existed = Object.hasOwn(store, key)
  delete store[key]
  writeStore(store)
  return existed
}

exports.findPassword = async service => {
  const prefix = `${service}::`
  return Object.entries(readStore()).find(([key]) => key.startsWith(prefix))?.[1] ?? null
}

exports.findCredentials = async service => {
  const prefix = `${service}::`
  return Object.entries(readStore())
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, password]) => ({ account: key.slice(prefix.length), password }))
}
