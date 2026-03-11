import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Cli, Errors, z } from 'incur'
import { Base64 } from 'ox'
import type { Chain } from 'viem'
import { type Address, createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import * as Challenge from '../Challenge.js'
import * as Mppx from '../client/Mppx.js'
import type * as Method from '../Method.js'
import { pc } from './_pc.js'
import { createDefaultStore, createKeychain, resolveAccountName } from './account.js'
import { loadConfig } from './config.js'
import type { CliHandler } from './Handler.js'
import { stripe as stripeHandler, tempo as tempoHandler } from './handlers/index.js'
import { readTempoKeystore, resolveTempoAccount } from './handlers/tempo.js'

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data.trim()))
    process.stdin.on('error', reject)
  })
}

const require = createRequire(import.meta.url)
const { name, version } = require('../../package.json') as { name: string; version: string }

const builtinHandlers: CliHandler[] = [tempoHandler(), stripeHandler()]

function resolveHandler(
  challenge: Challenge.Challenge,
  config?: { handlers?: CliHandler[] | undefined; methods?: any },
): { handler?: CliHandler | undefined; method?: Method.AnyClient | undefined } {
  const configHandler = config?.handlers?.find((h) => h.method === challenge.method)
  if (configHandler) return { handler: configHandler }

  const builtin = builtinHandlers.find((h) => h.method === challenge.method)
  if (builtin) return { handler: builtin }

  const configMethods = config?.methods?.flat() as Method.AnyClient[] | undefined
  const matched = configMethods?.find(
    (m) => m.name === challenge.method && m.intent === challenge.intent,
  )
  if (matched) return { method: matched }

  return {}
}

const cli = Cli.create('mppx', {
  version,
  description: 'Make HTTP requests with automatic payment',
  usage: [{ suffix: '<url> [options]' }],
  args: z.object({
    url: z.string().describe('URL to make payment request to'),
  }),
  options: z.object({
    account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    confirm: z.boolean().optional().describe('Show confirmation prompts'),
    data: z.string().optional().describe('Send request body (implies POST unless -X is set)'),
    fail: z.boolean().optional().describe('Fail silently on HTTP errors (exit 22)'),
    header: z.array(z.string()).optional().describe('Add header (repeatable)'),
    include: z.boolean().optional().describe('Include response headers in output'),
    insecure: z
      .boolean()
      .optional()
      .describe('Skip TLS certificate verification (true for localhost/.local)'),
    jsonBody: z
      .string()
      .optional()
      .describe('Send JSON body (sets Content-Type and Accept, implies POST)'),
    location: z.boolean().optional().describe('Follow redirects'),
    method: z.string().optional().describe('HTTP method'),
    methodOpt: z
      .array(z.string())
      .optional()
      .describe('Method-specific option (key=value, repeatable)'),
    rpcUrl: z
      .string()
      .optional()
      .describe('RPC endpoint, defaults to public RPC for chain (env: MPPX_RPC_URL)'),
    silent: z.boolean().optional().describe('Silent mode (suppress progress and info)'),
    userAgent: z.string().optional().describe('Set User-Agent header'),
    verbose: z
      .number()
      .default(0)
      .meta({ count: true })
      .describe('Verbosity (-v details, -vv headers)'),
  }),
  alias: {
    account: 'a',
    data: 'd',
    fail: 'f',
    header: 'H',
    include: 'i',
    insecure: 'k',
    jsonBody: 'J',
    location: 'L',
    method: 'X',
    methodOpt: 'M',
    rpcUrl: 'r',
    silent: 's',
    userAgent: 'A',
    verbose: 'v',
  },
  examples: [
    { args: { url: 'example.com/content' }, description: 'Make a payment request' },
    {
      args: { url: 'example.com/api' },
      options: { jsonBody: '{"key":"value"}' },
      description: 'POST JSON with payment',
    },
  ],
  async run(c) {
    const methodOpts = parseMethodOpts(c.options.methodOpt)

    const silent = c.options.silent ?? false
    const info = silent ? (_msg: string) => {} : (msg: string) => process.stderr.write(msg)
    let confirmEnabled = c.options.confirm ?? false
    if (silent) confirmEnabled = false

    const headers: Record<string, string> = {}
    if (c.options.header) {
      for (const header of c.options.header) {
        const index = header.indexOf(':')
        if (index === -1) {
          return c.error({
            code: 'INVALID_HEADER',
            message: `Invalid header format: ${header}`,
            exitCode: 2,
          })
        }
        headers[header.slice(0, index).trim()] = header.slice(index + 1).trim()
      }
    }
    headers['User-Agent'] = c.options.userAgent ?? `${name}/${version}`

    const rawUrl = c.args.url
    const url = (() => {
      const hasProtocol = /^https?:\/\//.test(rawUrl)
      const isLocal = /^(localhost|.*\.localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(rawUrl)
      return hasProtocol ? rawUrl : `${isLocal ? 'http' : 'https'}://${rawUrl}`
    })()
    const { hostname } = new URL(url)
    if (
      c.options.insecure ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      process.removeAllListeners('warning')
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }

    // Node.js doesn't resolve *.localhost subdomains to loopback (unlike
    // browsers per RFC 6761). Rewrite the URL to 127.0.0.1 and set the
    // Host header so reverse proxies can route correctly.
    const isSubLocalhost = hostname.endsWith('.localhost') && hostname !== 'localhost'
    const fetchUrl = isSubLocalhost ? url.replace(hostname, '127.0.0.1') : url
    if (isSubLocalhost) {
      const { host } = new URL(url)
      headers.Host = host
    }

    try {
      const fetchInit: RequestInit = { redirect: c.options.location ? 'follow' : 'manual' }
      if (c.options.jsonBody) {
        fetchInit.body = c.options.jsonBody
        headers['Content-Type'] ??= 'application/json'
        headers.Accept ??= 'application/json'
      } else if (c.options.data) {
        fetchInit.body = c.options.data
      }
      if (c.options.method) fetchInit.method = c.options.method.toUpperCase()
      else if (fetchInit.body) fetchInit.method = 'POST'
      if (Object.keys(headers).length > 0) fetchInit.headers = headers

      const verbose = c.options.verbose

      const printRequestHeaders = (reqUrl: string, init: RequestInit) => {
        if (verbose < 2) return
        const { pathname, host } = new URL(reqUrl)
        const method = (init.method ?? 'GET').toUpperCase()
        info(`> ${method} ${pathname} HTTP/1.1\n`)
        info(`> Host: ${host}\n`)
        for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
          info(`> ${k}: ${v}\n`)
        info('>\n')
      }

      const printResponseHeaders = (res: Response) => {
        if (!c.options.include && verbose < 2) return
        if (silent) return
        const status = `HTTP/1.1 ${res.status} ${res.statusText}`
        const out = verbose >= 2 ? process.stderr : process.stdout
        const prefix = verbose >= 2 ? '< ' : ''
        out.write(`${prefix}${status}\n`)
        for (const [k, v] of res.headers) out.write(`${prefix}${k}: ${v}\n`)
        out.write(verbose >= 2 ? '<\n' : '\n')
      }

      printRequestHeaders(url, fetchInit)
      const challengeResponse = await globalThis.fetch(fetchUrl, fetchInit)
      if (challengeResponse.status !== 402) {
        if (c.options.fail && challengeResponse.status >= 400)
          return c.error({
            code: 'HTTP_ERROR',
            message: `HTTP error ${challengeResponse.status}`,
            exitCode: 22,
          })
        printResponseHeaders(challengeResponse)
        console.log((await challengeResponse.text()).replace(/\n+$/, ''))
        return
      }

      const challenge = Challenge.fromResponse(challengeResponse)

      // Load config early so we can log before challenge display
      const loaded = await loadConfig()
      if (loaded && verbose >= 1)
        info(`${pc.dim('Using config')} ${pc.blue(path.relative(process.cwd(), loaded.path))}\n`)

      const challengeRequest = challenge.request as Record<string, unknown>
      const shownKeys = new Set<string>()

      const { handler, method: configMethod } = resolveHandler(challenge, loaded?.config)

      let tokenSymbol = (challengeRequest.currency as string | undefined) ?? ''
      let tokenDecimals = (challengeRequest.decimals as number | undefined) ?? 6
      let explorerUrl: string | undefined
      let handlerResult: Awaited<ReturnType<CliHandler['setup']>> | undefined

      if (handler) {
        handlerResult = await handler.setup({
          challenge,
          options: { account: c.options.account, rpcUrl: c.options.rpcUrl },
          methodOpts,
        })
        tokenSymbol = handlerResult.tokenSymbol
        tokenDecimals = handlerResult.tokenDecimals
        explorerUrl = handlerResult.explorerUrl
      }

      // Display challenge
      {
        printResponseHeaders(challengeResponse)
        const request = challengeRequest

        const balanceKeys = new Set(['amount', 'suggestedDeposit', 'minVoucherDelta'])
        const skipKeys = new Set(['decimals', 'currency', 'methodDetails'])
        const fmtRequestValue = (key: string, value: unknown): string => {
          if (balanceKeys.has(key) && typeof value === 'string') {
            return `${value} ${pc.dim(`(${fmtBalance(BigInt(value), tokenSymbol, tokenDecimals)})`)}`
          }
          if (key === 'chainId' && typeof value === 'number') {
            const name = chainName({ id: value, name: '' })
            return name ? `${value} ${pc.dim(`(${name})`)}` : String(value)
          }
          if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value))
            return explorerUrl ? pc.link(`${explorerUrl}/address/${value}`, value) : value
          if (typeof value === 'string' && /^https?:\/\//.test(value)) return pc.link(value, value)
          return String(value)
        }
        const decodeMemo = (hex: string): string | undefined => {
          try {
            const stripped = hex.replace(/^0x0*/, '')
            if (!stripped) return undefined
            const bytes = Uint8Array.from(
              stripped.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)),
            )
            const decoded = new TextDecoder().decode(bytes)
            return /^[\x20-\x7e]+$/.test(decoded) ? decoded : undefined
          } catch {
            return undefined
          }
        }

        const skipChallengeKeys = new Set(['id', 'request'])
        const fmtChallengeValue = (key: string, value: unknown): string => {
          if (key === 'realm' && typeof value === 'string') {
            try {
              const realmUrl = new URL(value.includes('://') ? value : `https://${value}`)
              return pc.link(realmUrl.href, value)
            } catch {}
          }
          return String(value)
        }
        const challengeRows: [string, string][] = []
        for (const [key, value] of Object.entries(challenge)) {
          if (skipChallengeKeys.has(key) || value === undefined) continue
          challengeRows.push([key, fmtChallengeValue(key, value)])
        }
        challengeRows.sort(([a], [b]) => a.localeCompare(b))

        const requestRows: [string, string][] = []
        for (const [key, value] of Object.entries(request)) {
          if (skipKeys.has(key) || value === undefined) continue
          requestRows.push([key, fmtRequestValue(key, value)])
        }
        requestRows.sort(([a], [b]) => a.localeCompare(b))

        const detailRows: [string, string, string?][] = []
        const methodDetails = request.methodDetails as Record<string, unknown> | undefined
        if (methodDetails) {
          for (const [key, value] of Object.entries(methodDetails)) {
            if (value === undefined) continue
            if (key === 'memo' && typeof value === 'string') {
              const decoded = decodeMemo(value)
              detailRows.push([key, decoded ? `${decoded}\n${pc.dim(value)}` : value])
            } else {
              detailRows.push([key, fmtRequestValue(key, value)])
            }
          }
          detailRows.sort(([a], [b]) => a.localeCompare(b))
        }

        const sections: [string, [string, string][]][] = [
          ['Challenge', challengeRows],
          ['Request', requestRows],
          ...(detailRows.length ? [['Details', detailRows] as [string, [string, string][]]] : []),
        ]
        for (const [, rows] of sections) for (const [key] of rows) shownKeys.add(key)
        const pad = Math.max(...sections.flatMap(([, rows]) => rows.map(([k]) => k.length)))
        const indent = `  ${''.padEnd(pad)}  `

        if (verbose >= 1 || confirmEnabled) {
          info(`${pc.bold(pc.yellow('Payment Required'))}\n`)
          for (const [title, rows] of sections) {
            info(`${pc.bold(title)}\n`)
            for (const [label, value] of rows) {
              const [first, ...rest] = value.split('\n')
              info(`  ${pc.dim(label.padEnd(pad))}  ${first}\n`)
              for (const line of rest) info(`${indent}${line}\n`)
            }
          }
        }
        if (confirmEnabled) {
          info('\n')
          const ok = await confirm(`Proceed with ${challenge.intent}?`, true)
          if (!ok) {
            info('Aborted.\n')
            return
          }
        }
      }

      // Create credential
      let credential: string
      if (handlerResult?.createCredential) {
        credential = await handlerResult.createCredential(challengeResponse)
      } else if (handlerResult) {
        const mppx = Mppx.create({ methods: handlerResult.methods, polyfill: false })
        credential = await mppx.createCredential(
          challengeResponse,
          handlerResult.credentialContext as undefined,
        )
      } else if (configMethod) {
        const mppx = Mppx.create({ methods: [configMethod], polyfill: false })
        credential = await mppx.createCredential(challengeResponse)
      } else {
        return c.error({
          code: 'UNSUPPORTED_METHOD',
          message: `Unsupported payment method: ${challenge.method}/${challenge.intent}. Add it to mppx.config.ts using defineConfig().`,
          exitCode: 2,
        })
      }

      // Send credential and get response
      const credentialHeaders = {
        ...(fetchInit.headers as Record<string, string>),
        Authorization: credential,
      }
      handler?.prepareCredentialRequest?.({ challenge, credential, headers: credentialHeaders })

      const credentialFetchInit = { ...fetchInit, headers: credentialHeaders }
      printRequestHeaders(url, credentialFetchInit)
      const credentialResponse = await globalThis.fetch(fetchUrl, credentialFetchInit)

      if (c.options.fail && credentialResponse.status >= 400)
        return c.error({
          code: 'HTTP_ERROR',
          message: `HTTP error ${credentialResponse.status}`,
          exitCode: 22,
        })

      if (credentialResponse.status === 402) {
        const body = await credentialResponse.text()
        info(`${pc.bold(pc.red('Payment Rejected'))}\n`)
        try {
          const problem = JSON.parse(body) as Record<string, unknown>
          const rows: [string, string][] = []
          for (const [key, value] of Object.entries(problem)) {
            if (value === undefined) continue
            rows.push([key, String(value)])
          }
          rows.sort(([a], [b]) => a.localeCompare(b))
          const pad = Math.max(...rows.map(([k]) => k.length))
          for (const [label, value] of rows) info(`  ${pc.dim(label.padEnd(pad))}  ${value}\n`)
        } catch {
          if (body) info(`  ${body}\n`)
        }
        return c.error({ code: 'PAYMENT_REJECTED', message: 'Payment rejected', exitCode: 75 })
      }

      printResponseHeaders(credentialResponse)

      // Let handler own the response lifecycle if it wants to
      const handled = await handler?.handleResponse?.({
        challenge,
        credential,
        response: credentialResponse,
        fetchUrl,
        fetchInit,
        info,
        verbose,
        confirmEnabled,
        confirm,
        tokenSymbol,
        tokenDecimals,
        explorerUrl,
        shownKeys,
        fmtBalance: (b, sym, dec) => fmtBalance(b, sym, dec),
      })

      if (!handled) {
        // Default: print receipt + body
        const receiptHeader = credentialResponse.headers.get('Payment-Receipt')
        if (receiptHeader && verbose >= 1) {
          try {
            const receiptJson = JSON.parse(Base64.toString(receiptHeader)) as Record<
              string,
              unknown
            >
            info(`\n${pc.bold(pc.green('Payment Receipt'))}\n`)
            const rows: [string, string][] = []
            const channelId = receiptJson.channelId
            const reference = receiptJson.reference
            const skipReference = channelId && reference && channelId === reference
            const receiptBalanceKeys = new Set(['acceptedCumulative', 'spent'])
            for (const [key, value] of Object.entries(receiptJson)) {
              if (value === undefined || shownKeys.has(key)) continue
              if (key === 'reference' && skipReference) continue
              const formatted = handler?.formatReceiptField?.(key, value)
              if (formatted !== undefined) {
                rows.push([key, formatted])
              } else if (receiptBalanceKeys.has(key) && typeof value === 'string') {
                rows.push([
                  key,
                  `${value} ${pc.dim(`(${fmtBalance(BigInt(value), tokenSymbol, tokenDecimals)})`)}`,
                ])
              } else if (
                (key === 'reference' || key === 'txHash') &&
                typeof value === 'string' &&
                explorerUrl
              ) {
                rows.push([key, pc.link(`${explorerUrl}/tx/${value}`, value)])
              } else rows.push([key, String(value)])
            }
            rows.sort(([a], [b]) => a.localeCompare(b))
            const pad = Math.max(...rows.map(([k]) => k.length))
            for (const [label, value] of rows) info(`  ${pc.dim(label.padEnd(pad))}  ${value}\n`)
            info('\n')
          } catch {}
        }

        const body = (await credentialResponse.text()).replace(/\n+$/, '')
        console.log(body)
      }
    } catch (err) {
      // Re-throw IncurError so incur's error handler formats it properly
      if (err instanceof Errors.IncurError) throw err

      // TODO: revert cast when https://github.com/wevm/zile/pull/26 is merged
      const errCause =
        err instanceof Error ? (err as unknown as Record<string, unknown>).cause : undefined
      const cause = errCause instanceof Error ? errCause : undefined

      if (cause && 'code' in cause) {
        const code = cause.code as string
        if (code === 'ENOTFOUND')
          return c.error({
            code: 'DNS_ERROR',
            message: `Could not resolve host "${hostname}". Check the URL and try again.`,
            exitCode: 6,
          })
        else if (code === 'ECONNREFUSED')
          return c.error({
            code: 'CONNECTION_REFUSED',
            message: `Connection refused by "${hostname}". Is the server running?`,
            retryable: true,
            exitCode: 7,
          })
        else if (code === 'ECONNRESET')
          return c.error({
            code: 'CONNECTION_RESET',
            message: `Connection to "${hostname}" was reset.`,
            retryable: true,
            exitCode: 56,
          })
        else if (code === 'ETIMEDOUT')
          return c.error({
            code: 'CONNECTION_TIMEOUT',
            message: `Connection to "${hostname}" timed out.`,
            retryable: true,
            exitCode: 28,
          })
        else if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
          return c.error({
            code: 'TLS_ERROR',
            message: `TLS certificate error for "${hostname}". Use --insecure to skip verification.`,
            exitCode: 60,
          })
        else
          return c.error({
            code: 'REQUEST_FAILED',
            message: `Request to "${hostname}" failed: ${cause.message}`,
          })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        return c.error({
          code: 'REQUEST_FAILED',
          message: cause
            ? `Request failed: ${msg} (Cause: ${cause.message})`
            : `Request failed: ${msg}`,
        })
      }
    }
  },
})

const account = Cli.create('account', {
  description: 'Manage accounts (create, default, delete, fund, list, view)',
})

account.command('create', {
  description: 'Create new account',
  options: z.object({
    account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    rpcUrl: z.string().optional().describe('RPC endpoint (env: MPPX_RPC_URL)'),
  }),
  alias: { account: 'a', rpcUrl: 'r' },
  async run(c) {
    let resolvedName = c.options.account
    if (!resolvedName) {
      const existing = await createKeychain().list()
      if (existing.length === 0) resolvedName = 'main'
      else {
        const input = await prompt('Account name')
        if (!input) return
        resolvedName = input
      }
    }
    let keychain = createKeychain(resolvedName)
    while (await keychain.get()) {
      process.stderr.write(`${pc.dim(`Account "${resolvedName}" already exists.`)}\n\n`)
      const input = await prompt('Enter different name')
      if (!input) return
      resolvedName = input
      keychain = createKeychain(resolvedName)
    }
    const privateKey = generatePrivateKey()
    const acct = privateKeyToAccount(privateKey)
    await keychain.set(privateKey)
    const accounts = await createKeychain().list()
    if (accounts.length === 1) createDefaultStore().set(resolvedName)
    console.log(`Account "${resolvedName}" saved to keychain.`)
    const explorerUrl = tempoMainnet.blockExplorers?.default?.url
    const addrDisplay = explorerUrl
      ? pc.link(`${explorerUrl}/address/${acct.address}`, acct.address)
      : acct.address
    console.log(pc.dim(`Address ${addrDisplay}`))
    resolveChain(c.options)
      .then((chain) => createClient({ chain, transport: http(c.options.rpcUrl) }))
      .then((client) =>
        import('viem/tempo').then(({ Actions }) =>
          Actions.faucet.fund(client, { account: acct }).catch(() => {}),
        ),
      )
  },
})

account.command('default', {
  description: 'Set default account',
  options: z.object({
    account: z.string().describe('Account name'),
  }),
  alias: { account: 'a' },
  async run(c) {
    const accountName = c.options.account
    if (isTempoAccount(accountName)) {
      const tempoEntry = resolveTempoAccount(accountName)
      if (!tempoEntry) {
        return c.error({
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account "${accountName}" not found. Is Tempo wallet configured?`,
          exitCode: 69,
        })
      }
      createDefaultStore().set(accountName)
      console.log(`Default account set to "${accountName}"`)
      return
    }
    const key = await createKeychain(accountName).get()
    if (!key) {
      return c.error({
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account "${accountName}" not found.`,
        exitCode: 69,
      })
    }
    createDefaultStore().set(accountName)
    console.log(`Default account set to "${accountName}"`)
  },
})

account.command('delete', {
  description: 'Delete account',
  options: z.object({
    account: z.string().describe('Account name'),
    yes: z.boolean().optional().describe('DANGER!! Skip confirmation prompts'),
  }),
  alias: { account: 'a' },
  async run(c) {
    const keychain = createKeychain(c.options.account)
    const key = await keychain.get()
    if (!key) {
      return c.error({
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account "${c.options.account}" not found.`,
        exitCode: 69,
      })
    }
    const acct = privateKeyToAccount(key as `0x${string}`)
    const balanceLines = await fetchBalanceLines(acct.address, { includeTestnet: false })
    if (!c.options.yes) {
      const explorerUrl = tempoMainnet.blockExplorers?.default?.url
      const addrDisplay = explorerUrl
        ? pc.link(`${explorerUrl}/address/${acct.address}`, acct.address)
        : acct.address
      process.stderr.write(pc.dim(`Delete account "${c.options.account}"\n`))
      process.stderr.write(pc.dim(`  Address  ${addrDisplay}\n`))
      for (let i = 0; i < balanceLines.length; i++)
        process.stderr.write(pc.dim(`  ${i === 0 ? 'Balance' : '       '}  ${balanceLines[i]}\n`))
      process.stderr.write(pc.dim('This action cannot be undone\n\n'))
      const confirmed = await confirm('Confirm delete?')
      if (!confirmed) {
        console.log('Canceled')
        return
      }
    }
    await keychain.delete()
    const currentDefault = createDefaultStore().get()
    if (currentDefault === c.options.account) {
      const remaining = await createKeychain().list()
      if (remaining.length > 0) {
        createDefaultStore().set(remaining[0]!)
        console.log(`Default account set to "${remaining[0]}"`)
      } else {
        createDefaultStore().clear()
      }
    }
    console.log(`Account "${c.options.account}" deleted`)
  },
})

account.command('fund', {
  description: 'Fund account with testnet tokens',
  options: z.object({
    account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    rpcUrl: z.string().optional().describe('RPC endpoint (env: MPPX_RPC_URL)'),
  }),
  alias: { account: 'a', rpcUrl: 'r' },
  async run(c) {
    const accountName = resolveAccountName(c.options.account)
    const keychain = createKeychain(accountName)
    const key = await keychain.get()
    if (!key) {
      if (c.options.account)
        return c.error({
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account "${accountName}" not found.`,
          exitCode: 69,
        })
      else return c.error({ code: 'ACCOUNT_NOT_FOUND', message: 'No account found.', exitCode: 69 })
    }
    const acct = privateKeyToAccount(key as `0x${string}`)
    const chain = await resolveChain(c.options)
    const client = createClient({ chain, transport: http(c.options.rpcUrl) })
    console.log(`Funding "${accountName}" on ${chainName(chain)}`)
    try {
      const { Actions } = await import('viem/tempo')
      const hashes = await Actions.faucet.fund(client, { account: acct })
      const explorerUrl = chain.blockExplorers?.default?.url
      for (const hash of hashes) {
        const label = explorerUrl ? pc.link(`${explorerUrl}/tx/${hash}`, pc.gray(hash)) : hash
        console.log(`  ${label}`)
      }
      const { waitForTransactionReceipt } = await import('viem/actions')
      await Promise.all(hashes.map((hash) => waitForTransactionReceipt(client, { hash })))
      console.log('Funded successfully')
    } catch (err) {
      console.error('Funding failed:', err instanceof Error ? err.message : err)
    }
  },
})

account.command('list', {
  description: 'List all accounts',
  async run() {
    const currentDefault = createDefaultStore().get()
    const accounts = (await createKeychain().list()).sort()
    const resolved: { name: string; address: string; source?: string }[] = []
    for (const accountName of accounts) {
      const key = await createKeychain(accountName).get()
      if (!key) continue
      resolved.push({
        name: accountName,
        address: privateKeyToAccount(key as `0x${string}`).address,
      })
    }
    const tempoEntries = readTempoKeystore()
    for (let i = 0; i < tempoEntries.length; i++) {
      const entry = tempoEntries[i]!
      const tempoName = i === 0 ? 'tempo:default' : `tempo:${i}`
      if (entry.wallet_address)
        resolved.push({ name: tempoName, address: entry.wallet_address, source: 'tempo wallet' })
    }
    if (resolved.length === 0) {
      console.log(`No accounts found.`)
      return
    }
    const explorerUrl = tempoMainnet.blockExplorers?.default?.url
    const maxWidth = Math.max(
      ...resolved.map((e) => e.name.length + (e.name === currentDefault ? 1 : 0)),
    )
    for (const entry of resolved) {
      const isDefault = entry.name === currentDefault
      const label = isDefault ? `${entry.name}${pc.dim('*')}` : entry.name
      const width = entry.name.length + (isDefault ? 1 : 0)
      const addrDisplay = explorerUrl
        ? pc.link(`${explorerUrl}/address/${entry.address}`, entry.address)
        : entry.address
      const sourceLabel = entry.source ? `  ${pc.dim(`(${entry.source})`)}` : ''
      console.log(`${label}${' '.repeat(maxWidth - width + 2)}${pc.dim(addrDisplay)}${sourceLabel}`)
    }
  },
})

account.command('view', {
  description: 'View account address',
  options: z.object({
    account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    rpcUrl: z.string().optional().describe('RPC endpoint (env: MPPX_RPC_URL)'),
  }),
  alias: { account: 'a', rpcUrl: 'r' },
  async run(c) {
    const accountName = resolveAccountName(c.options.account)

    if (isTempoAccount(accountName)) {
      const tempoEntry = resolveTempoAccount(accountName)
      if (!tempoEntry) {
        return c.error({
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account "${accountName}" not found. Is Tempo wallet configured?`,
          exitCode: 69,
        })
      }
      const address = tempoEntry.wallet_address as Address
      const rpcUrl = c.options.rpcUrl ?? (process.env.MPPX_RPC_URL || undefined)
      const chain = rpcUrl ? await resolveChain({ rpcUrl }) : tempoMainnet
      const explorerUrl = chain.blockExplorers?.default?.url
      const addrDisplay = explorerUrl
        ? pc.link(`${explorerUrl}/address/${address}`, address)
        : address
      console.log(`${pc.dim('Address')}  ${addrDisplay}`)

      const balanceLines = await fetchBalanceLines(
        address,
        chain && rpcUrl ? { chain, rpcUrl } : undefined,
      )
      for (let i = 0; i < balanceLines.length; i++)
        console.log(`${pc.dim(i === 0 ? 'Balance' : '       ')}  ${balanceLines[i]}`)

      console.log(`${pc.dim('Name')}     ${accountName}`)
      console.log(`${pc.dim('Type')}     ${tempoEntry.wallet_type} ${pc.dim('(tempo wallet)')}`)
      return
    }

    const keychain = createKeychain(accountName)
    const key = await keychain.get()
    if (!key) {
      if (c.options.account)
        return c.error({
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account "${accountName}" not found.`,
          exitCode: 69,
        })
      else return c.error({ code: 'ACCOUNT_NOT_FOUND', message: 'No account found.', exitCode: 69 })
    }
    const acct = privateKeyToAccount(key as `0x${string}`)
    const rpcUrl = c.options.rpcUrl ?? (process.env.MPPX_RPC_URL || undefined)
    const chain = rpcUrl ? await resolveChain({ rpcUrl }) : tempoMainnet
    const explorerUrl = chain.blockExplorers?.default?.url
    const addrDisplay = explorerUrl
      ? pc.link(`${explorerUrl}/address/${acct.address}`, acct.address)
      : acct.address
    console.log(`${pc.dim('Address')}  ${addrDisplay}`)

    const balanceLines = await fetchBalanceLines(
      acct.address,
      chain && rpcUrl ? { chain, rpcUrl } : undefined,
    )
    for (let i = 0; i < balanceLines.length; i++)
      console.log(`${pc.dim(i === 0 ? 'Balance' : '       ')}  ${balanceLines[i]}`)

    console.log(`${pc.dim('Name')}     ${accountName}`)
  },
})

cli.command(account)

const sign = Cli.create('sign', {
  description: 'Sign a payment challenge and output the Authorization header',
  usage: [
    { suffix: '--challenge <value> [options]' },
    { prefix: 'echo <challenge> |', suffix: '[options]' },
  ],
  options: z.object({
    account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    challenge: z.string().optional().describe('WWW-Authenticate challenge value'),
    dryRun: z.boolean().optional().describe('Validate and parse the challenge without signing'),
    methodOpt: z
      .array(z.string())
      .optional()
      .describe('Method-specific option (key=value, repeatable)'),
    rpcUrl: z
      .string()
      .optional()
      .describe('RPC endpoint, defaults to public RPC for chain (env: MPPX_RPC_URL)'),
  }),
  alias: {
    account: 'a',
    challenge: 'c',
    methodOpt: 'M',
    rpcUrl: 'r',
  },
  async run(c) {
    const raw = c.options.challenge || (process.stdin.isTTY === false ? await readStdin() : undefined)
    if (!raw) {
      return c.error({
        code: 'NO_CHALLENGE',
        message: 'No challenge provided. Use --challenge or pipe via stdin.',
        exitCode: 2,
      })
    }

    let challenge: Challenge.Challenge
    try {
      challenge = Challenge.deserialize(raw)
    } catch (err) {
      return c.error({
        code: 'INVALID_CHALLENGE',
        message: `Failed to parse challenge: ${err instanceof Error ? err.message : err}`,
        exitCode: 2,
      })
    }

    if (c.options.dryRun) {
      process.stderr.write('Challenge is valid.\n')
      return
    }

    const loaded = await loadConfig()
    const { handler, method: configMethod } = resolveHandler(challenge, loaded?.config)
    const methodOpts = parseMethodOpts(c.options.methodOpt)

    const wwwAuth = Challenge.serialize(challenge)
    const fakeResponse = new Response(null, {
      status: 402,
      headers: { 'WWW-Authenticate': wwwAuth },
    })

    let credential: string
    if (handler) {
      const result = await handler.setup({
        challenge,
        options: { account: c.options.account, rpcUrl: c.options.rpcUrl },
        methodOpts,
      })
      if (result.createCredential) {
        credential = await result.createCredential(fakeResponse)
      } else {
        const mppx = Mppx.create({ methods: result.methods, polyfill: false })
        credential = await mppx.createCredential(
          fakeResponse,
          result.credentialContext as undefined,
        )
      }
    } else if (configMethod) {
      const mppx = Mppx.create({ methods: [configMethod], polyfill: false })
      credential = await mppx.createCredential(fakeResponse)
    } else {
      return c.error({
        code: 'UNSUPPORTED_METHOD',
        message: `Unsupported payment method: ${challenge.method}/${challenge.intent}. Add it to mppx.config.ts using defineConfig().`,
        exitCode: 2,
      })
    }

    if (c.format === 'json') {
      console.log(JSON.stringify({ authorization: credential }))
    } else {
      console.log(credential)
    }
  },
})

cli.command(sign)

const init = Cli.create('init', {
  description: 'Create an mppx.config.ts file in the current directory',
  options: z.object({
    force: z.boolean().optional().describe('Overwrite existing config file'),
  }),
  alias: { force: 'f' },
  async run(c) {
    const cwd = process.cwd()

    // Determine file extension: .ts if tsconfig exists, .mjs if type:module, else .js
    const ext = (() => {
      if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) return '.ts'
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'))
        if (pkg.type === 'module') return '.mjs'
      } catch {}
      return '.js'
    })()

    const filename = `mppx.config${ext}`
    const dest = path.join(cwd, filename)

    if (fs.existsSync(dest) && !c.options.force) {
      return c.error({
        code: 'CONFIG_EXISTS',
        message: `${filename} already exists. Use --force to overwrite.`,
        exitCode: 1,
      })
    }

    const template = `import { defineConfig } from 'mppx/cli'
// import { tempo, stripe } from 'mppx/cli/handlers'
// import { myMethod } from 'my-mppx-method'

export default defineConfig({
  // handlers: [tempo(), stripe()],
  // methods: [myMethod({ ... })],
})
`

    fs.writeFileSync(dest, template)
    console.log(`Created ${filename}`)
  },
})

cli.command(init)

export default cli

/////////////////////////////////////////////////////////////////////////////////////////////////

function parseMethodOpts(raw: string | string[] | undefined): Record<string, string> {
  if (!raw) return {}
  const list = Array.isArray(raw) ? raw : [raw]
  const result: Record<string, string> = {}
  for (const item of list) {
    const idx = item.indexOf('=')
    if (idx === -1) {
      throw new Error(`Invalid method option format: ${item} (expected key=value)`)
    }
    result[item.slice(0, idx)] = item.slice(idx + 1)
  }
  return result
}

function isTempoAccount(accountName: string): boolean {
  return accountName.startsWith('tempo:')
}

function prompt(message: string): Promise<string | undefined> {
  const reader = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    reader.on('close', () => resolve(undefined))
    reader.question(`${pc.bold(`▸ ${message}:`)} `, (answer) => {
      reader.close()
      const value = answer.trim()
      resolve(value || undefined)
    })
  })
}

function confirm(prompt: string, defaultYes = false): Promise<boolean> {
  const reader = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    const hint = defaultYes ? '(Y/n)' : '(y/N)'
    reader.question(`${pc.bold(`▸ ${prompt}`)} ${pc.dim(hint)} `, (answer) => {
      reader.close()
      const trimmed = answer.trim().toLowerCase()
      resolve(trimmed === '' ? defaultYes : trimmed === 'y')
    })
  })
}

async function resolveChain(opts: { rpcUrl?: string | undefined } = {}): Promise<Chain> {
  if (!opts.rpcUrl) return tempoModerato
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

function chainName(chain: { id: number; name: string }) {
  const chainNames: Record<number, string> = {
    [tempoMainnet.id]: 'mainnet',
    [tempoModerato.id]: 'testnet',
  }
  return chainNames[chain.id] ?? chain.name
}

const pathUsd = '0x20c0000000000000000000000000000000000000' as Address
const usdc = '0x20C000000000000000000000b9537d11c60E8b50' as Address
const mainnetTokens = [pathUsd, usdc] as const
const testnetTokens = [
  '0x20c0000000000000000000000000000000000000',
  '0x20c0000000000000000000000000000000000001',
  '0x20c0000000000000000000000000000000000002',
  '0x20c0000000000000000000000000000000000003',
] as const

function fmtBalance(
  b: bigint,
  symbol: string,
  decimals = 6,
  opts?: { explorerUrl?: string | undefined; token?: string | undefined },
) {
  const value = Number(b) / 10 ** decimals
  const [int, dec] = value.toString().split('.')
  const formatted = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '_')
  const sym =
    opts?.explorerUrl && opts.token
      ? pc.dim(pc.link(`${opts.explorerUrl}/token/${opts.token}`, symbol, true))
      : pc.dim(symbol)
  return `${dec ? `${formatted}.${dec}` : formatted} ${sym}`
}

function isTestnet(chain: Chain) {
  return chain.id !== tempoMainnet.id
}

async function fetchTokenInfo(
  client: ReturnType<typeof createClient>,
  token: Address,
  account: Address,
) {
  const { Actions } = await import('viem/tempo')
  const [balance, metadata] = await Promise.all([
    Actions.token.getBalance(client, { account, token }).catch(() => 0n),
    Actions.token.getMetadata(client, { token }).catch(() => ({ symbol: token as string })),
  ])
  const knownSymbols: Record<string, string> = {
    [pathUsd]: 'PathUSD',
    [usdc]: 'USDC',
  }
  const symbol = knownSymbols[token] ?? metadata.symbol
  const decimals = 'decimals' in metadata ? metadata.decimals : 6
  return { balance, symbol, decimals, token }
}

async function fetchBalanceLines(
  address: Address,
  opts?: { chain?: Chain; rpcUrl?: string; includeTestnet?: boolean },
): Promise<string[]> {
  if (opts?.chain) {
    const client = createClient({ chain: opts.chain, transport: http(opts.rpcUrl) })
    const explorerUrl = opts.chain.blockExplorers?.default?.url
    const label = pc.dim(`(${chainName(opts.chain)})`)
    if (isTestnet(opts.chain)) {
      const results = await Promise.all(
        testnetTokens.map((token) => fetchTokenInfo(client, token, address)),
      )
      return results
        .filter((t) => t.balance > 0n)
        .map(
          (t) =>
            `${fmtBalance(t.balance, t.symbol, t.decimals, { explorerUrl, token: t.token })} ${label}`,
        )
    }
    const results = await Promise.all(
      mainnetTokens.map((token) => fetchTokenInfo(client, token, address)),
    )
    return results.map(
      (t) =>
        `${fmtBalance(t.balance, t.symbol, t.decimals, { explorerUrl, token: t.token })} ${label}`,
    )
  }

  const mainnetClient = createClient({
    chain: tempoMainnet,
    transport: http(process.env.MPPX_RPC_URL || undefined),
  })
  const mainnetExplorerUrl = tempoMainnet.blockExplorers?.default?.url
  const mainnetResults = await Promise.all(
    mainnetTokens.map((token) => fetchTokenInfo(mainnetClient, token, address)),
  )
  const lines = mainnetResults.map((t) =>
    fmtBalance(t.balance, t.symbol, t.decimals, {
      explorerUrl: mainnetExplorerUrl,
      token: t.token,
    }),
  )

  if (opts?.includeTestnet !== false) {
    const testnetClient = createClient({ chain: tempoModerato, transport: http() })
    const testnetExplorerUrl = tempoModerato.blockExplorers?.default?.url
    const testnetResults = await Promise.all(
      testnetTokens.map((token) => fetchTokenInfo(testnetClient, token, address)),
    )
    for (const t of testnetResults) {
      if (t.balance > 0n)
        lines.push(
          `${fmtBalance(t.balance, t.symbol, t.decimals, { explorerUrl: testnetExplorerUrl, token: t.token })} ${pc.dim('(testnet)')}`,
        )
    }
  }

  return lines
}
