#!/usr/bin/env node
import * as child from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { cac } from 'cac'
import { Base64 } from 'ox'
import type { Chain } from 'viem'
import { type Address, createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import { type ZodMiniType, z } from 'zod/mini'
import * as Challenge from './Challenge.js'
import * as Credential from './Credential.js'
import * as Mppx from './client/Mppx.js'
import { stripe } from './stripe/client/index.js'
import { tempo } from './tempo/client/index.js'
import type { SessionCredentialPayload } from './tempo/session/Types.js'
import { signVoucher } from './tempo/session/Voucher.js'

const require = createRequire(import.meta.url)
const { name, version } = require('../package.json') as { name: string; version: string }

const cli = cac(name)

cli
  .command('[url]', 'Make HTTP request with automatic payment')
  .option('-a, --account <name>', 'Account name (env: MPPX_ACCOUNT)')
  .option('-d, --data <data>', 'Send request body (implies POST unless -X is set)')
  .option('-f, --fail', 'Fail silently on HTTP errors (exit 22)')
  .option('-i, --include', 'Include response headers in output')
  .option('-k, --insecure', 'Skip TLS certificate verification (true for localhost/.local)')
  .option(
    '-r, --rpc-url <url>',
    'RPC endpoint, defaults to public RPC for chain (env: MPPX_RPC_URL)',
  )
  .option('-s, --silent', 'Silent mode (suppress progress and info)')
  .option('-v, --verbose', 'Show request/response headers')
  .option('-A, --user-agent <ua>', 'Set User-Agent header')
  .option('-H, --header <header>', 'Add header (repeatable)')
  .option('-L, --location', 'Follow redirects')
  .option('-X, --method <method>', 'HTTP method')
  .option('-M, --method-opt <opt>', 'Method-specific option (key=value, repeatable)')
  .option('--confirm', 'Show confirmation prompts')
  .option('--json <json>', 'Send JSON body (sets Content-Type and Accept, implies POST)')
  .example(`${name} example.com/content`)
  .example(`${name} example.com/api --json '{"key":"value"}'`)
  .action(async (rawUrl: string | undefined, rawOptions: unknown) => {
    const options = parseOptions(
      z.object({
        account: z.optional(z.string()),
        confirm: z.optional(z.boolean()),
        data: z.optional(z.string()),
        fail: z.optional(z.boolean()),
        header: z.optional(z.union([z.string(), z.array(z.string())])),
        include: z.optional(z.boolean()),
        insecure: z.optional(z.boolean()),
        json: z.optional(z.string()),
        location: z.optional(z.boolean()),
        method: z.optional(z.string()),
        methodOpt: z.optional(z.union([z.string(), z.array(z.string())])),
        rpcUrl: z.optional(z.string()),
        silent: z.optional(z.boolean()),
        userAgent: z.optional(z.string()),
        verbose: z.optional(z.boolean()),
      }),
      rawOptions,
    )
    const methodOpts = parseMethodOpts(options.methodOpt)
    if (!rawUrl) {
      cli.outputHelp()
      return
    }

    const silent = options.silent ?? false
    const info = silent ? (_msg: string) => {} : (msg: string) => process.stderr.write(msg)
    if (silent) options.confirm = false

    const accountName = resolveAccountName(options.account)

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
    headers['User-Agent'] = options.userAgent ?? `${name}/${version}`

    const url = (() => {
      const hasProtocol = /^https?:\/\//.test(rawUrl)
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(rawUrl)
      return hasProtocol ? rawUrl : `${isLocal ? 'http' : 'https'}://${rawUrl}`
    })()
    const { hostname } = new URL(url)
    if (options.insecure || hostname === 'localhost' || hostname.endsWith('.local')) {
      process.removeAllListeners('warning')
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }

    try {
      const fetchInit: RequestInit = { redirect: options.location ? 'follow' : 'manual' }
      if (options.json) {
        fetchInit.body = options.json
        headers['Content-Type'] ??= 'application/json'
        headers.Accept ??= 'application/json'
      } else if (options.data) {
        fetchInit.body = options.data
      }
      if (options.method) fetchInit.method = options.method.toUpperCase()
      else if (fetchInit.body) fetchInit.method = 'POST'
      if (Object.keys(headers).length > 0) fetchInit.headers = headers

      const verbose = options.verbose ?? false

      const printRequestHeaders = (reqUrl: string, init: RequestInit) => {
        if (!verbose) return
        const { pathname, host } = new URL(reqUrl)
        const method = (init.method ?? 'GET').toUpperCase()
        info(`> ${method} ${pathname} HTTP/1.1\n`)
        info(`> Host: ${host}\n`)
        for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
          info(`> ${k}: ${v}\n`)
        info('>\n')
      }

      const printResponseHeaders = (res: Response) => {
        if (!options.include && !verbose) return
        if (silent) return
        const status = `HTTP/1.1 ${res.status} ${res.statusText}`
        const out = verbose ? process.stderr : process.stdout
        const prefix = verbose ? '< ' : ''
        out.write(`${prefix}${status}\n`)
        for (const [k, v] of res.headers) out.write(`${prefix}${k}: ${v}\n`)
        out.write(verbose ? '<\n' : '\n')
      }

      printRequestHeaders(url, fetchInit)
      const challengeResponse = await globalThis.fetch(url, fetchInit)
      if (challengeResponse.status !== 402) {
        if (options.fail && challengeResponse.status >= 400) process.exit(22)
        printResponseHeaders(challengeResponse)
        console.log((await challengeResponse.text()).replace(/\n+$/, ''))
        return
      }

      const challenge = Challenge.fromResponse(challengeResponse)
      const challengeRequest = challenge.request as Record<string, unknown>
      const currency = challengeRequest.currency as string | undefined
      const shownKeys = new Set<string>()

      let tokenSymbol = currency ?? ''
      let tokenDecimals = (challengeRequest.decimals as number | undefined) ?? 6
      let explorerUrl: string | undefined

      // Tempo-specific setup (private key, viem account/client, token info)
      let account: ReturnType<typeof privateKeyToAccount> | undefined
      let client: ReturnType<typeof createClient> | undefined
      if (challenge.method === 'tempo') {
        const privateKey = process.env.MPPX_PRIVATE_KEY ?? (await createKeychain(accountName).get())
        if (!privateKey) {
          if (options.account) console.error(`Account "${accountName}" not found.`)
          else console.error(`No account found.`)
          process.exit(1)
        }
        account = privateKeyToAccount(privateKey as `0x${string}`)
        const rpcUrl = options.rpcUrl ?? process.env.RPC_URL
        client = createClient({
          chain: await resolveChain({ ...options, rpcUrl }),
          transport: http(rpcUrl),
        })
        explorerUrl = client.chain?.blockExplorers?.default?.url
        const tokenInfo = currency
          ? await fetchTokenInfo(client, currency as Address, account.address).catch(
              () => undefined,
            )
          : undefined
        tokenSymbol = tokenInfo?.symbol ?? currency ?? ''
        tokenDecimals =
          tokenInfo?.decimals ?? (challengeRequest.decimals as number | undefined) ?? 6
      }

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

        info(`${pc.bold(pc.yellow('Payment Required'))}\n`)
        for (const [title, rows] of sections) {
          info(`${pc.bold(title)}\n`)
          for (const [label, value] of rows) {
            const [first, ...rest] = value.split('\n')
            info(`  ${pc.dim(label.padEnd(pad))}  ${first}\n`)
            for (const line of rest) info(`${indent}${line}\n`)
          }
        }
        if (options.confirm) {
          info('\n')
          const ok = await confirm(`Proceed with ${challenge.intent}?`, true)
          if (!ok) {
            info('Aborted.\n')
            process.exit(0)
          }
        }
      }

      let credential: string
      if (challenge.method === 'tempo') {
        if (!account || !client) {
          console.error('Tempo requires a configured account.')
          process.exit(1)
        }
        const tempoOpts = parseOptions(
          z.object({
            channel: z.optional(z.coerce.string()),
            deposit: z.optional(z.union([z.string(), z.number()])),
          }),
          methodOpts,
        )
        const mppx = Mppx.create({
          methods: tempo({
            account,
            getClient: () => client!,
            deposit: (() => {
              if (challenge.intent !== 'session') return undefined
              const suggestedDeposit = (challenge.request as Record<string, unknown>)
                .suggestedDeposit as string | undefined
              const cliDeposit =
                tempoOpts.deposit !== undefined ? String(tempoOpts.deposit) : undefined
              const resolved =
                suggestedDeposit ?? cliDeposit ?? (isTestnet(client!.chain!) ? '10' : undefined)
              if (!resolved) {
                console.error(
                  'Session payment requires a deposit. Use -M deposit=<amount> or connect to testnet.',
                )
                process.exit(1)
              }
              return resolved
            })(),
          }),
          polyfill: false,
        })
        credential = await mppx.createCredential(
          challengeResponse,
          (() => {
            if (!tempoOpts.channel) return undefined
            const channelId = tempoOpts.channel
            const saved = readChannelCumulative(channelId)
            return {
              channelId,
              ...(saved !== undefined && { cumulativeAmountRaw: saved.toString() }),
            }
          })(),
        )
      } else if (challenge.method === 'stripe') {
        const stripeOpts = parseOptions(
          z.object({
            paymentMethod: z.string(),
          }),
          methodOpts,
        )
        const stripeSecretKey = process.env.STRIPE_SECRET_KEY
        if (!stripeSecretKey) {
          console.error('STRIPE_SECRET_KEY environment variable is required for Stripe payments.')
          process.exit(1)
        }
        const mppx = Mppx.create({
          methods: [
            stripe.charge({
              paymentMethod: stripeOpts.paymentMethod,
              createToken: async ({
                paymentMethod,
                amount,
                currency,
                networkId,
                expiresAt,
                metadata,
              }) => {
                const body = new URLSearchParams({
                  payment_method: paymentMethod!,
                  'usage_limits[currency]': currency,
                  'usage_limits[max_amount]': amount,
                  'usage_limits[expires_at]': expiresAt.toString(),
                })
                if (networkId) body.set('seller_details[network_id]', networkId)
                if (metadata) {
                  for (const [key, value] of Object.entries(metadata)) {
                    body.set(`metadata[${key}]`, value)
                  }
                }
                const response = await globalThis.fetch(
                  'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens',
                  {
                    method: 'POST',
                    headers: {
                      Authorization: `Basic ${btoa(`${stripeSecretKey}:`)}`,
                      'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body,
                  },
                )
                if (!response.ok) {
                  const error = (await response.json()) as { error: { message: string } }
                  throw new Error(`Failed to create SPT: ${error.error.message}`)
                }
                const { id } = (await response.json()) as { id: string }
                return id
              },
            }),
          ],
          polyfill: false,
        })
        credential = await mppx.createCredential(challengeResponse)
      } else {
        console.error(`Unsupported payment method: ${challenge.method}`)
        process.exit(1)
      }

      const sessionMd = challenge.request.methodDetails as
        | { escrowContract?: string; chainId?: number }
        | undefined
      let sessionChannelId: `0x${string}` | undefined
      let sessionEscrowContract: Address | undefined
      let sessionChainId = 0
      let sessionCumulativeAmount = 0n

      if (challenge.intent === 'session') {
        const parsed = Credential.deserialize<SessionCredentialPayload>(credential)
        sessionChannelId = parsed.payload.channelId
        sessionChainId = sessionMd?.chainId ?? client?.chain?.id ?? 0
        sessionEscrowContract = sessionMd?.escrowContract as Address | undefined
        if ('cumulativeAmount' in parsed.payload && parsed.payload.cumulativeAmount)
          sessionCumulativeAmount = BigInt(parsed.payload.cumulativeAmount)

        if (parsed.payload.action === 'open') {
          const depositRaw = challengeRequest.suggestedDeposit as string | undefined
          const depositDisplay = depositRaw
            ? ` ${pc.dim(`(deposit ${depositRaw} ${tokenSymbol})`)}`
            : ''
          const prefix = options.confirm ? '' : '\n'
          info(
            `${prefix}${pc.dim(`Channel opened ${parsed.payload.channelId}`)}${depositDisplay}\n`,
          )
        } else {
          const prefix = options.confirm ? '' : '\n'
          info(`${prefix}${pc.dim(`Channel reused ${parsed.payload.channelId}`)}\n`)
        }
      }

      const credentialFetchInit = {
        ...fetchInit,
        headers: { ...(fetchInit.headers as Record<string, string>), Authorization: credential },
      }
      printRequestHeaders(url, credentialFetchInit)
      const credentialResponse = await globalThis.fetch(url, credentialFetchInit)

      if (options.fail && credentialResponse.status >= 400) process.exit(22)

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
        process.exit(1)
      } else {
        printResponseHeaders(credentialResponse)

        const receiptHeader = credentialResponse.headers.get('Payment-Receipt')
        if (receiptHeader) {
          try {
            const receiptJson = JSON.parse(Base64.toString(receiptHeader)) as Record<
              string,
              unknown
            >
            if (
              typeof receiptJson.acceptedCumulative === 'string' &&
              receiptJson.acceptedCumulative
            ) {
              sessionCumulativeAmount = BigInt(receiptJson.acceptedCumulative)
              if (sessionChannelId)
                writeChannelCumulative(sessionChannelId, sessionCumulativeAmount)
            }
            info(`\n${pc.bold(pc.green('Payment Receipt'))}\n`)
            const rows: [string, string][] = []
            const channelId = receiptJson.channelId
            const reference = receiptJson.reference
            const skipReference = channelId && reference && channelId === reference
            const receiptBalanceKeys = new Set(['acceptedCumulative', 'spent'])
            for (const [key, value] of Object.entries(receiptJson)) {
              if (value === undefined || shownKeys.has(key)) continue
              if (key === 'reference' && skipReference) continue
              if (receiptBalanceKeys.has(key) && typeof value === 'string') {
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
        const contentType = credentialResponse.headers.get('Content-Type') ?? ''
        if (contentType.includes('text/event-stream')) {
          const reader = credentialResponse.body?.getReader()
          if (!reader) {
            console.error('No response body')
            process.exit(1)
          }
          const decoder = new TextDecoder()
          let buffer = ''
          let currentEvent = ''

          const sessionCred =
            challenge.intent === 'session'
              ? Credential.deserialize<SessionCredentialPayload>(credential)
              : undefined
          const channelId = sessionCred?.payload.channelId
          const md = challenge.request.methodDetails as
            | { escrowContract?: string; chainId?: number }
            | undefined
          const sessionChainId = md?.chainId ?? client?.chain?.id ?? 0
          const escrowContract = md?.escrowContract as Address | undefined
          let cumulativeAmount =
            sessionCred?.payload &&
            'cumulativeAmount' in sessionCred.payload &&
            sessionCred.payload.cumulativeAmount
              ? BigInt(sessionCred.payload.cumulativeAmount)
              : 0n
          let _voucherSeq = 0

          const termBg = verbose ? await detectTerminalBg() : undefined
          const chunkBgs = (() => {
            if (!termBg || !pc.isColorSupported) return undefined
            const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
            const isDark = 0.299 * termBg.r + 0.587 * termBg.g + 0.114 * termBg.b < 128
            const offset = isDark ? 1 : -1
            const bgRgb = (d: number) => (s: string) => {
              const r = clamp(termBg.r + d * offset)
              const g = clamp(termBg.g + d * offset)
              const b = clamp(termBg.b + d * offset)
              return `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`
            }
            return [bgRgb(12), bgRgb(24)] as const
          })()
          let chunkIdx = 0

          const writeContent = (chunk: string) => {
            if (chunkBgs) {
              const bgFn = chunkBgs[chunkIdx % chunkBgs.length]!
              process.stdout.write(chunk.replace(/[^\n]+/g, (m) => bgFn(m)))
              chunkIdx++
            } else {
              process.stdout.write(chunk)
            }
          }

          const processLines = async (lines: string[]) => {
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim()
                continue
              }
              if (!line.startsWith('data: ')) {
                if (line === '') currentEvent = ''
                continue
              }
              const data = line.slice(6)
              if (data.trim() === '[DONE]') continue
              if (
                currentEvent === 'payment-need-voucher' &&
                channelId &&
                escrowContract &&
                sessionChainId
              ) {
                try {
                  const event = JSON.parse(data) as {
                    channelId: string
                    requiredCumulative: string
                  }
                  const required = BigInt(event.requiredCumulative)
                  cumulativeAmount = cumulativeAmount > required ? cumulativeAmount : required

                  const signature = await signVoucher(
                    client!,
                    account!,
                    { channelId, cumulativeAmount },
                    escrowContract,
                    sessionChainId,
                  )
                  const voucherCred = Credential.serialize({
                    challenge,
                    payload: {
                      action: 'voucher',
                      channelId,
                      cumulativeAmount: cumulativeAmount.toString(),
                      signature,
                    },
                    source: `did:pkh:eip155:${sessionChainId}:${account!.address}`,
                  })
                  await globalThis.fetch(url, {
                    method: 'POST',
                    headers: { Authorization: voucherCred },
                  })
                  _voucherSeq++
                } catch (e) {
                  info(
                    pc.dim(pc.yellow(` [voucher failed: ${e instanceof Error ? e.message : e}]`)),
                  )
                }
                currentEvent = ''
                continue
              }
              if (currentEvent === 'payment-receipt') {
                try {
                  const receipt = JSON.parse(data) as Record<string, unknown>
                  info(`\n\n${pc.bold(pc.green('Payment Receipt'))}\n`)
                  const rows: [string, string][] = []
                  const skipRef =
                    receipt.channelId &&
                    receipt.reference &&
                    receipt.channelId === receipt.reference
                  for (const [key, value] of Object.entries(receipt)) {
                    if (value === undefined || shownKeys.has(key)) continue
                    if (key === 'reference' && skipRef) continue
                    const receiptBalanceKeys = ['acceptedCumulative', 'spent']
                    if (receiptBalanceKeys.includes(key) && typeof value === 'string') {
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
                  const rpad = Math.max(...rows.map(([k]) => k.length))
                  for (const [label, value] of rows)
                    info(`  ${pc.dim(label.padEnd(rpad))}  ${value}\n`)
                } catch {}
                currentEvent = ''
                continue
              }
              if (data.length === 0) {
                writeContent('\n')
              } else {
                try {
                  const parsed = JSON.parse(data) as {
                    token?: string
                    choices?: { delta?: { content?: string } }[]
                  }

                  writeContent(parsed.token ?? parsed.choices?.[0]?.delta?.content ?? data)
                } catch {
                  writeContent(data)
                }
              }
              currentEvent = ''
            }
          }

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            await processLines(lines)
          }
          if (buffer.trim()) await processLines([buffer])

          if (channelId && escrowContract && sessionChainId) {
            const signature = await signVoucher(
              client!,
              account!,
              { channelId, cumulativeAmount },
              escrowContract,
              sessionChainId,
            )
            const closePayload: SessionCredentialPayload = {
              action: 'close',
              channelId,
              cumulativeAmount: cumulativeAmount.toString(),
              signature,
            }
            const closeCred = Credential.serialize({
              challenge,
              payload: closePayload,
              source: `did:pkh:eip155:${sessionChainId}:${account!.address}`,
            })
            const closeRes = await globalThis.fetch(url, {
              method: 'POST',
              headers: { Authorization: closeCred },
            })
            if (closeRes.ok) {
              const closeReceiptHeader = closeRes.headers.get('Payment-Receipt')
              let closeTxHash: string | undefined
              if (closeReceiptHeader) {
                try {
                  const r = JSON.parse(Base64.toString(closeReceiptHeader)) as Record<
                    string,
                    unknown
                  >
                  if (typeof r.txHash === 'string') closeTxHash = r.txHash
                } catch {}
              }
              const txInfo =
                closeTxHash && explorerUrl
                  ? ` ${pc.dim(pc.link(`${explorerUrl}/tx/${closeTxHash}`, closeTxHash))}`
                  : ''
              info(
                `\n${pc.dim('Channel closed.')} ${pc.dim(`Spent ${fmtBalance(cumulativeAmount, tokenSymbol, tokenDecimals)}.`)}${txInfo}\n`,
              )
            } else {
              info(
                `\n${pc.dim(pc.yellow('Channel close failed'))} ${pc.dim(`(${closeRes.status})`)}\n`,
              )
            }
          }
        } else {
          const body = (await credentialResponse.text()).replace(/\n+$/, '')
          console.log(body)

          const shouldClose =
            challenge.intent === 'session' &&
            credentialResponse.ok &&
            sessionChannelId &&
            sessionEscrowContract &&
            sessionChainId
          if (shouldClose && options.confirm) {
            info('\n')
          }
          if (shouldClose && options.confirm && !(await confirm('Close channel?', true))) {
            info(`${pc.dim('Kept channel open.')}\n`)
          } else if (shouldClose) {
            const signature = await signVoucher(
              client!,
              account!,
              { channelId: sessionChannelId!, cumulativeAmount: sessionCumulativeAmount },
              sessionEscrowContract!,
              sessionChainId,
            )
            const closePayload: SessionCredentialPayload = {
              action: 'close',
              channelId: sessionChannelId!,
              cumulativeAmount: sessionCumulativeAmount.toString(),
              signature,
            }
            const closeCred = Credential.serialize({
              challenge,
              payload: closePayload,
              source: `did:pkh:eip155:${sessionChainId}:${account!.address}`,
            })
            const closeRes = await globalThis.fetch(url, {
              ...fetchInit,
              headers: {
                ...(fetchInit.headers as Record<string, string>),
                Authorization: closeCred,
              },
            })
            if (closeRes.ok) {
              deleteChannelState(sessionChannelId!)
              const closeReceiptHeader = closeRes.headers.get('Payment-Receipt')
              let closeTxHash: string | undefined
              if (closeReceiptHeader) {
                try {
                  const r = JSON.parse(Base64.toString(closeReceiptHeader)) as Record<
                    string,
                    unknown
                  >
                  if (typeof r.txHash === 'string') closeTxHash = r.txHash
                } catch {}
              }
              const txInfo =
                closeTxHash && explorerUrl
                  ? ` ${pc.dim(pc.link(`${explorerUrl}/tx/${closeTxHash}`, closeTxHash))}`
                  : ''
              const closePrefix = options.confirm ? '' : '\n'
              info(
                `${closePrefix}${pc.dim('Channel closed.')} ${pc.dim(`Spent ${fmtBalance(sessionCumulativeAmount, tokenSymbol, tokenDecimals)}.`)}${txInfo}\n`,
              )
            } else {
              const closeBody = await closeRes.text().catch(() => '')
              info(
                `\n${pc.dim(pc.yellow('Channel close failed'))} ${pc.dim(`(${closeRes.status})`)}\n`,
              )
              info(
                `${pc.dim(`  channelId:          ${sessionChannelId}`)}\n` +
                  `${pc.dim(`  cumulativeAmount:   ${sessionCumulativeAmount}`)}\n` +
                  `${pc.dim(`  escrowContract:     ${sessionEscrowContract}`)}\n` +
                  `${pc.dim(`  chainId:            ${sessionChainId}`)}\n` +
                  `${pc.dim(`  account:            ${account?.address}`)}\n` +
                  `${pc.dim(`  response:           ${closeBody || '(empty)'}`)}\n`,
              )
            }
          }
        }
      }
    } catch (err) {
      // TODO: revert cast when https://github.com/wevm/zile/pull/26 is merged
      const errCause =
        err instanceof Error ? (err as unknown as Record<string, unknown>).cause : undefined
      const cause = errCause instanceof Error ? errCause : undefined

      if (cause && 'code' in cause) {
        const code = cause.code as string
        if (code === 'ENOTFOUND')
          console.error(`Could not resolve host "${hostname}". Check the URL and try again.`)
        else if (code === 'ECONNREFUSED')
          console.error(`Connection refused by "${hostname}". Is the server running?`)
        else if (code === 'ECONNRESET') console.error(`Connection to "${hostname}" was reset.`)
        else if (code === 'ETIMEDOUT') console.error(`Connection to "${hostname}" timed out.`)
        else if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
          console.error(
            `TLS certificate error for "${hostname}". Use --insecure to skip verification.`,
          )
        else {
          console.error(`Request to "${hostname}" failed: ${cause.message}`)
        }
      } else {
        console.error('Request failed:', err instanceof Error ? err.message : err)
        if (cause) console.error('Cause:', cause.message)
      }
      process.exit(1)
    }
  })

const accountOptionsSchema = z.object({
  account: z.optional(z.string()),
  rpcUrl: z.optional(z.string()),
  yes: z.optional(z.boolean()),
})

cli
  .command('account [action]', 'Manage accounts (create, default, delete, fund, list, view)')
  .option('-a, --account <name>', 'Account name (env: MPPX_ACCOUNT)')
  .option(
    '-r, --rpc-url <url>',
    'RPC endpoint, defaults to public RPC for chain (env: MPPX_RPC_URL)',
  )
  .option('--yes', 'DANGER!! Skip confirmation prompts')
  .action(async (action: string | undefined, rawOptions: unknown) => {
    if (!action) {
      cli.outputHelp()
      return
    }
    const options = parseOptions(accountOptionsSchema, rawOptions)
    switch (action) {
      case 'create': {
        let resolvedName = options.account
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
        const account = privateKeyToAccount(privateKey)
        await keychain.set(privateKey)
        const accounts = await createKeychain().list()
        if (accounts.length === 1) createDefaultStore().set(resolvedName)
        console.log(`Account "${resolvedName}" saved to keychain.`)
        const explorerUrl = tempoMainnet.blockExplorers?.default?.url
        const addrDisplay = explorerUrl
          ? pc.link(`${explorerUrl}/address/${account.address}`, account.address)
          : account.address
        console.log(pc.dim(`Address ${addrDisplay}`))
        resolveChain(options)
          .then((chain) => createClient({ chain, transport: http(options.rpcUrl) }))
          .then((client) =>
            import('viem/tempo').then(({ Actions }) =>
              Actions.faucet.fund(client, { account }).catch(() => {}),
            ),
          )
        return
      }
      case 'default': {
        const accountName = options.account
        if (!accountName) {
          console.error('-a, --account <name> is required for default.')
          process.exit(1)
        }
        const key = await createKeychain(accountName).get()
        if (!key) {
          console.log(`Account "${accountName}" not found.`)
          process.exit(1)
        }
        createDefaultStore().set(accountName)
        console.log(`Default account set to "${accountName}"`)
        return
      }
      case 'delete': {
        if (!options.account) {
          console.error('-a, --account <name> is required for delete.')
          process.exit(1)
        }
        const keychain = createKeychain(options.account)
        const key = await keychain.get()
        if (!key) {
          console.log(`Account "${options.account}" not found.`)
          process.exit(1)
        }
        const account = privateKeyToAccount(key as `0x${string}`)
        const balanceLines = await fetchBalanceLines(account.address, { includeTestnet: false })
        if (!options.yes) {
          const explorerUrl = tempoMainnet.blockExplorers?.default?.url
          const addrDisplay = explorerUrl
            ? pc.link(`${explorerUrl}/address/${account.address}`, account.address)
            : account.address
          process.stderr.write(pc.dim(`Delete account "${options.account}"\n`))
          process.stderr.write(pc.dim(`  Address  ${addrDisplay}\n`))
          for (let i = 0; i < balanceLines.length; i++)
            process.stderr.write(
              pc.dim(`  ${i === 0 ? 'Balance' : '       '}  ${balanceLines[i]}\n`),
            )
          process.stderr.write(pc.dim('This action cannot be undone\n\n'))
          const confirmed = await confirm('Confirm delete?')
          if (!confirmed) {
            console.log('Canceled')
            return
          }
        }
        await keychain.delete()
        const currentDefault = createDefaultStore().get()
        if (currentDefault === options.account) {
          const remaining = await createKeychain().list()
          if (remaining.length > 0) {
            createDefaultStore().set(remaining[0]!)
            console.log(`Default account set to "${remaining[0]}"`)
          } else {
            createDefaultStore().clear()
          }
        }
        console.log(`Account "${options.account}" deleted`)
        return
      }
      case 'fund': {
        const accountName = resolveAccountName(options.account)
        const keychain = createKeychain(accountName)
        const key = await keychain.get()
        if (!key) {
          if (options.account) console.log(`Account "${accountName}" not found.`)
          else console.log(`No account found.`)
          process.exit(1)
        }
        const account = privateKeyToAccount(key as `0x${string}`)
        const chain = await resolveChain(options)
        const client = createClient({ chain, transport: http(options.rpcUrl) })
        console.log(`Funding "${accountName}" on ${chainName(chain)}`)
        try {
          const { Actions } = await import('viem/tempo')
          const hashes = await Actions.faucet.fund(client, { account })
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
        return
      }
      case 'list': {
        const currentDefault = createDefaultStore().get()
        const accounts = (await createKeychain().list()).sort()
        if (accounts.length === 0) {
          console.log(`No accounts found.`)
          return
        }
        const entries = await Promise.all(
          accounts.map(async (accountName) => {
            const key = await createKeychain(accountName).get()
            if (!key) return undefined
            return {
              name: accountName,
              address: privateKeyToAccount(key as `0x${string}`).address,
            }
          }),
        )
        const resolved = entries.filter((e) => e !== undefined)
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
          console.log(`${label}${' '.repeat(maxWidth - width + 2)}${pc.dim(addrDisplay)}`)
        }
        return
      }
      case 'view': {
        const accountName = resolveAccountName(options.account)
        const keychain = createKeychain(accountName)
        const key = await keychain.get()
        if (!key) {
          if (options.account) console.log(`Account "${accountName}" not found.`)
          else console.log(`No account found.`)
          process.exit(1)
        }
        const account = privateKeyToAccount(key as `0x${string}`)
        const rpcUrl = options.rpcUrl ?? (process.env.MPPX_RPC_URL || undefined)
        const chain = rpcUrl ? await resolveChain({ rpcUrl }) : tempoMainnet
        const explorerUrl = chain.blockExplorers?.default?.url
        const addrDisplay = explorerUrl
          ? pc.link(`${explorerUrl}/address/${account.address}`, account.address)
          : account.address
        console.log(`${pc.dim('Address')}  ${addrDisplay}`)

        const balanceLines = await fetchBalanceLines(
          account.address,
          chain && rpcUrl ? { chain, rpcUrl } : undefined,
        )
        for (let i = 0; i < balanceLines.length; i++)
          console.log(`${pc.dim(i === 0 ? 'Balance' : '       ')}  ${balanceLines[i]}`)

        console.log(`${pc.dim('Name')}     ${accountName}`)
        return
      }
      default:
        console.error(`Unknown action: ${action}`)
        console.error('Available: create, default, delete, fund, list, view')
        process.exit(1)
    }
  })

cli.version(version, '-V, --version')

cli.help((sections) => {
  const isAccount = sections.some((s: { body?: string }) => s.body?.includes('$ mppx account'))
  if (isAccount) {
    const actionsSection = {
      title: 'Actions',
      body: [
        '  create   Create new account',
        '  default  Set default account',
        '  delete   Delete account',
        '  fund     Fund account with testnet tokens',
        '  list     List all accounts',
        '  view     View account address',
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

function parseMethodOpts(raw: string | string[] | undefined): Record<string, string> {
  if (!raw) return {}
  const list = Array.isArray(raw) ? raw : [raw]
  const result: Record<string, string> = {}
  for (const item of list) {
    const idx = item.indexOf('=')
    if (idx === -1) {
      console.error(`Invalid method option format: ${item} (expected key=value)`)
      process.exit(1)
    }
    result[item.slice(0, idx)] = item.slice(idx + 1)
  }
  return result
}

function parseOptions<const schema extends ZodMiniType>(
  schema: schema,
  rawOptions: unknown,
): z.output<schema> {
  const result = schema.safeParse(rawOptions ?? {})
  if (result.success) return result.data
  const summary = result.error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'options'
      return `${path}: ${issue.message}`
    })
    .join(', ')
  throw new Error(`Invalid CLI options (${summary})`)
}

function execCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    child.execFile(command, args, (error, stdout, stderr) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), error })
    })
  })
}

function channelStateDir() {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'mppx',
    'channels',
  )
}

function readChannelCumulative(channelId: string): bigint | undefined {
  try {
    const raw = fs.readFileSync(path.join(channelStateDir(), channelId), 'utf-8').trim()
    return raw ? BigInt(raw) : undefined
  } catch {
    return undefined
  }
}

function writeChannelCumulative(channelId: string, cumulative: bigint): void {
  const dir = channelStateDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, channelId), cumulative.toString(), 'utf-8')
}

function deleteChannelState(channelId: string): void {
  try {
    fs.unlinkSync(path.join(channelStateDir(), channelId))
  } catch {}
}

function createDefaultStore() {
  const configPath = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'mppx',
    'default',
  )
  return {
    get(): string {
      try {
        return fs.readFileSync(configPath, 'utf-8').trim() || 'main'
      } catch {
        return 'main'
      }
    },
    set(value: string): void {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, value, 'utf-8')
    },
    clear(): void {
      try {
        fs.unlinkSync(configPath)
      } catch {}
    },
  }
}

function resolveAccountName(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.MPPX_ACCOUNT?.trim()) return process.env.MPPX_ACCOUNT
  return createDefaultStore().get()
}

// biome-ignore format: compact shell commands
function createKeychain(account = 'main') {
  const service = name
  return {
    async list(): Promise<string[]> {
      const platform = os.platform()
      if (platform === 'darwin') {
          const { stdout, error } = await execCommand('security', ['dump-keychain'])
          if (error) return []
          const accounts: string[] = []
          const blocks = stdout.split('keychain:')
          for (const block of blocks) {
            const serviceMatch = block.match(/"svce"<blob>="([^"]*)"/)
            const accountMatch = block.match(/"acct"<blob>="([^"]*)"/)
            if (serviceMatch?.[1] === service && accountMatch?.[1]) accounts.push(accountMatch[1])
          }
          return accounts
      }
      if (platform === 'linux') {
          const { stdout, stderr, error } = await execCommand('secret-tool', ['search', '--all', '--unlock', 'service', service])
          if (error) return []
          const combined = `${stdout}\n${stderr}`
          const accounts: string[] = []
          const matches = combined.matchAll(/\baccount = (.+)/g)
          for (const match of matches) if (match[1]) accounts.push(match[1])
          return accounts
      }
      throw new Error(`Unsupported platform: ${platform}`)
    },
    async get(): Promise<string | undefined> {
      const platform = os.platform()
      if (platform === 'darwin') {
          const { stdout, error } = await execCommand('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
          return error ? undefined : stdout
      }
      if (platform === 'linux') {
          const { stdout, error } = await execCommand('secret-tool', ['lookup', 'service', service, 'account', account])
          return error ? undefined : stdout || undefined
      }
      throw new Error(`Unsupported platform: ${platform}`)
    },
    async set(value: string): Promise<void> {
      const platform = os.platform()
      if (platform === 'darwin') {
          await execCommand('security', ['delete-generic-password', '-s', service, '-a', account])
          const { error } = await execCommand('security', ['add-generic-password', '-s', service, '-a', account, '-w', value])
          if (error) throw error
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
          await execCommand('security', ['delete-generic-password', '-s', service, '-a', account])
          return
      }
      if (platform === 'linux') {
          await execCommand('secret-tool', ['clear', 'service', service, 'account', account])
          return
      }
      throw new Error(`Unsupported platform: ${platform}`)
    },
  }
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

// Inlined from https://github.com/alexeyraspopov/picocolors (ISC License)
const pc = (() => {
  const p = process || ({} as NodeJS.Process)
  const argv = p.argv || []
  const env = p.env || {}
  const isColorSupported =
    !(!!env.NO_COLOR || argv.includes('--no-color')) &&
    (!!env.FORCE_COLOR ||
      argv.includes('--color') ||
      ((p.stdout || ({} as NodeJS.WriteStream)).isTTY && env.TERM !== 'dumb') ||
      !!env.CI)

  const replaceClose = (string: string, close: string, replace: string, index: number): string => {
    let result = ''
    let cursor = 0
    let i = index
    do {
      result += string.substring(cursor, i) + replace
      cursor = i + close.length
      i = string.indexOf(close, cursor)
    } while (~i)
    return result + string.substring(cursor)
  }

  const formatter =
    (open: string, close: string, replace = open) =>
    (input: unknown) => {
      const string = `${input}`
      const index = string.indexOf(close, open.length)
      return ~index
        ? open + replaceClose(string, close, replace, index) + close
        : open + string + close
    }

  const f = isColorSupported ? formatter : () => String
  return {
    isColorSupported,
    reset: f('\x1b[0m', '\x1b[0m'),
    bold: f('\x1b[1m', '\x1b[22m', '\x1b[22m\x1b[1m'),
    dim: f('\x1b[2m', '\x1b[22m', '\x1b[22m\x1b[2m'),
    italic: f('\x1b[3m', '\x1b[23m'),
    underline: f('\x1b[4m', '\x1b[24m'),
    inverse: f('\x1b[7m', '\x1b[27m'),
    hidden: f('\x1b[8m', '\x1b[28m'),
    strikethrough: f('\x1b[9m', '\x1b[29m'),
    black: f('\x1b[30m', '\x1b[39m'),
    red: f('\x1b[31m', '\x1b[39m'),
    green: f('\x1b[32m', '\x1b[39m'),
    yellow: f('\x1b[33m', '\x1b[39m'),
    blue: f('\x1b[34m', '\x1b[39m'),
    magenta: f('\x1b[35m', '\x1b[39m'),
    cyan: f('\x1b[36m', '\x1b[39m'),
    white: f('\x1b[37m', '\x1b[39m'),
    gray: f('\x1b[90m', '\x1b[39m'),
    bgBlack: f('\x1b[40m', '\x1b[49m'),
    bgRed: f('\x1b[41m', '\x1b[49m'),
    bgGreen: f('\x1b[42m', '\x1b[49m'),
    bgYellow: f('\x1b[43m', '\x1b[49m'),
    bgBlue: f('\x1b[44m', '\x1b[49m'),
    bgMagenta: f('\x1b[45m', '\x1b[49m'),
    bgCyan: f('\x1b[46m', '\x1b[49m'),
    bgWhite: f('\x1b[47m', '\x1b[49m'),
    blackBright: f('\x1b[90m', '\x1b[39m'),
    redBright: f('\x1b[91m', '\x1b[39m'),
    greenBright: f('\x1b[92m', '\x1b[39m'),
    yellowBright: f('\x1b[93m', '\x1b[39m'),
    blueBright: f('\x1b[94m', '\x1b[39m'),
    magentaBright: f('\x1b[95m', '\x1b[39m'),
    cyanBright: f('\x1b[96m', '\x1b[39m'),
    whiteBright: f('\x1b[97m', '\x1b[39m'),
    bgBlackBright: f('\x1b[100m', '\x1b[49m'),
    bgRedBright: f('\x1b[101m', '\x1b[49m'),
    bgGreenBright: f('\x1b[102m', '\x1b[49m'),
    bgYellowBright: f('\x1b[103m', '\x1b[49m'),
    bgBlueBright: f('\x1b[104m', '\x1b[49m'),
    bgMagentaBright: f('\x1b[105m', '\x1b[49m'),
    bgCyanBright: f('\x1b[106m', '\x1b[49m'),
    bgWhiteBright: f('\x1b[107m', '\x1b[49m'),
    link(url: string, text: string, noUnderline?: boolean) {
      if (!isColorSupported) return text
      return `\x1b]8;;${url}\x07${noUnderline ? text : pc.underline(text)}\x1b]8;;\x07`
    },
  }
})()

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
const usdcE = '0x20C000000000000000000000b9537d11c60E8b50' as Address
const mainnetTokens = [pathUsd, usdcE] as const
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
    [usdcE]: 'USDC.e',
  }
  const symbol = knownSymbols[token] ?? metadata.symbol
  const decimals = 'decimals' in metadata ? metadata.decimals : 6
  return { balance, symbol, decimals, token }
}

function detectTerminalBg(
  timeoutMs = 100,
): Promise<{ r: number; g: number; b: number } | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw
    let buf = ''
    const cleanup = () => {
      clearTimeout(timer)
      process.stdin.removeListener('data', onData)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false)
      process.stdin.pause()
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(undefined)
    }, timeoutMs)
    const onData = (data: Buffer) => {
      buf += data.toString()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence for terminal background detection
      const match = buf.match(/\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i)
      if (!match) return
      cleanup()
      const parse = (hex: string) => Number.parseInt(hex.slice(0, 2), 16)
      resolve({ r: parse(match[1]!), g: parse(match[2]!), b: parse(match[3]!) })
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onData)
    process.stdout.write('\x1b]11;?\x07')
  })
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
