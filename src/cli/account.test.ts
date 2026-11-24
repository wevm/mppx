import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, expect, test, vi } from 'vp/test'

import { createKeychain, resolveAccount } from './account.js'

// A fake macOS `security` that logs its arguments and keeps one password per account. In
// interactive mode (`-i`) it splits stdin lines into arguments like Apple's `split_line`.
const fakeSecurity = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const dir = __dirname
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n')
function splitLine(line) {
  const args = []
  let arg = null, quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (arg === null) {
      if (/\\s/.test(ch)) continue
      arg = ''
      if (ch === '"' || ch === "'") { quote = ch; continue }
    }
    if (ch === '\\\\') { arg += line[++i] ?? ''; continue }
    if (quote ? ch === quote : /\\s/.test(ch)) { args.push(arg); arg = null; quote = null; continue }
    arg += ch
  }
  if (arg !== null) args.push(arg)
  return args
}
function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
function run(args) {
  const file = path.join(dir, 'item-' + Buffer.from(option(args, '-a') ?? '').toString('hex'))
  if (args[0] === 'add-generic-password') { fs.writeFileSync(file, option(args, '-w')); return 0 }
  if (args[0] === 'find-generic-password') {
    if (!fs.existsSync(file)) return 44
    process.stdout.write(fs.readFileSync(file, 'utf8') + '\\n')
    return 0
  }
  if (args[0] === 'delete-generic-password') { fs.rmSync(file, { force: true }); return 0 }
  return 1
}
const argv = process.argv.slice(2)
if (argv[0] === '-i') {
  let result = 0
  for (const line of fs.readFileSync(0, 'utf8').split('\\n')) {
    const args = splitLine(line)
    if (args.length) result = run(args)
  }
  process.exit(result)
}
process.exit(run(argv))
`

const platform = process.platform
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-security-'))
  fs.writeFileSync(path.join(dir, 'security'), fakeSecurity, { mode: 0o755 })
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH}`)
  vi.stubEnv('MPPX_PRIVATE_KEY', '')
  // `os.platform()` reads `process.platform`.
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('macOS keychain stores the private key without passing it in process arguments', async () => {
  const privateKey = generatePrivateKey()
  const accountName = `it's "quoted" \\ name`

  await createKeychain(accountName).set(privateKey)

  const argv = fs.readFileSync(path.join(dir, 'argv.log'), 'utf8')
  expect(argv).not.toContain(privateKey)
  expect(argv).not.toContain(privateKey.slice(2))
  expect((await resolveAccount(accountName)).address).toBe(privateKeyToAccount(privateKey).address)
})
