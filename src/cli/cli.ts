import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { Cli, Errors, z } from 'incur'
import { Base64 } from 'ox'
import { type Address, createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoMainnet } from 'viem/chains'

import * as Challenge from '../Challenge.js'
import { normalizeHeaders } from '../client/internal/Fetch.js'
import * as Mppx from '../client/Mppx.js'
import { validate as validateDiscovery } from '../discovery/Validate.js'
import { createDefaultStore, createKeychain, resolveAccountName } from './account.js'
import { loadConfig, resolveAcceptPayment, selectChallenge } from './internal.js'
import type { Plugin } from './plugins/plugin.js'
import { readTempoKeystore, resolveTempoAccount } from './plugins/tempo.js'
import {
  chainName,
  confirm,
  decodeMemo,
  fetchBalanceLines,
  fmtBalance,
  fmtChallengeValue,
  fmtRequestValue,
  isTempoAccount,
  link,
  parseMethodOpts,
  pc,
  printRequestHeaders,
  printResponseHeaders,
  prompt,
  resolveChain,
  resolveRpcUrl,
} from './utils.js'

const packageJson = createRequire(import.meta.url)('../../package.json') as {
  name: string
  version: string
}

const cli = Cli.create('mppx', {
  version: packageJson.version,
  description: 'Make HTTP requests with automatic payment handling',
  usage: [{ suffix: '<url> [options]' }],
  args: z.object({
    url: z.string().describe('URL to make request to'),
  }),
  options: z.object({
    account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    config: z.string().optional().describe('Path to config file'),
    confirm: z.boolean().optional().default(false).describe('Show confirmation prompts'),
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
    silent: z.boolean().default(false).describe('Silent mode (suppress progress and info)'),
    userAgent: z
      .string()
      .optional()
      .default(`${packageJson.name}/${packageJson.version}`)
      .describe('Set User-Agent header'),
    verbose: z
      .number()
      .default(0)
      .meta({ count: true })
      .describe('Verbosity (-v details, -vv headers)'),
  }),
  alias: {
    account: 'a',
    config: 'c',
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
  examples: [{ args: { url: 'mpp.dev/api/ping/paid' }, description: 'Make a payment request' }],
  async run(c) {
    const info = c.options.silent
      ? (_msg: string) => {}
      : (msg: string) => process.stderr.write(msg)

    const loaded = await loadConfig(c.options.config)
    if (loaded && c.options.verbose >= 1)
      info(`${pc.dim('Using config')} ${pc.blue(path.relative(process.cwd(), loaded.path))}\n`)

    const headers: Record<string, string> = {
      'User-Agent': c.options.userAgent,
    }
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
    const acceptPayment = resolveAcceptPayment(loaded?.config)
    if (
      acceptPayment &&
      !Object.keys(headers).some((key) => key.toLowerCase() === 'accept-payment')
    ) {
      headers['Accept-Payment'] = acceptPayment
    }

    const url = (() => {
      const hasProtocol = /^https?:\/\//.test(c.args.url)
      const isLocal = /^(localhost|.*\.localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(c.args.url)
      return hasProtocol ? c.args.url : `${isLocal ? 'http' : 'https'}://${c.args.url}`
    })()
    const { hostname } = new URL(url)
    const insecure =
      c.options.insecure ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')

    // Scoped fetch that temporarily disables TLS verification only for
    // the target connection when `insecure` is true, then restores
    // the original value so other HTTPS connections are unaffected.
    const targetFetch: typeof globalThis.fetch = insecure
      ? async (input, init) => {
          const orig = process.env.NODE_TLS_REJECT_UNAUTHORIZED
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
          try {
            return await globalThis.fetch(input, init)
          } finally {
            if (orig === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
            else process.env.NODE_TLS_REJECT_UNAUTHORIZED = orig
          }
        }
      : globalThis.fetch

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
      const init: RequestInit = { redirect: c.options.location ? 'follow' : 'manual' }
      if (c.options.jsonBody) {
        init.body = c.options.jsonBody
        headers['Content-Type'] ??= 'application/json'
        headers.Accept ??= 'application/json'
      } else if (c.options.data) {
        init.body = c.options.data
      }
      if (c.options.method) init.method = c.options.method.toUpperCase()
      else if (init.body) init.method = 'POST'
      if (Object.keys(headers).length > 0) init.headers = headers

      const headerOpts = {
        include: c.options.include ?? false,
        verbose: c.options.verbose,
        silent: c.options.silent,
      }

      if (c.options.verbose >= 2) printRequestHeaders(url, init, info)
      const challengeResponse = await targetFetch(fetchUrl, init)
      if (challengeResponse.status !== 402) {
        if (c.options.fail && challengeResponse.status >= 400)
          return c.error({
            code: 'HTTP_ERROR',
            message: `HTTP error ${challengeResponse.status}`,
            exitCode: 22,
          })
        printResponseHeaders(challengeResponse, headerOpts)
        console.log((await challengeResponse.text()).replace(/\n+$/, ''))
        return
      }

      const selected = selectChallenge(
        Challenge.fromResponseList(challengeResponse),
        loaded?.config,
      )
      if (!selected) {
        const offers = Challenge.fromResponseList(challengeResponse)
          .map((challenge) => `${challenge.method}/${challenge.intent}`)
          .join(', ')
        return c.error({
          code: 'UNSUPPORTED_METHOD',
          message: `Unsupported payment method. Server offers: ${offers}. Add it to mppx.config.ts using defineConfig().`,
          exitCode: 2,
        })
      }

      const { challenge, plugin, method: configMethod } = selected
      const selectedChallengeResponse = new Response(null, {
        status: 402,
        headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
      })

      let tokenSymbol = (challenge.request.currency as string | undefined) ?? ''
      let tokenDecimals = (challenge.request.decimals as number | undefined) ?? 6
      let explorerUrl: string | undefined
      let pluginResult: Awaited<ReturnType<Plugin['setup']>> | undefined
      if (plugin) {
        pluginResult = await plugin.setup({
          challenge,
          options: { account: c.options.account, rpcUrl: c.options.rpcUrl },
          methodOpts: parseMethodOpts(c.options.methodOpt),
        })
        tokenSymbol = pluginResult.tokenSymbol
        tokenDecimals = pluginResult.tokenDecimals
        explorerUrl = pluginResult.explorerUrl
      }

      const confirmEnabled = c.options.silent ? false : c.options.confirm

      // Display challenge
      const shownKeys = new Set<string>()
      {
        printResponseHeaders(challengeResponse, headerOpts)

        const challengeRows = (() => {
          const skip = new Set(['id', 'request'])
          const rows: [string, string][] = []
          for (const [key, value] of Object.entries(challenge)) {
            if (skip.has(key) || value === undefined) continue
            rows.push([key, fmtChallengeValue(key, value)])
          }
          return rows.sort(([a], [b]) => a.localeCompare(b))
        })()

        const fmtCtx = { tokenSymbol, tokenDecimals, explorerUrl }
        const requestRows = (() => {
          const skip = new Set(['decimals', 'currency', 'methodDetails'])
          const rows: [string, string][] = []
          for (const [key, value] of Object.entries(challenge.request)) {
            if (skip.has(key) || value === undefined) continue
            rows.push([key, fmtRequestValue(key, value, fmtCtx)])
          }
          return rows.sort(([a], [b]) => a.localeCompare(b))
        })()

        const detailRows = (() => {
          const methodDetails = challenge.request.methodDetails as
            | Record<string, unknown>
            | undefined
          if (!methodDetails) return []
          const rows: [string, string][] = []
          for (const [key, value] of Object.entries(methodDetails)) {
            if (value === undefined) continue
            if (key === 'memo' && typeof value === 'string') {
              const decoded = decodeMemo(value)
              rows.push([key, decoded ? `${decoded}\n${pc.dim(value)}` : value])
            } else {
              rows.push([key, fmtRequestValue(key, value, fmtCtx)])
            }
          }
          return rows.sort(([a], [b]) => a.localeCompare(b))
        })()

        const sections: [string, [string, string][]][] = [
          ['Challenge', challengeRows],
          ['Request', requestRows],
          ...(detailRows.length ? [['Details', detailRows] as [string, [string, string][]]] : []),
        ]
        for (const [, rows] of sections) for (const [key] of rows) shownKeys.add(key)
        const pad = Math.max(...sections.flatMap(([, rows]) => rows.map(([k]) => k.length)))
        const indent = `  ${''.padEnd(pad)}  `

        if (c.options.verbose >= 1 || confirmEnabled) {
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
      if (pluginResult?.createCredential)
        credential = await pluginResult.createCredential(selectedChallengeResponse)
      else if (pluginResult) {
        const mppx = Mppx.create({ methods: pluginResult.methods, polyfill: false })
        credential = await mppx.createCredential(
          selectedChallengeResponse,
          pluginResult.credentialContext as undefined,
        )
      } else if (configMethod) {
        const mppx = Mppx.create({ methods: [configMethod], polyfill: false })
        credential = await mppx.createCredential(selectedChallengeResponse)
      } else throw new Error('unreachable')

      // Send credential and get response
      const credentialHeaders = {
        ...normalizeHeaders(init.headers),
        Authorization: credential,
      }
      plugin?.prepareCredentialRequest?.({ challenge, credential, headers: credentialHeaders })

      const credentialFetchInit = { ...init, headers: credentialHeaders }
      if (c.options.verbose >= 2) printRequestHeaders(url, credentialFetchInit, info)
      const credentialResponse = await targetFetch(fetchUrl, credentialFetchInit)

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

      printResponseHeaders(credentialResponse, headerOpts)

      // Let plugin own the response lifecycle if it wants to
      const handled = await plugin?.handleResponse?.({
        challenge,
        credential,
        response: credentialResponse,
        fetchUrl,
        fetchInit: init,
        silent: c.options.silent,
        verbose: c.options.verbose,
        confirmEnabled,
        confirm,
        tokenSymbol,
        tokenDecimals,
        explorerUrl,
        shownKeys,
      })

      if (!handled) {
        // Default: print receipt + body
        const receiptHeader = credentialResponse.headers.get('Payment-Receipt')
        if (receiptHeader && c.options.verbose >= 1) {
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
              const formatted = plugin?.formatReceiptField?.(key, value)
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
                rows.push([key, link(`${explorerUrl}/tx/${value}`, value)])
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
  .command('create', {
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
        ? link(`${explorerUrl}/address/${acct.address}`, acct.address)
        : acct.address
      console.log(pc.dim(`Address ${addrDisplay}`))
      const rpcUrl = resolveRpcUrl(c.options.rpcUrl)
      resolveChain({ rpcUrl })
        .then((chain) => createClient({ chain, transport: http(rpcUrl) }))
        .then((client) =>
          import('viem/tempo').then(({ Actions }) =>
            Actions.faucet.fund(client, { account: acct }).catch(() => {}),
          ),
        )
    },
  })
  .command('default', {
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
  .command('delete', {
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
          ? link(`${explorerUrl}/address/${acct.address}`, acct.address)
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
  .command('fund', {
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
        else
          return c.error({ code: 'ACCOUNT_NOT_FOUND', message: 'No account found.', exitCode: 69 })
      }
      const acct = privateKeyToAccount(key as `0x${string}`)
      const rpcUrl = resolveRpcUrl(c.options.rpcUrl)
      const chain = await resolveChain({ rpcUrl })
      const client = createClient({ chain, transport: http(rpcUrl) })
      console.log(`Funding "${accountName}" on ${chainName(chain)}`)
      try {
        const { Actions } = await import('viem/tempo')
        const hashes = await Actions.faucet.fund(client, { account: acct })
        const explorerUrl = chain.blockExplorers?.default?.url
        for (const hash of hashes) {
          const label = explorerUrl ? link(`${explorerUrl}/tx/${hash}`, pc.gray(hash)) : hash
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
  .command('list', {
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
          ? link(`${explorerUrl}/address/${entry.address}`, entry.address)
          : entry.address
        const sourceLabel = entry.source ? `  ${pc.dim(`(${entry.source})`)}` : ''
        console.log(
          `${label}${' '.repeat(maxWidth - width + 2)}${pc.dim(addrDisplay)}${sourceLabel}`,
        )
      }
    },
  })
  .command('view', {
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
        const rpcUrl = resolveRpcUrl(c.options.rpcUrl)
        const chain = await resolveChain({ rpcUrl })
        const explorerUrl = chain.blockExplorers?.default?.url
        const addrDisplay = explorerUrl
          ? link(`${explorerUrl}/address/${address}`, address)
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
        else
          return c.error({ code: 'ACCOUNT_NOT_FOUND', message: 'No account found.', exitCode: 69 })
      }
      const acct = privateKeyToAccount(key as `0x${string}`)
      const rpcUrl = resolveRpcUrl(c.options.rpcUrl)
      const chain = await resolveChain({ rpcUrl })
      const explorerUrl = chain.blockExplorers?.default?.url
      const addrDisplay = explorerUrl
        ? link(`${explorerUrl}/address/${acct.address}`, acct.address)
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

const sign = Cli.create('sign', {
  description: 'Sign a payment challenge and output the Authorization header',
  usage: [
    { suffix: '--challenge <value> [options]' },
    { prefix: 'echo <challenge> |', suffix: '[options]' },
  ],
  options: z.object({
    account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    challenge: z.string().optional().describe('WWW-Authenticate challenge value'),
    config: z.string().optional().describe('Path to config file'),
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
    challenge: 'C',
    config: 'c',
    methodOpt: 'M',
    rpcUrl: 'r',
  },
  async run(c) {
    const raw =
      c.options.challenge ||
      (process.stdin.isTTY === false
        ? await new Promise<string>((resolve, reject) => {
            let data = ''
            process.stdin.setEncoding('utf-8')
            process.stdin.on('data', (chunk) => {
              data += chunk
            })
            process.stdin.on('end', () => resolve(data.trim()))
            process.stdin.on('error', reject)
          })
        : undefined)
    if (!raw) {
      return c.error({
        code: 'NO_CHALLENGE',
        message: 'No challenge provided. Use --challenge or pipe via stdin.',
        exitCode: 2,
      })
    }

    let challenges: Challenge.Challenge[]
    try {
      challenges = Challenge.deserializeList(raw)
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

    const loaded = await loadConfig(c.options.config)
    const selected = selectChallenge(challenges, loaded?.config)
    if (!selected) {
      const offers = challenges
        .map((challenge) => `${challenge.method}/${challenge.intent}`)
        .join(', ')
      return c.error({
        code: 'UNSUPPORTED_METHOD',
        message: `Unsupported payment method. Server offers: ${offers}. Add it to mppx.config.ts using defineConfig().`,
        exitCode: 2,
      })
    }

    const { challenge, plugin, method: configMethod } = selected
    const methodOpts = parseMethodOpts(c.options.methodOpt)

    const wwwAuth = Challenge.serialize(challenge)
    const fakeResponse = new Response(null, {
      status: 402,
      headers: { 'WWW-Authenticate': wwwAuth },
    })

    let credential: string
    if (plugin) {
      const result = await plugin.setup({
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

export default defineConfig({
  methods: [],
  plugins: [],
})
`

    fs.writeFileSync(dest, template)
    console.log(`Created ${filename}`)
  },
})

const discover = Cli.create('discover', {
  description: 'Discovery tooling',
})
  .command('generate', {
    description: 'Generate a static OpenAPI discovery document from a module',
    args: z.object({
      module: z.string().describe('Path to a module that default-exports a discovery config'),
    }),
    options: z.object({
      output: z.string().optional().describe('Write output to a file instead of stdout'),
    }),
    alias: { output: 'o' },
    async run(c) {
      const modulePath = path.resolve(c.args.module)
      if (!fs.existsSync(modulePath)) {
        return c.error({
          code: 'MODULE_NOT_FOUND',
          message: `Module not found: ${modulePath}`,
          exitCode: 1,
        })
      }

      let mod: Record<string, unknown>
      try {
        mod = await import(modulePath)
      } catch (error) {
        return c.error({
          code: 'MODULE_IMPORT_FAILED',
          message: `Failed to import module: ${(error as Error).message}`,
          exitCode: 1,
        })
      }

      const exported = (mod.default ?? mod) as Record<string, unknown>

      // If the export is already a plain OpenAPI doc (has `openapi` key), use it directly.
      // Otherwise, expect { mppx, ...GenerateConfig } and call generate().
      let doc: Record<string, unknown>
      if (typeof exported.openapi === 'string') {
        doc = exported
      } else {
        const { generate } = await import('../discovery/OpenApi.js')
        const mppx = exported.mppx as { methods: readonly any[]; realm: string }
        if (!mppx) {
          return c.error({
            code: 'INVALID_MODULE',
            message:
              'Module must default-export an OpenAPI document (with `openapi` key) or an object with `mppx` (server instance) and `routes`.',
            exitCode: 1,
          })
        }
        doc = generate(mppx, exported as any)
      }

      const json = JSON.stringify(doc, null, 2)
      if (c.options.output) {
        const outPath = path.resolve(c.options.output)
        fs.writeFileSync(outPath, `${json}\n`)
        process.stderr.write(`Wrote ${outPath}\n`)
      } else {
        console.log(json)
      }
    },
  })
  .command('validate', {
    description: 'Validate an OpenAPI discovery document from a file or URL',
    args: z.object({
      input: z.string().describe('Path or URL to a discovery document'),
    }),
    async run(c) {
      const input = c.args.input
      let raw: string
      if (/^https?:\/\//.test(input)) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        let response: Response
        try {
          response = await globalThis.fetch(input, { signal: controller.signal })
        } catch (error) {
          clearTimeout(timeout)
          const msg =
            error instanceof DOMException && error.name === 'AbortError'
              ? 'Request timed out after 30s'
              : (error as Error).message
          return c.error({
            code: 'DISCOVERY_FETCH_FAILED',
            message: `Failed to fetch discovery document: ${msg}`,
            exitCode: 1,
          })
        }
        clearTimeout(timeout)
        if (!response.ok) {
          return c.error({
            code: 'DISCOVERY_FETCH_FAILED',
            message: `Failed to fetch discovery document: HTTP ${response.status}`,
            exitCode: 1,
          })
        }
        const maxSize = 10 * 1024 * 1024 // 10 MB
        const contentLength = response.headers.get('content-length')
        if (contentLength && Number(contentLength) > maxSize) {
          return c.error({
            code: 'DISCOVERY_TOO_LARGE',
            message: `Discovery document exceeds 10 MB limit`,
            exitCode: 1,
          })
        }
        raw = await response.text()
        if (raw.length > maxSize) {
          return c.error({
            code: 'DISCOVERY_TOO_LARGE',
            message: `Discovery document exceeds 10 MB limit`,
            exitCode: 1,
          })
        }
      } else {
        const resolved = path.resolve(input)
        if (!fs.existsSync(resolved)) {
          return c.error({
            code: 'DISCOVERY_NOT_FOUND',
            message: `Discovery document not found: ${resolved}`,
            exitCode: 1,
          })
        }
        raw = fs.readFileSync(resolved, 'utf-8')
      }

      let doc: unknown
      try {
        doc = JSON.parse(raw)
      } catch (error) {
        return c.error({
          code: 'DISCOVERY_INVALID_JSON',
          message: `Invalid discovery JSON: ${(error as Error).message}`,
          exitCode: 1,
        })
      }

      const issues = validateDiscovery(doc)
      for (const issue of issues) console.log(`[${issue.severity}] ${issue.path}: ${issue.message}`)

      const errorCount = issues.filter((issue) => issue.severity === 'error').length
      const warningCount = issues.filter((issue) => issue.severity === 'warning').length

      if (errorCount > 0) {
        return c.error({
          code: 'DISCOVERY_INVALID',
          message: `Discovery document has ${errorCount} error(s) and ${warningCount} warning(s).`,
          exitCode: 1,
        })
      }

      console.log(
        warningCount > 0
          ? `Discovery document is valid with ${warningCount} warning(s).`
          : 'Discovery document is valid.',
      )
    },
  })

cli.command(account)
cli.command(discover)
cli.command(init)
cli.command(sign)

export default cli
