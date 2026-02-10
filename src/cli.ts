#!/usr/bin/env node
import * as child from 'node:child_process'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as readline from 'node:readline'
import { cac } from 'cac'
import type { Chain } from 'viem'
import { type Address, createClient, formatUnits, http, isAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readContract } from 'viem/actions'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import { Abis } from 'viem/tempo'
import * as Challenge from './Challenge.js'
import * as Credential from './Credential.js'
import * as Mpay from './client/Mpay.js'
import * as Receipt from './Receipt.js'
import { tempo } from './tempo/client/index.js'
import type { StreamCredentialPayload } from './tempo/stream/Types.js'

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
  .option('--rpc-url <url>', 'Custom RPC URL (or set RPC_URL env var)')
  .option('--yes', 'Skip confirmation prompts')
  .option('--deposit <amount>', 'Deposit amount for stream payments (human-readable units)')
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
        rpcUrl?: string
        silent?: boolean
        userAgent?: string
        verbose?: boolean
        yes?: boolean
        deposit?: string
      },
    ) => {
      if (!rawUrl) {
        cli.outputHelp()
        return
      }
      const keychain = createKeychain(options.account)
      const hasProtocol = /^https?:\/\//.test(rawUrl)
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(rawUrl)
      const url = hasProtocol ? rawUrl : `${isLocal ? 'http' : 'https'}://${rawUrl}`
      const privateKey = await keychain.get()
      if (!privateKey) {
        console.error(`No account found. Run:\n\n  ${name} account create\n`)
        process.exit(1)
      }

      const account = privateKeyToAccount(privateKey as `0x${string}`)
      const rpcUrl = options.rpcUrl ?? process.env.RPC_URL
      const client = createClient({
        chain: await resolveChain({ ...options, rpcUrl }),
        transport: http(rpcUrl),
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

      const log = options.silent ? () => {} : console.error
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

        const deposit = (() => {
          if (challenge.intent !== 'stream') return undefined
          const suggestedDeposit = (request as Record<string, unknown>).suggestedDeposit as
            | string
            | undefined
          const cliDeposit = options.deposit !== undefined ? String(options.deposit) : undefined
          const resolved = suggestedDeposit ?? cliDeposit ?? (!options.mainnet ? '10' : undefined)
          if (!resolved) {
            logErr(
              'Stream payment requires a deposit. Use --deposit <amount> or connect to testnet.',
            )
            process.exit(1)
          }
          return resolved
        })()

        const mpay = Mpay.create({
          methods: tempo({ account, getClient: () => client, deposit }),
          polyfill: false,
        })

        const formatValue = (value: unknown): string => {
          const str = typeof value === 'string' ? value : JSON.stringify(value)
          if (isAddress(str)) return explorerLink(str, client.chain)
          return str
        }
        const formatChallengeValue = (key: string, value: unknown): string => {
          const str = String(value)
          if (key === 'realm') return formatRealm(str)
          return str
        }
        const challengeExclude = new Set(['request'])
        const challengeEntries = Object.entries(challenge)
          .filter(([k, v]) => v != null && !challengeExclude.has(k))
          .map(([k, v]) => [keyAliases[k] ?? k, formatChallengeValue(k, v)] as [string, string])
        challengeEntries.sort(([a], [b]) => a.localeCompare(b))
        const decimals = 6
        let currencySymbol = 'tokens'
        const currencyAddr = challenge.request.currency as string | undefined
        if (currencyAddr && isAddress(currencyAddr)) {
          try {
            currencySymbol = await readContract(client, {
              address: currencyAddr as Address,
              abi: Abis.tip20,
              functionName: 'symbol',
            })
          } catch {}
        }

        const requestEntries: [string, string][] = [
          ...Object.entries(request)
            .filter(([key]) => key !== 'methodDetails')
            .map(([key, value]) => {
              let formatted = formatValue(value)
              if (key === 'amount' && typeof value === 'string' && /^\d+$/.test(value))
                formatted = `${formatted} ($${formatUnits(BigInt(value), decimals)})`
              if (key === 'currency' && typeof value === 'string' && isAddress(value))
                formatted = `${formatted} (${currencySymbol})`
              return [keyAliases[key] ?? key, formatted] as [string, string]
            }),
          ['from', explorerLink(account.address, client.chain)],
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
                  methodDetailEntries.push(['', formatValue(value)])
                  continue
                }
              }
            }
            methodDetailEntries.push([keyAliases[key] ?? key, formatted])
          }
        const allEntries = [...challengeEntries, ...requestEntries, ...methodDetailEntries]
        const padEnd = Math.max(...allEntries.map(([key]) => key.length))
        log(bold('Challenge'))
        printEntries(challengeEntries, padEnd)
        log('')
        log(bold('Request'))
        printEntries(requestEntries, padEnd)
        if (methodDetailEntries.length > 0) {
          log('')
          log(bold('Details'))
          printEntries(methodDetailEntries, padEnd)
        }
        log('')

        const intentLabel = challenge.intent ?? 'payment'
        const confirmMessage = (() => {
          if (challenge.intent === 'stream' && deposit)
            return `Proceed with stream? (deposit: ${deposit} ${currencySymbol})`
          const amount = challenge.request.amount as string | undefined
          if (amount && /^\d+$/.test(amount))
            return `Proceed with ${intentLabel}? ($${formatUnits(BigInt(amount), decimals)} ${currencySymbol})`
          return `Proceed with ${intentLabel}?`
        })()
        const confirmed = options.yes || (await confirm(confirmMessage))
        if (!confirmed) {
          logErr(`${intentLabel.charAt(0).toUpperCase()}${intentLabel.slice(1)} cancelled.`)
          process.exit(0)
        }
        const credential = await mpay.createCredential(challengeResponse)
        log('')

        if (challenge.intent === 'stream') {
          try {
            const parsed = Credential.deserialize<StreamCredentialPayload>(credential)
            const { payload } = parsed
            const streamExclude = new Set(['method', 'intent', 'type', 'transaction'])
            const amountKeys = new Set([
              'cumulativeAmount',
              'additionalDeposit',
            ])
            const streamEntries: [string, string][] = Object.entries(payload)
              .filter(([k, v]) => v != null && !streamExclude.has(k))
              .map(([k, v]) => {
                const str = String(v)
                const label = keyAliases[k] ?? k
                if (amountKeys.has(k) && /^\d+$/.test(str))
                  return [label, `${str} ($${formatUnits(BigInt(str), decimals)})`] as [string, string]
                if (isAddress(str))
                  return [label, explorerLink(str, client.chain)] as [string, string]
                return [label, str] as [string, string]
              })
            if (payload.action === 'open' && deposit)
              streamEntries.push(['deposit', `${deposit} ${currencySymbol}`])
            log(bold('Stream'))
            printEntries(streamEntries, padEnd)
            if (options.verbose && 'transaction' in payload) {
              log('')
              log(String(payload.transaction))
            }
            log('')
          } catch {}
        }

        const credentialResponse = await globalThis.fetch(url, {
          ...fetchInit,
          headers: { ...(fetchInit.headers as Record<string, string>), Authorization: credential },
        })

        if (options.include || options.verbose) printResponse(credentialResponse)
        if (options.fail && credentialResponse.status >= 400) process.exit(22)
        if (credentialResponse.status === 402) {
          const body = await credentialResponse.text()
          try {
            const problem = JSON.parse(body)
            if (problem.detail) logErr(problem.detail.split('\n')[0])
            else logErr(body)
          } catch {
            if (body) logErr(body)
          }
          process.exit(1)
        } else {
          const contentType = credentialResponse.headers.get('Content-Type') ?? ''
          if (contentType.includes('text/event-stream')) {
            const reader = credentialResponse.body?.getReader()
            if (!reader) {
              logErr('No response body')
              process.exit(1)
            }
            const decoder = new TextDecoder()
            let buffer = ''
            let currentEvent = ''

            const processLines = (lines: string[]) => {
              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEvent = line.slice(7).trim()
                  continue
                }
                if (!line.startsWith('data: ')) {
                  if (line === '') currentEvent = ''
                  continue
                }
                const data = line.slice(6).trim()
                if (data === '[DONE]') continue
                if (currentEvent === 'payment-receipt') {
                  try {
                    const raw = JSON.parse(data) as Record<string, unknown>
                    const formatReceiptValue = (key: string, value: unknown): string => {
                      const str = String(value)
                      if (key === 'txHash') return explorerLink(str, client.chain, 'tx')
                      if (
                        (key === 'spent' || key === 'acceptedCumulative' || key === 'amount') &&
                        /^\d+$/.test(str)
                      )
                        return `${str} ($${formatUnits(BigInt(str), decimals)})`
                      return str
                    }
                    const receiptExclude = new Set(['method', 'intent', 'challengeId', 'status'])
                    if (raw.reference && raw.channelId && raw.reference === raw.channelId)
                      receiptExclude.add('reference')
                    const receiptEntries = Object.entries(raw)
                      .filter(([k, v]) => v != null && !receiptExclude.has(k))
                      .map(
                        ([k, v]) =>
                          [keyAliases[k] ?? k, formatReceiptValue(k, v)] as [string, string],
                      )
                    receiptEntries.sort(([a], [b]) => a.localeCompare(b))
                    log('')
                    log(bold('Receipt'))
                    printEntries(receiptEntries, padEnd)
                    log('')
                  } catch {}
                  currentEvent = ''
                  continue
                }
                try {
                  const { token } = JSON.parse(data) as { token: string }
                  process.stdout.write(token)
                } catch {}
                currentEvent = ''
              }
            }

            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop()!
              processLines(lines)
            }
            if (buffer.trim()) processLines([buffer])
            process.stdout.write('\n')
            printReceiptHeader(credentialResponse, client.chain, decimals, log, padEnd)
          } else {
            printReceiptHeader(credentialResponse, client.chain, decimals, log, padEnd)
            log('')
            console.log(await credentialResponse.text())
          }
        }
      } catch (err) {
        // TODO: revert cast when https://github.com/wevm/zile/pull/26 is merged
        const errCause =
          err instanceof Error ? (err as unknown as Record<string, unknown>).cause : undefined
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
  .option('--rpc-url <url>', 'Custom RPC URL (or set RPC_URL env var)')
  .example(`${name} account create`)
  .example(`${name} account create --account work`)
  .example(`${name} account fund`)
  .example(`${name} account list`)
  .action(async (action: string | undefined, options: { account?: string; rpcUrl?: string }) => {
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
        resolveChain(options)
          .then((chain) => createClient({ chain, transport: http(options.rpcUrl) }))
          .then((client) =>
            import('viem/tempo').then(({ Actions }) =>
              Actions.faucet.fund(client, { account }).catch(() => {}),
            ),
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
        const chain = await resolveChain(options)
        const client = createClient({ chain, transport: http(options.rpcUrl) })
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
        const accounts = (await createKeychain().list()).sort((a, b) =>
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

/////////////////////////////////////////////////////////////////////////////////////////////////

function execCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    child.execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout.trim())
    })
  })
}

const keyAliases: Record<string, string> = {
  acceptedCumulative: 'accepted',
  authorizedSigner: 'signer',
  cumulativeAmount: 'cumulative',
}

function execCommandFull(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    child.execFile(command, args, (_error, stdout, stderr) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

function printReceiptHeader(
  response: Response,
  chain: Chain | undefined,
  decimals: number,
  log: (...args: unknown[]) => void,
  padEnd?: number,
) {
  const header = response.headers.get('Payment-Receipt')
  if (!header) return
  try {
    const raw = JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>
    const formatReceiptValue = (key: string, value: unknown): string => {
      const str = String(value)
      if (key === 'txHash' || key === 'reference') return explorerLink(str, chain, 'tx')
      if (
        (key === 'spent' || key === 'acceptedCumulative' || key === 'amount') &&
        /^\d+$/.test(str)
      )
        return `${str} ($${formatUnits(BigInt(str), decimals)})`
      return str
    }
    const receiptExclude = new Set(['method', 'intent', 'challengeId', 'status'])
    if (raw.reference && raw.channelId && raw.reference === raw.channelId)
      receiptExclude.add('reference')
    const entries = Object.entries(raw)
      .filter(([k, v]) => v != null && !receiptExclude.has(k))
      .map(([k, v]) => [keyAliases[k] ?? k, formatReceiptValue(k, v)] as [string, string])
    entries.sort(([a], [b]) => a.localeCompare(b))
    log('')
    log(bold('Receipt'))
    printEntries(entries, padEnd)
  } catch {
    try {
      const receipt = Receipt.deserialize(header)
      log('')
      log(bold('Receipt'))
      printEntries(
        [
          ['reference', explorerLink(receipt.reference, chain, 'tx')],
          ['timestamp', receipt.timestamp],
        ],
        padEnd,
      )
    } catch {}
  }
}

async function resolveChain(
  opts: { mainnet?: boolean; rpcUrl?: string | undefined } = {},
): Promise<Chain> {
  if (!opts.rpcUrl) return opts.mainnet ? tempoMainnet : tempoModerato
  const { getChainId } = await import('viem/actions')
  const chainId = await getChainId(createClient({ transport: http(opts.rpcUrl) }))
  const allExports = Object.values(await import('viem/chains')) as unknown[]
  const candidates = allExports.filter(
    (c): c is Chain =>
      typeof c === 'object' && c !== null && 'id' in c && (c as Chain).id === chainId,
  )
  const found = candidates.find((c) => 'serializers' in c && c.serializers) ?? candidates[0]
  if (!found) throw new Error(`Unknown chain ID ${chainId} from RPC ${opts.rpcUrl}`)
  return found
}

// biome-ignore format: compact shell commands
function createKeychain(account = 'default') {
  const service = name
  return {
    async list(): Promise<string[]> {
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
          const { stdout, stderr } = await execCommandFull('secret-tool', ['search', '--all', '--unlock', 'service', service])
          const combined = `${stdout}\n${stderr}`
          const accounts: string[] = []
          const matches = combined.matchAll(/\baccount = (.+)/g)
          for (const match of matches) if (match[1]) accounts.push(match[1])
          return accounts
        } catch {
          return []
        }
      }
      throw new Error(`Unsupported platform: ${platform}`)
    },
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
        const proc = child.execFile('secret-tool', ['store', '--label', `${service} ${account}`, 'service', service, 'account', account])
        proc.stdin?.write(value)
        proc.stdin?.end()
        return new Promise((resolve, reject) => {
          proc.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`secret-tool exited with code ${code}`))
          })
          proc.on('error', reject)
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

function printResponse(response: Response) {
  console.error(`HTTP/1.1 ${response.status}`)
  for (const [key, value] of response.headers) console.error(`${key}: ${value}`)
  console.error('')
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

function explorerLink(
  value: string,
  chain?: { blockExplorers?: { default?: { url: string } } | undefined },
  type: 'address' | 'tx' = 'address',
) {
  const explorerUrl = chain?.blockExplorers?.default?.url
  return explorerUrl ? link(`${explorerUrl}/${type}/${value}`, value) : value
}

const chainNames: Record<number, string> = {
  [tempoMainnet.id]: 'mainnet',
  [tempoModerato.id]: 'testnet',
}

function chainName(chain: { id: number; name: string }) {
  return chainNames[chain.id] ?? chain.name
}

function printEntries(entries: [string, string][], padEnd?: number) {
  const maxKeyLength = padEnd ?? Math.max(...entries.map(([key]) => key.length))
  for (const [key, value] of entries)
    console.error(
      `${key ? `${key}:`.padEnd(maxKeyLength + 2) : ' '.repeat(maxKeyLength + 2)}${value}`,
    )
}

function printExplorerLinks(address: string) {
  for (const chain of [tempoMainnet, tempoModerato]) {
    const explorerUrl = chain.blockExplorers?.default?.url
    if (explorerUrl)
      console.log(
        `${chainName(chain)}: ${link(`${explorerUrl}/address/${address}`, `${explorerUrl}/address/${truncateAddress(address)}`)}`,
      )
  }
}

function formatRealm(realm: string) {
  try {
    const url = new URL(`https://${realm}`)
    if (url.hostname === realm) return link(url.href, realm)
  } catch {}
  return realm
}

function bold(text: string) {
  return `\x1b[1m${text}\x1b[22m`
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
