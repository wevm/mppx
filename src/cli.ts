#!/usr/bin/env node
import * as child from 'node:child_process'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as readline from 'node:readline'
import { cac } from 'cac'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import * as Challenge from './Challenge.js'
import * as Mpay from './client/Mpay.js'
import * as tempo from './tempo/client/index.js'

const require = createRequire(import.meta.url)
const { name, version } = require('../package.json') as { name: string; version: string }

const cli = cac(name)

cli
  .command('[url]', 'Make HTTP request with automatic payment')
  .option('-A, --user-agent <ua>', 'Set User-Agent header')
  .option('-d, --data <data>', 'Send request body (implies POST unless -X is set)')
  .option('-f, --fail', 'Fail silently on HTTP errors (exit 22)')
  .option('-H, --header <header>', 'Add header (repeatable)')
  .option('-i, --include', 'Include response headers in output')
  .option('-k, --insecure', 'Skip TLS certificate verification (true for localhost/.local)')
  .option('-L, --location', 'Follow redirects')
  .option('-s, --silent', 'Silent mode (suppress progress and info)')
  .option('-v, --verbose', 'Make operation more talkative')
  .option('-X, --method <method>', 'HTTP method')
  .option('--accept <type>', 'Set Accept header (e.g. json, markdown, text/html)')
  .option('--account <name>', 'Account name (default: default)')
  .option('--json <json>', 'Send JSON body (sets Content-Type, implies POST)')
  .option('-M, --mainnet', 'Use mainnet')
  .example(`${name} example.com/foo/bar/baz --accept markdown`)
  .example(`${name} example.com/test -A claude`)
  .example(`${name} example.com/api -X POST --json '{"key":"value"}'`)
  .action(
    async (
      rawUrl: string | undefined,
      options: {
        accept?: string
        account?: string
        data?: string
        fail?: boolean
        header?: string | string[]
        include?: boolean
        insecure?: boolean
        json?: string
        location?: boolean
        mainnet?: boolean
        method?: string

        silent?: boolean
        userAgent?: string
        verbose?: boolean
      },
    ) => {
      if (!rawUrl) {
        cli.outputHelp()
        return
      }
      const keychain = createKeychain(options.account)
      const url = /^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`
      const privateKey = await keychain.get()
      if (!privateKey) {
        console.error(`No account found. Run:\n\n  ${name} account create\n`)
        process.exit(1)
      }

      const account = privateKeyToAccount(privateKey as `0x${string}`)
      const { chain, client } = createViemClient(options.mainnet)
      const mpay = Mpay.create({
        methods: [tempo.charge({ account, getClient: () => client })],
        polyfill: false,
      })

      const headers: Record<string, string> = {}
      if (options.header) {
        const headerList = Array.isArray(options.header) ? options.header : [options.header]
        for (const header of headerList) {
          const index = header.indexOf(':')
          if (index === -1) {
            console.error(`Invalid header format: ${header}`)
            process.exit(1)
          }
          headers[header.slice(0, index).trim()] = header.slice(index + 1).trim()
        }
      }

      if (options.accept) {
        const acceptShorthands: Record<string, string> = {
          html: 'text/html',
          json: 'application/json',
          markdown: 'text/markdown',
          md: 'text/markdown',
          text: 'text/plain',
        }
        headers.Accept = acceptShorthands[options.accept] ?? options.accept
      }
      const userAgent = options.userAgent ?? `${name}/${version}`
      const userAgentShorthands: Record<string, string> = {
        amp: 'Amp/1.0',
        cc: 'CCBot',
        claude: 'ClaudeBot',
      }
      headers['User-Agent'] = userAgentShorthands[userAgent] ?? userAgent
      const { hostname } = new URL(url)
      if (options.insecure || hostname === 'localhost' || hostname.endsWith('.local')) {
        process.removeAllListeners('warning')
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
      }

      const log = options.silent ? () => {} : console.log
      const logErr = options.silent ? () => {} : console.error

      try {
        const fetchInit: RequestInit = { redirect: options.location ? 'follow' : 'manual' }
        if (options.json) {
          fetchInit.body = options.json
          headers['Content-Type'] ??= 'application/json'
        } else if (options.data) {
          fetchInit.body = options.data
        }
        if (options.method) fetchInit.method = options.method.toUpperCase()
        else if (fetchInit.body) fetchInit.method = 'POST'
        if (Object.keys(headers).length > 0) fetchInit.headers = headers

        if (options.verbose) logVerbose(fetchInit.method ?? 'GET', url, headers)

        const challengeResponse = await globalThis.fetch(url, fetchInit)
        if (challengeResponse.status !== 402) {
          if (options.fail && challengeResponse.status >= 400) process.exit(22)
          if (options.include) printResponse(challengeResponse)
          console.log(await challengeResponse.text())
          return
        }

        if (options.include || options.verbose) printResponse(challengeResponse)

        const challenge = Challenge.fromResponse(challengeResponse)
        const request = challenge.request

        const formatValue = (value: unknown): string => {
          const str = typeof value === 'string' ? value : JSON.stringify(value)
          if (/^0x[0-9a-fA-F]{40}$/.test(str)) return explorerLink(str, chain)
          return str
        }
        const challengeEntries: [string, string][] = [
          ['realm', link(`https://${challenge.realm}`, challenge.realm)],
          ['method', challenge.method],
          ['intent', challenge.intent],
          ...(challenge.description
            ? [['description', challenge.description] as [string, string]]
            : []),
          ...(challenge.expires ? [['expires', challenge.expires] as [string, string]] : []),
        ]
        const requestEntries: [string, string][] = [
          ...Object.entries(request)
            .filter(([key]) => key !== 'methodDetails')
            .map(([key, value]) => [key, formatValue(value)] as [string, string]),
          ['from', explorerLink(account.address, chain)],
        ]
        requestEntries.sort(([a], [b]) => a.localeCompare(b))
        const methodDetailEntries: [string, string][] = []
        if (request.methodDetails && typeof request.methodDetails === 'object')
          for (const [key, value] of Object.entries(
            request.methodDetails as Record<string, unknown>,
          )) {
            let formatted = formatValue(value)
            if (key === 'chainId' && typeof value === 'number') {
              const knownChain = [tempoMainnet, tempoModerato].find((c) => c.id === value)
              if (knownChain?.blockExplorers?.default?.url)
                formatted = `${link(knownChain.blockExplorers.default.url, String(value))} (${chainName(knownChain)})`
            }
            if (key === 'memo' && typeof value === 'string' && value.startsWith('0x')) {
              const hex = value.slice(2).replace(/^0+/, '')
              if (hex.length % 2 === 0) {
                const text = Buffer.from(hex, 'hex').toString('utf8')
                if (/^[\x20-\x7e]+$/.test(text)) {
                  methodDetailEntries.push([key, text])
                  methodDetailEntries.push([`${key} (hex)`, formatValue(value)])
                  continue
                }
              }
            }
            methodDetailEntries.push([key, formatted])
          }
        const allEntries = [...challengeEntries, ...requestEntries, ...methodDetailEntries]
        const padEnd = Math.max(...allEntries.map(([key]) => key.length))
        log('Challenge')
        printEntries(challengeEntries, padEnd)
        log('')
        log('Request')
        printEntries(requestEntries, padEnd)
        if (methodDetailEntries.length > 0) {
          log('')
          log('Method Details')
          printEntries(methodDetailEntries, padEnd)
        }
        log('')

        const intentLabel = challenge.intent ?? 'payment'
        const confirmed = await confirm(`Proceed with ${intentLabel}?`)
        if (!confirmed) {
          logErr(`${intentLabel.charAt(0).toUpperCase()}${intentLabel.slice(1)} cancelled.`)
          process.exit(0)
        }
        log('')

        const credential = await mpay.createCredential(challengeResponse)
        const credentialResponse = await globalThis.fetch(url, {
          ...fetchInit,
          headers: { ...(fetchInit.headers as Record<string, string>), Authorization: credential },
        })

        if (options.include || options.verbose) printResponse(credentialResponse)
        if (options.fail && credentialResponse.status >= 400) process.exit(22)
        if (credentialResponse.status === 402) {
          const retryChallenge = Challenge.fromResponse(credentialResponse)
          printEntries([
            ...(retryChallenge.description
              ? [['description', retryChallenge.description] as [string, string]]
              : []),
            ...(retryChallenge.expires
              ? [['expires', retryChallenge.expires] as [string, string]]
              : []),
            ['intent', retryChallenge.intent],
            ['method', retryChallenge.method],
            ['realm', link(`https://${retryChallenge.realm}`, retryChallenge.realm)],
            ...Object.entries(retryChallenge.request).map(
              ([key, value]) =>
                [key, typeof value === 'string' ? value : JSON.stringify(value)] as [
                  string,
                  string,
                ],
            ),
          ])
          const body = await credentialResponse.text()
          try {
            const problem = JSON.parse(body)
            if (problem.detail) {
              log('')
              logErr(problem.detail.split('\n')[0])
            }
          } catch {}
        } else {
          console.log(await credentialResponse.text())
        }
      } catch (err) {
        // TODO: revert cast when https://github.com/wevm/zile/pull/26 is merged
        const errCause = err instanceof Error ? (err as unknown as Record<string, unknown>).cause : undefined
        const cause = errCause instanceof Error ? errCause.message : null
        console.error('Request failed:', err instanceof Error ? err.message : err)
        if (cause) console.error('  Cause:', cause)
        process.exit(1)
      }
    },
  )

cli
  .command('account [action]', 'Manage accounts (create, delete, fund, list, view)')
  .option('--account <name>', 'Account name (default: default)')
  .example(`${name} account create`)
  .example(`${name} account create --account work`)
  .example(`${name} account fund`)
  .example(`${name} account list`)
  .action(async (action: string | undefined, options: { account?: string }) => {
    if (!action) {
      cli.outputHelp()
      return
    }
    switch (action) {
      case 'create': {
        const keychain = createKeychain(options.account)
        if (await keychain.get()) {
          console.error(`Account "${options.account ?? 'default'}" already exists.`)
          process.exit(1)
        }
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await keychain.set(privateKey)
        console.log(account.address)
        printExplorerLinks(account.address)
        // Fund on testnet (don't wait for transaction to confirm)
        const { client } = createViemClient(false)
        import('viem/tempo').then(({ Actions }) =>
          Actions.faucet.fund(client, { account }).catch(() => {}),
        )
        return
      }
      case 'delete': {
        if (!options.account) {
          console.error('--account <name> is required for delete')
          process.exit(1)
        }
        const keychain = createKeychain(options.account)
        const key = await keychain.get()
        if (!key) {
          console.log('No account found.')
          return
        }
        const account = privateKeyToAccount(key as `0x${string}`)
        const confirmed = await confirm(`Delete account "${options.account}" (${account.address})?`)
        if (!confirmed) return
        await keychain.delete()
        console.log('Account deleted')
        return
      }
      case 'fund': {
        const keychain = createKeychain(options.account)
        const key = await keychain.get()
        if (!key) {
          console.log(`No account found. Run:\n\n  ${name} account create\n`)
          return
        }
        const account = privateKeyToAccount(key as `0x${string}`)
        const { chain, client } = createViemClient(false)
        console.log(`Funding on ${chainName(chain)}`)
        try {
          const { Actions } = await import('viem/tempo')
          const hashes = await Actions.faucet.fund(client, { account })
          const explorerUrl = chain.blockExplorers?.default?.url
          for (const hash of hashes) {
            const label = explorerUrl ? link(`${explorerUrl}/tx/${hash}`, hash) : hash
            console.log(`- ${label}`)
          }
          const { waitForTransactionReceipt } = await import('viem/actions')
          await Promise.all(hashes.map((hash) => waitForTransactionReceipt(client, { hash })))
          console.log('Funded successfully')
        } catch (err) {
          console.error('Failed to fund:', err instanceof Error ? err.message : err)
        }
        return
      }
      case 'list': {
        const accounts = (await listKeychainAccounts()).sort((a, b) =>
          a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b),
        )
        if (accounts.length === 0) {
          console.log(`No accounts found. Run:\n\n  ${name} account create\n`)
          return
        }
        for (const accountName of accounts) {
          const key = await createKeychain(accountName).get()
          if (!key) continue
          const account = privateKeyToAccount(key as `0x${string}`)
          console.log(`${accountName}: ${account.address}`)
        }
        return
      }
      case 'view': {
        const keychain = createKeychain(options.account)
        const key = await keychain.get()
        if (!key) {
          console.log(`No account found. Run:\n\n  ${name} account create\n`)
          return
        }
        const account = privateKeyToAccount(key as `0x${string}`)
        console.log(account.address)
        printExplorerLinks(account.address)
        return
      }
      default:
        console.error(`Unknown action: ${action}`)
        console.error('Available: create, delete, fund, list, view')
        process.exit(1)
    }
  })

cli.version(version, '-V, --version')

cli.help((sections) => {
  const isAccount = sections.some((s: { body?: string }) => s.body?.includes('$ mpay account'))
  if (isAccount) {
    const actionsSection = {
      title: 'Actions',
      body: [
        '  create  Create new account',
        '  delete  Delete account',
        '  fund    Fund account with testnet tokens',
        '  list    List all accounts',
        '  view    View account address',
      ].join('\n'),
    }
    const optionsIndex = sections.findIndex((s: { title?: string }) => s.title === 'Options')
    if (optionsIndex !== -1) sections.splice(optionsIndex, 0, actionsSection)
    else sections.push(actionsSection)
  }
  return sections
})

try {
  cli.parse()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

function printResponse(response: Response) {
  console.log(`HTTP/1.1 ${response.status}`)
  for (const [key, value] of response.headers) console.log(`${key}: ${value}`)
  console.log('')
}

function confirm(message: string): Promise<boolean> {
  const reader = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    reader.question(`${message} (y/N) `, (answer) => {
      reader.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

function execCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    child.execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout.trim())
    })
  })
}

const chainNames: Record<number, string> = {
  [tempoMainnet.id]: 'mainnet',
  [tempoModerato.id]: 'testnet',
}

function chainName(chain: { id: number; name: string }) {
  return chainNames[chain.id] ?? chain.name
}

function createViemClient(mainnet?: boolean) {
  const chain = mainnet ? tempoMainnet : tempoModerato
  const client = createClient({ chain, transport: http() })
  return { chain, client }
}

async function listKeychainAccounts(): Promise<string[]> {
  const service = name
  const platform = os.platform()
  if (platform === 'darwin') {
    try {
      const output = await execCommand('security', ['dump-keychain'])
      const accounts: string[] = []
      const blocks = output.split('keychain:')
      for (const block of blocks) {
        const serviceMatch = block.match(/"svce"<blob>="([^"]*)"/)
        const accountMatch = block.match(/"acct"<blob>="([^"]*)"/)
        if (serviceMatch?.[1] === service && accountMatch?.[1]) accounts.push(accountMatch[1])
      }
      return accounts
    } catch {
      return []
    }
  }
  if (platform === 'linux') {
    try {
      const output = await execCommand('secret-tool', ['search', 'service', service])
      const accounts: string[] = []
      const matches = output.matchAll(/\baccount = (.+)/g)
      for (const match of matches) if (match[1]) accounts.push(match[1])
      return accounts
    } catch {
      return []
    }
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

// biome-ignore format: compact shell commands
function createKeychain(account = 'default') {
  const service = name
  return {
    async get(): Promise<string | undefined> {
      const platform = os.platform()
      if (platform === 'darwin') {
        try {
          return await execCommand('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
        } catch {
          return undefined
        }
      }
      if (platform === 'linux') {
        try {
          const result = await execCommand('secret-tool', ['lookup', 'service', service, 'account', account])
          return result || undefined
        } catch {
          return undefined
        }
      }
      throw new Error(`Unsupported platform: ${platform}`)
    },
    async set(value: string): Promise<void> {
      const platform = os.platform()
      if (platform === 'darwin') {
        try {
          await execCommand('security', ['delete-generic-password', '-s', service, '-a', account])
        } catch {}
        await execCommand('security', ['add-generic-password', '-s', service, '-a', account, '-w', value])
        return
      }
      if (platform === 'linux') {
        const process = child.execFile('secret-tool', ['store', '--label', `${service} ${account}`, 'service', service, 'account', account])
        process.stdin?.write(value)
        process.stdin?.end()
        return new Promise((resolve, reject) => {
          process.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`secret-tool exited with code ${code}`))
          })
          process.on('error', reject)
        })
      }
      throw new Error(`Unsupported platform: ${platform}`)
    },
    async delete(): Promise<void> {
      const platform = os.platform()
      if (platform === 'darwin') {
        try {
          await execCommand('security', ['delete-generic-password', '-s', service, '-a', account])
        } catch {}
        return
      }
      if (platform === 'linux') {
        try {
          await execCommand('secret-tool', ['clear', 'service', service, 'account', account])
        } catch {}
        return
      }
      throw new Error(`Unsupported platform: ${platform}`)
    },
  }
}

function explorerLink(address: string, chain?: { blockExplorers?: { default?: { url: string } } }) {
  const explorerUrl = chain?.blockExplorers?.default?.url
  return explorerUrl ? link(`${explorerUrl}/address/${address}`, address) : address
}

function printEntries(entries: [string, string][], padEnd?: number) {
  const maxKeyLength = padEnd ?? Math.max(...entries.map(([key]) => key.length))
  for (const [key, value] of entries) console.log(`${`${key}:`.padEnd(maxKeyLength + 2)}${value}`)
}

function printExplorerLinks(address: string) {
  const truncated = truncateAddress(address)
  const mainnetExplorer = tempoMainnet.blockExplorers?.default?.url
  const testnetExplorer = tempoModerato.blockExplorers?.default?.url
  if (mainnetExplorer)
    console.log(
      `${chainName(tempoMainnet)}: ${link(`${mainnetExplorer}/address/${address}`, `${mainnetExplorer}/address/${truncated}`)}`,
    )
  if (testnetExplorer)
    console.log(
      `${chainName(tempoModerato)}: ${link(`${testnetExplorer}/address/${address}`, `${testnetExplorer}/address/${truncated}`)}`,
    )
}

function link(url: string, text: string) {
  return `\x1b]8;;${url}\x07\x1b[4m${text}\x1b[24m\x1b]8;;\x07`
}

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function logVerbose(method: string, url: string, headers: Record<string, string>) {
  const { hostname, pathname, search } = new URL(url)
  console.error(`> ${method} ${pathname}${search} HTTP/1.1`)
  console.error(`> Host: ${hostname}`)
  for (const [key, value] of Object.entries(headers)) console.error(`> ${key}: ${value}`)
  console.error('>')
}