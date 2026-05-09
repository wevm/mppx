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

const accountSummarySchema = z.object({
  address: z.string(),
  isDefault: z.boolean().optional(),
  name: z.string(),
  source: z.string().optional(),
})

const accountViewSchema = z.object({
  address: z.string(),
  balances: z.array(z.string()).optional(),
  name: z.string(),
  type: z.string().optional(),
})

const discoveryIssueSchema = z.object({
  message: z.string(),
  path: z.string(),
  severity: z.string(),
})

const serviceSummarySchema = z.object({
  description: z.string().optional(),
  id: z.string(),
  name: z.string().optional(),
  paidEndpoints: z.number(),
  status: z.string().optional(),
  url: z.string().optional(),
})

const serviceEndpointSchema = z.object({
  description: z.string().optional(),
  method: z.string(),
  path: z.string(),
  payment: z.unknown().optional(),
})

const servicesRegistryUrl = 'https://mpp.dev/api/services'

function shouldReturnStructured(c: { format: string; formatExplicit: boolean }) {
  return c.format === 'json' && c.formatExplicit
}

function outputResult<Data>(
  c: { format: string; formatExplicit: boolean; ok: (data: Data) => never },
  data: Data,
  print: () => void,
): Data {
  if (shouldReturnStructured(c)) return c.ok(data)
  print()
  return undefined as unknown as Data
}

function canReadCommandStdin() {
  if (process.stdin.isTTY !== false) return false
  return process.stdin.listenerCount('data') === 0 && process.stdin.listenerCount('readable') === 0
}

type ServiceRegistryService = Record<string, unknown>
type ServiceRegistryEndpoint = Record<string, unknown>

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getEndpoints(service: ServiceRegistryService): ServiceRegistryEndpoint[] {
  return Array.isArray(service.endpoints)
    ? service.endpoints.filter(
        (endpoint): endpoint is ServiceRegistryEndpoint =>
          typeof endpoint === 'object' && endpoint !== null,
      )
    : []
}

function summarizeService(service: ServiceRegistryService) {
  const endpoints = getEndpoints(service)
  return {
    ...(getString(service.description) ? { description: getString(service.description) } : {}),
    id: getString(service.id) ?? getString(service.name) ?? 'unknown',
    ...(getString(service.name) ? { name: getString(service.name) } : {}),
    paidEndpoints: endpoints.filter((endpoint) => endpoint.payment).length,
    ...(getString(service.status) ? { status: getString(service.status) } : {}),
    ...(getString(service.serviceUrl) || getString(service.url)
      ? { url: getString(service.serviceUrl) ?? getString(service.url) }
      : {}),
  }
}

function summarizeEndpoint(endpoint: ServiceRegistryEndpoint) {
  return {
    ...(getString(endpoint.description) ? { description: getString(endpoint.description) } : {}),
    method: getString(endpoint.method) ?? 'GET',
    path: getString(endpoint.path) ?? '/',
    ...(endpoint.payment !== undefined ? { payment: endpoint.payment } : {}),
  }
}

function formatPayment(payment: unknown): string {
  if (!payment) return 'free'
  if (typeof payment !== 'object') return String(payment)
  const p = payment as Record<string, unknown>
  const amount = getString(p.amount)
  const currency = getString(p.currency)
  const method = getString(p.method)
  const intent = getString(p.intent)
  return [amount, currency, method && intent ? `${method}/${intent}` : (method ?? intent)]
    .filter(Boolean)
    .join(' ')
}

async function fetchServicesRegistry(): Promise<ServiceRegistryService[]> {
  const url = process.env.MPPX_SERVICES_URL ?? servicesRegistryUrl
  const response = await globalThis.fetch(url)
  if (!response.ok)
    throw new Errors.IncurError({
      code: 'SERVICES_FETCH_FAILED',
      message: `Failed to fetch services registry: HTTP ${response.status}`,
      exitCode: 1,
    })
  const json = (await response.json()) as unknown
  if (
    !json ||
    typeof json !== 'object' ||
    !Array.isArray((json as { services?: unknown }).services)
  )
    throw new Errors.IncurError({
      code: 'SERVICES_INVALID',
      message: 'Services registry response did not contain a services array.',
      exitCode: 1,
    })
  return (json as { services: ServiceRegistryService[] }).services
}

function findService(
  services: ServiceRegistryService[],
  id: string,
): ServiceRegistryService | undefined {
  const needle = id.toLowerCase()
  return services.find((service) => {
    const serviceId = getString(service.id)?.toLowerCase()
    const serviceName = getString(service.name)?.toLowerCase()
    return serviceId === needle || serviceName === needle
  })
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
    network: z.enum(['mainnet', 'testnet']).optional().describe('Tempo network'),
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
          options: {
            account: c.options.account,
            network: c.options.network,
            rpcUrl: c.options.rpcUrl,
          },
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
  description: 'Manage accounts (create, default, delete, export, fund, list, view)',
})
  .command('create', {
    description: 'Create new account',
    options: z.object({
      account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
      network: z.enum(['mainnet', 'testnet']).optional().describe('Tempo network'),
      rpcUrl: z.string().optional().describe('RPC endpoint (env: MPPX_RPC_URL)'),
    }),
    output: z.object({ address: z.string(), name: z.string() }),
    alias: { account: 'a', rpcUrl: 'r' },
    async run(c) {
      const structured = shouldReturnStructured(c)
      let resolvedName = c.options.account
      if (!resolvedName) {
        const existing = await createKeychain().list()
        if (existing.length === 0) resolvedName = 'main'
        else {
          if (structured)
            return c.error({
              code: 'ACCOUNT_REQUIRED',
              message: 'Account name is required in structured mode.',
              exitCode: 2,
            })
          const input = await prompt('Account name')
          if (!input) return undefined as never
          resolvedName = input
        }
      }
      let keychain = createKeychain(resolvedName)
      while (await keychain.get()) {
        if (structured)
          return c.error({
            code: 'ACCOUNT_EXISTS',
            message: `Account "${resolvedName}" already exists.`,
            exitCode: 1,
          })
        process.stderr.write(`${pc.dim(`Account "${resolvedName}" already exists.`)}\n\n`)
        const input = await prompt('Enter different name')
        if (!input) return undefined as never
        resolvedName = input
        keychain = createKeychain(resolvedName)
      }
      const privateKey = generatePrivateKey()
      const acct = privateKeyToAccount(privateKey)
      await keychain.set(privateKey)
      const accounts = await createKeychain().list()
      if (accounts.length === 1) createDefaultStore().set(resolvedName)
      const explorerUrl = tempoMainnet.blockExplorers?.default?.url
      const addrDisplay = explorerUrl
        ? link(`${explorerUrl}/address/${acct.address}`, acct.address)
        : acct.address
      const rpcUrl = resolveRpcUrl(c.options.rpcUrl, { network: c.options.network })
      resolveChain({ network: c.options.network, rpcUrl })
        .then((chain) => createClient({ chain, transport: http(rpcUrl) }))
        .then((client) =>
          import('viem/tempo').then(({ Actions }) =>
            Actions.faucet.fund(client, { account: acct }).catch(() => {}),
          ),
        )
      return outputResult(c, { address: acct.address, name: resolvedName }, () => {
        console.log(`Account "${resolvedName}" saved to keychain.`)
        console.log(pc.dim(`Address ${addrDisplay}`))
      })
    },
  })
  .command('default', {
    description: 'Set default account',
    options: z.object({
      account: z.string().describe('Account name'),
    }),
    output: z.object({ name: z.string() }),
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
        return outputResult(c, { name: accountName }, () => {
          console.log(`Default account set to "${accountName}"`)
        })
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
      return outputResult(c, { name: accountName }, () => {
        console.log(`Default account set to "${accountName}"`)
      })
    },
  })
  .command('delete', {
    description: 'Delete account',
    options: z.object({
      account: z.string().describe('Account name'),
      yes: z.boolean().optional().describe('DANGER!! Skip confirmation prompts'),
    }),
    output: z.object({ defaultAccount: z.string().optional(), name: z.string() }),
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
        if (shouldReturnStructured(c))
          return c.error({
            code: 'CONFIRMATION_REQUIRED',
            message: 'Pass --yes to delete an account in structured mode.',
            exitCode: 2,
          })
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
          return undefined as never
        }
      }
      await keychain.delete()
      const currentDefault = createDefaultStore().get()
      let defaultAccount: string | undefined
      if (currentDefault === c.options.account) {
        const remaining = await createKeychain().list()
        if (remaining.length > 0) {
          defaultAccount = remaining[0]!
          createDefaultStore().set(defaultAccount)
        } else {
          createDefaultStore().clear()
        }
      }
      return outputResult(c, { defaultAccount, name: c.options.account }, () => {
        if (defaultAccount) console.log(`Default account set to "${defaultAccount}"`)
        console.log(`Account "${c.options.account}" deleted`)
      })
    },
  })
  .command('fund', {
    description: 'Fund account with testnet tokens',
    options: z.object({
      account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
      network: z.enum(['mainnet', 'testnet']).optional().describe('Tempo network'),
      rpcUrl: z.string().optional().describe('RPC endpoint (env: MPPX_RPC_URL)'),
    }),
    output: z.object({ account: z.string(), chain: z.string(), transactions: z.array(z.string()) }),
    alias: { account: 'a', rpcUrl: 'r' },
    async run(c) {
      const structured = shouldReturnStructured(c)
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
      const rpcUrl = resolveRpcUrl(c.options.rpcUrl, { network: c.options.network })
      const chain = await resolveChain({ network: c.options.network, rpcUrl })
      const client = createClient({ chain, transport: http(rpcUrl) })
      if (!structured) console.log(`Funding "${accountName}" on ${chainName(chain)}`)
      try {
        const { Actions } = await import('viem/tempo')
        const hashes = await Actions.faucet.fund(client, { account: acct })
        const explorerUrl = chain.blockExplorers?.default?.url
        if (!structured) {
          for (const hash of hashes) {
            const label = explorerUrl ? link(`${explorerUrl}/tx/${hash}`, pc.gray(hash)) : hash
            console.log(`  ${label}`)
          }
        }
        const { waitForTransactionReceipt } = await import('viem/actions')
        await Promise.all(hashes.map((hash) => waitForTransactionReceipt(client, { hash })))
        return outputResult(
          c,
          { account: accountName, chain: chainName(chain), transactions: [...hashes] },
          () => {
            console.log('Funded successfully')
          },
        )
      } catch (err) {
        if (structured)
          return c.error({
            code: 'FUNDING_FAILED',
            message: err instanceof Error ? err.message : String(err),
            exitCode: 1,
          })
        console.error('Funding failed:', err instanceof Error ? err.message : err)
        return undefined as never
      }
    },
  })
  .command('list', {
    description: 'List all accounts',
    output: z.object({ accounts: z.array(accountSummarySchema) }),
    async run(c) {
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
        return outputResult(c, { accounts: [] }, () => {
          console.log(`No accounts found.`)
        })
      }
      const explorerUrl = tempoMainnet.blockExplorers?.default?.url
      const maxWidth = Math.max(
        ...resolved.map((e) => e.name.length + (e.name === currentDefault ? 1 : 0)),
      )
      return outputResult(
        c,
        {
          accounts: resolved.map((entry) => ({
            ...entry,
            ...(entry.name === currentDefault ? { isDefault: true } : undefined),
          })),
        },
        () => {
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
      )
    },
  })
  .command('export', {
    description: 'Export the private key for a local account',
    options: z.object({
      account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
    }),
    output: z.object({ privateKey: z.string() }),
    alias: { account: 'a' },
    async run(c) {
      const accountName = resolveAccountName(c.options.account)

      if (isTempoAccount(accountName)) {
        return c.error({
          code: 'UNSUPPORTED_ACCOUNT',
          message: `Account "${accountName}" is managed by Tempo wallet and does not expose a private key via mppx.`,
          exitCode: 2,
        })
      }

      const key = await createKeychain(accountName).get()
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

      return outputResult(c, { privateKey: key }, () => {
        console.log(key)
      })
    },
  })
  .command('view', {
    description: 'View account address',
    options: z.object({
      account: z.string().optional().describe('Account name (env: MPPX_ACCOUNT)'),
      network: z.enum(['mainnet', 'testnet']).optional().describe('Tempo network'),
      rpcUrl: z.string().optional().describe('RPC endpoint (env: MPPX_RPC_URL)'),
    }),
    output: accountViewSchema,
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
        const rpcUrl = resolveRpcUrl(c.options.rpcUrl, { network: c.options.network })
        const chain = await resolveChain({ network: c.options.network, rpcUrl })
        const explorerUrl = chain.blockExplorers?.default?.url
        const addrDisplay = explorerUrl
          ? link(`${explorerUrl}/address/${address}`, address)
          : address

        const balanceLines = await fetchBalanceLines(
          address,
          chain && rpcUrl ? { chain, rpcUrl } : undefined,
        )
        return outputResult(
          c,
          {
            address,
            balances: balanceLines,
            name: accountName,
            type: `${tempoEntry.wallet_type} (tempo wallet)`,
          },
          () => {
            console.log(`${pc.dim('Address')}  ${addrDisplay}`)
            for (let i = 0; i < balanceLines.length; i++)
              console.log(`${pc.dim(i === 0 ? 'Balance' : '       ')}  ${balanceLines[i]}`)
            console.log(`${pc.dim('Name')}     ${accountName}`)
            console.log(
              `${pc.dim('Type')}     ${tempoEntry.wallet_type} ${pc.dim('(tempo wallet)')}`,
            )
          },
        )
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
      const rpcUrl = resolveRpcUrl(c.options.rpcUrl, { network: c.options.network })
      const chain = await resolveChain({ network: c.options.network, rpcUrl })
      const explorerUrl = chain.blockExplorers?.default?.url
      const addrDisplay = explorerUrl
        ? link(`${explorerUrl}/address/${acct.address}`, acct.address)
        : acct.address

      const balanceLines = await fetchBalanceLines(
        acct.address,
        chain && rpcUrl ? { chain, rpcUrl } : undefined,
      )
      return outputResult(
        c,
        { address: acct.address, balances: balanceLines, name: accountName },
        () => {
          console.log(`${pc.dim('Address')}  ${addrDisplay}`)
          for (let i = 0; i < balanceLines.length; i++)
            console.log(`${pc.dim(i === 0 ? 'Balance' : '       ')}  ${balanceLines[i]}`)
          console.log(`${pc.dim('Name')}     ${accountName}`)
        },
      )
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
    network: z.enum(['mainnet', 'testnet']).optional().describe('Tempo network'),
    rpcUrl: z
      .string()
      .optional()
      .describe('RPC endpoint, defaults to public RPC for chain (env: MPPX_RPC_URL)'),
  }),
  output: z.object({ authorization: z.string() }),
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
      (canReadCommandStdin()
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
      return undefined as never
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
        options: {
          account: c.options.account,
          network: c.options.network,
          rpcUrl: c.options.rpcUrl,
        },
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

    return outputResult(c, { authorization: credential }, () => {
      console.log(credential)
    })
  },
})

const init = Cli.create('init', {
  description: 'Create an mppx.config.ts file in the current directory',
  options: z.object({
    force: z.boolean().optional().describe('Overwrite existing config file'),
  }),
  output: z.object({ file: z.string() }),
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
    return outputResult(c, { file: dest }, () => {
      console.log(`Created ${filename}`)
    })
  },
})

const services = Cli.create('services', {
  description: 'Browse the MPP services registry',
})
  .command('list', {
    description: 'List registered MPP services',
    options: z.object({
      query: z.string().optional().describe('Filter by id, name, category, tag, or description'),
    }),
    output: z.object({ services: z.array(serviceSummarySchema) }),
    alias: { query: 'q' },
    async run(c) {
      const query = c.options.query?.toLowerCase()
      const registry = await fetchServicesRegistry()
      const filtered = query
        ? registry.filter((service) =>
            [
              service.id,
              service.name,
              service.description,
              ...(Array.isArray(service.categories) ? service.categories : []),
              ...(Array.isArray(service.tags) ? service.tags : []),
            ]
              .filter((value): value is string => typeof value === 'string')
              .some((value) => value.toLowerCase().includes(query)),
          )
        : registry
      const summaries = filtered.map(summarizeService).sort((a, b) => a.id.localeCompare(b.id))
      return outputResult(c, { services: summaries }, () => {
        if (summaries.length === 0) {
          console.log('No services found.')
          return
        }
        const idWidth = Math.max(...summaries.map((service) => service.id.length))
        const paidWidth = Math.max(
          ...summaries.map((service) => String(service.paidEndpoints).length),
        )
        for (const service of summaries) {
          const name = service.name && service.name !== service.id ? `  ${service.name}` : ''
          const url = service.url ? `  ${pc.dim(service.url)}` : ''
          console.log(
            `${service.id.padEnd(idWidth)}  ${String(service.paidEndpoints).padStart(paidWidth)} paid${name}${url}`,
          )
        }
      })
    },
  })
  .command('show', {
    description: 'Show one registered MPP service',
    args: z.object({
      service: z.string().describe('Service id or name'),
    }),
    output: z.object({ service: z.record(z.string(), z.unknown()) }),
    async run(c) {
      const registry = await fetchServicesRegistry()
      const service = findService(registry, c.args.service)
      if (!service)
        return c.error({
          code: 'SERVICE_NOT_FOUND',
          message: `Service not found: ${c.args.service}`,
          exitCode: 1,
        })
      const summary = summarizeService(service)
      const endpoints = getEndpoints(service)
      return outputResult(c, { service }, () => {
        console.log(`${summary.name ?? summary.id} ${pc.dim(`(${summary.id})`)}`)
        if (summary.description) console.log(summary.description)
        if (summary.url) console.log(`${pc.dim('URL')}       ${link(summary.url, summary.url)}`)
        if (summary.status) console.log(`${pc.dim('Status')}    ${summary.status}`)
        console.log(`${pc.dim('Endpoints')} ${endpoints.length} (${summary.paidEndpoints} paid)`)
        const docs = service.docs as Record<string, unknown> | undefined
        const homepage = docs && getString(docs.homepage)
        if (homepage) console.log(`${pc.dim('Docs')}      ${link(homepage, homepage)}`)
      })
    },
  })
  .command('endpoints', {
    description: 'List endpoints for a registered MPP service',
    args: z.object({
      service: z.string().describe('Service id or name'),
    }),
    output: z.object({
      endpoints: z.array(serviceEndpointSchema),
      service: serviceSummarySchema,
    }),
    async run(c) {
      const registry = await fetchServicesRegistry()
      const service = findService(registry, c.args.service)
      if (!service)
        return c.error({
          code: 'SERVICE_NOT_FOUND',
          message: `Service not found: ${c.args.service}`,
          exitCode: 1,
        })
      const summary = summarizeService(service)
      const endpoints = getEndpoints(service).map(summarizeEndpoint)
      return outputResult(c, { endpoints, service: summary }, () => {
        if (endpoints.length === 0) {
          console.log(`No endpoints found for ${summary.id}.`)
          return
        }
        const methodWidth = Math.max(...endpoints.map((endpoint) => endpoint.method.length))
        const pathWidth = Math.max(...endpoints.map((endpoint) => endpoint.path.length))
        for (const endpoint of endpoints) {
          const payment = formatPayment(endpoint.payment)
          const description = endpoint.description ? `  ${pc.dim(endpoint.description)}` : ''
          console.log(
            `${endpoint.method.padEnd(methodWidth)}  ${endpoint.path.padEnd(pathWidth)}  ${payment}${description}`,
          )
        }
      })
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
    output: z.record(z.string(), z.unknown()),
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
        return outputResult(c, doc, () => {})
      } else {
        return outputResult(c, doc, () => {
          console.log(json)
        })
      }
    },
  })
  .command('validate', {
    description: 'Validate an OpenAPI discovery document from a file or URL',
    args: z.object({
      input: z.string().describe('Path or URL to a discovery document'),
    }),
    output: z.object({
      errorCount: z.number(),
      issues: z.array(discoveryIssueSchema),
      valid: z.boolean(),
      warningCount: z.number(),
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
      if (!shouldReturnStructured(c))
        for (const issue of issues)
          console.log(`[${issue.severity}] ${issue.path}: ${issue.message}`)

      const errorCount = issues.filter((issue) => issue.severity === 'error').length
      const warningCount = issues.filter((issue) => issue.severity === 'warning').length

      if (errorCount > 0) {
        return c.error({
          code: 'DISCOVERY_INVALID',
          message: `Discovery document has ${errorCount} error(s) and ${warningCount} warning(s).`,
          exitCode: 1,
        })
      }

      return outputResult(c, { errorCount, issues, valid: true, warningCount }, () => {
        console.log(
          warningCount > 0
            ? `Discovery document is valid with ${warningCount} warning(s).`
            : 'Discovery document is valid.',
        )
      })
    },
  })

cli.command(account)
cli.command(discover)
cli.command(init)
cli.command(services)
cli.command(sign)

export default cli
