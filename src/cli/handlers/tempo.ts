import * as child from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { Errors, z } from 'incur'
import { Base64 } from 'ox'
import type { Address, Chain } from 'viem'
import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import * as Credential from '../../Credential.js'
import { tempo as tempoMethods } from '../../tempo/client/index.js'
import type { SessionCredentialPayload } from '../../tempo/session/Types.js'
import { signVoucher } from '../../tempo/session/Voucher.js'
import { createDefaultStore, createKeychain, resolveAccountName } from '../account.js'
import { type CliHandler, createHandler } from '../Handler.js'
import { pc } from '../_pc.js'

const require = createRequire(import.meta.url)
const { name } = require('../../../package.json') as { name: string }

export function tempo() {
  let _session:
    | {
        signVoucher(params: {
          channelId: string
          cumulativeAmount: bigint
          escrowContract: Address
          chainId: number
        }): Promise<string>
        source: string
      }
    | undefined

  return createHandler({
    method: 'tempo',

    async setup({ challenge, options, methodOpts }) {
      const accountName = resolveAccountName(options.account)
      const challengeRequest = challenge.request as Record<string, unknown>
      const currency = challengeRequest.currency as string | undefined

      let tokenSymbol = currency ?? ''
      let tokenDecimals = (challengeRequest.decimals as number | undefined) ?? 6
      let explorerUrl: string | undefined

      let account: ReturnType<typeof privateKeyToAccount> | undefined
      let client: ReturnType<typeof createClient> | undefined
      let useTempoCliSign = false

      const privateKey =
        process.env.MPPX_PRIVATE_KEY?.trim() ||
        (isTempoAccount(accountName) ? undefined : await createKeychain(accountName).get())

      if (!privateKey && isTempoAccount(accountName) && hasTempoCliSync()) {
        useTempoCliSign = true
        const tempoEntry = resolveTempoAccount(accountName)
        if (tempoEntry) {
          const rpcUrl = options.rpcUrl ?? process.env.RPC_URL
          client = createClient({
            chain: await resolveChain({ rpcUrl }),
            transport: http(rpcUrl),
          })
          explorerUrl = client.chain?.blockExplorers?.default?.url
          const tokenInfo = currency
            ? await fetchTokenInfo(
                client,
                currency as Address,
                tempoEntry.wallet_address as Address,
              ).catch(() => undefined)
            : undefined
          tokenSymbol = tokenInfo?.symbol ?? currency ?? ''
          tokenDecimals =
            tokenInfo?.decimals ?? (challengeRequest.decimals as number | undefined) ?? 6
        }
      } else if (!privateKey) {
        const fallback = fallbackFromTempo()
        if (fallback) {
          const fallbackKey = await createKeychain(fallback).get()
          if (fallbackKey) {
            account = privateKeyToAccount(fallbackKey as `0x${string}`)
          }
        }
        if (!account) {
          if (options.account)
            throw new Errors.IncurError({
              code: 'ACCOUNT_NOT_FOUND',
              message: `Account "${accountName}" not found.`,
              exitCode: 69,
            })
          else
            throw new Errors.IncurError({
              code: 'ACCOUNT_NOT_FOUND',
              message: 'No account found.',
              exitCode: 69,
            })
        }
      } else {
        account = privateKeyToAccount(privateKey as `0x${string}`)
      }

      if (!useTempoCliSign && account) {
        const rpcUrl = options.rpcUrl ?? process.env.RPC_URL
        client = createClient({
          chain: await resolveChain({ rpcUrl }),
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

      if (useTempoCliSign) {
        return {
          tokenSymbol,
          tokenDecimals,
          explorerUrl,
          methods: [],
          async createCredential(response: Response) {
            const wwwAuth = response.headers.get('www-authenticate')
            if (!wwwAuth) throw new Error('No WWW-Authenticate header in 402 response.')
            return tempoCliSign(wwwAuth)
          },
        }
      }

      if (!account || !client) {
        throw new Errors.IncurError({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Tempo requires a configured account.',
          exitCode: 69,
        })
      }

      const tempoOpts = parseOptions(
        z.object({
          channel: z.optional(z.coerce.string()),
          deposit: z.optional(z.union([z.string(), z.number()])),
        }),
        methodOpts,
      )

      const methods = tempoMethods({
        account,
        getClient: () => client!,
        deposit: (() => {
          if (challenge.intent !== 'session') return undefined
          const suggestedDeposit = (challenge.request as Record<string, unknown>)
            .suggestedDeposit as string | undefined
          const cliDeposit = tempoOpts.deposit !== undefined ? String(tempoOpts.deposit) : undefined
          const resolved =
            suggestedDeposit ?? cliDeposit ?? (isTestnet(client!.chain!) ? '10' : undefined)
          if (!resolved) {
            throw new Errors.IncurError({
              code: 'MISSING_DEPOSIT',
              message:
                'Session payment requires a deposit. Use -M deposit=<amount> or connect to testnet.',
              exitCode: 2,
            })
          }
          return resolved
        })(),
      })

      const credentialContext = (() => {
        if (!tempoOpts.channel) return undefined
        const channelId = tempoOpts.channel
        const saved = readChannelCumulative(channelId)
        return {
          channelId,
          ...(saved !== undefined && { cumulativeAmountRaw: saved.toString() }),
        }
      })()

      const chainId = client.chain!.id

      // Store session support for use in lifecycle hooks
      _session = {
        async signVoucher({ channelId, cumulativeAmount, escrowContract, chainId }) {
          return Credential.serialize({
            challenge,
            payload: {
              action: 'voucher',
              channelId,
              cumulativeAmount: cumulativeAmount.toString(),
              signature: await signVoucher(
                client!,
                account!,
                { channelId: channelId as `0x${string}`, cumulativeAmount },
                escrowContract,
                chainId,
              ),
            },
            source: `did:pkh:eip155:${chainId}:${account!.address}`,
          })
        },
        source: `did:pkh:eip155:${chainId}:${account.address}`,
      }

      return {
        tokenSymbol,
        tokenDecimals,
        explorerUrl,
        methods: [...methods],
        credentialContext,
      }
    },

    prepareCredentialRequest({ challenge, headers }) {
      if (challenge.intent === 'session') {
        headers.Accept = 'text/event-stream'
      }
    },

    async handleResponse(ctx) {
      if (ctx.challenge.intent !== 'session') return false
      if (!_session) return false

      const { challenge, credential, response, fetchUrl, fetchInit, info, verbose } = ctx
      const { confirmEnabled, tokenSymbol, tokenDecimals, explorerUrl, shownKeys, fmtBalance } = ctx

      const parsed = Credential.deserialize<SessionCredentialPayload>(credential)
      const challengeRequest = challenge.request as Record<string, unknown>
      const sessionMd = challengeRequest.methodDetails as
        | { escrowContract?: string; chainId?: number }
        | undefined
      const channelId = parsed.payload.channelId
      const escrowContract = sessionMd?.escrowContract as Address | undefined
      const chainId = sessionMd?.chainId ?? 0
      let cumulativeAmount =
        'cumulativeAmount' in parsed.payload && parsed.payload.cumulativeAmount
          ? BigInt(parsed.payload.cumulativeAmount)
          : 0n

      if (verbose >= 1) {
        if (parsed.payload.action === 'open') {
          const depositRaw = challengeRequest.suggestedDeposit as string | undefined
          const depositDisplay = depositRaw
            ? ` ${pc.dim(`(deposit ${depositRaw} ${tokenSymbol})`)}`
            : ''
          const prefix = confirmEnabled ? '' : '\n'
          info(
            `${prefix}${pc.dim(`Channel opened ${parsed.payload.channelId}`)}${depositDisplay}\n`,
          )
        } else {
          const prefix = confirmEnabled ? '' : '\n'
          info(`${prefix}${pc.dim(`Channel reused ${parsed.payload.channelId}`)}\n`)
        }
      }

      // Handle non-SSE session response (server returned non-streaming)
      let credentialResponse = response
      if (
        credentialResponse.ok &&
        !credentialResponse.headers.get('Content-Type')?.includes('text/event-stream')
      ) {
        if (parsed.payload.action === 'open' && 'cumulativeAmount' in parsed.payload) {
          const tickAmount = BigInt(challengeRequest.amount as string)
          cumulativeAmount = BigInt(parsed.payload.cumulativeAmount) + tickAmount

          if (escrowContract) {
            const voucherCred = await _session.signVoucher({
              channelId,
              cumulativeAmount,
              escrowContract,
              chainId,
            })
            credentialResponse = await globalThis.fetch(fetchUrl, {
              ...fetchInit,
              headers: {
                ...(fetchInit.headers as Record<string, string>),
                Accept: 'text/event-stream',
                Authorization: voucherCred,
              },
            })
          }
        }
      }

      // Print receipt from initial response headers
      const receiptHeader = credentialResponse.headers.get('Payment-Receipt')
      if (receiptHeader) {
        try {
          const receiptJson = JSON.parse(Base64.toString(receiptHeader)) as Record<string, unknown>
          if (
            typeof receiptJson.acceptedCumulative === 'string' &&
            receiptJson.acceptedCumulative
          ) {
            cumulativeAmount = BigInt(receiptJson.acceptedCumulative)
            writeChannelCumulative(channelId, cumulativeAmount)
          }
          if (verbose >= 1) {
            printReceipt(receiptJson, {
              info,
              pc,
              shownKeys,
              tokenSymbol,
              tokenDecimals,
              explorerUrl,
              fmtBalance,
              handler: this,
              prefix: '\n',
            })
          }
        } catch {}
      }

      const contentType = credentialResponse.headers.get('Content-Type') ?? ''
      if (contentType.includes('text/event-stream')) {
        await handleSseStream(credentialResponse, {
          challenge,
          channelId,
          escrowContract,
          chainId,
          cumulativeAmount,
          fetchUrl,
          fetchInit,
          session: _session,
          info,
          verbose,
          pc,
          shownKeys,
          tokenSymbol,
          tokenDecimals,
          explorerUrl,
          fmtBalance,
          handler: this,
        })
      } else {
        // Non-SSE: print body, then close channel
        const body = (await credentialResponse.text()).replace(/\n+$/, '')
        console.log(body)

        if (channelId && escrowContract && chainId) {
          if (confirmEnabled) info('\n')
          if (confirmEnabled && !(await ctx.confirm('Close channel?', true))) {
            if (verbose >= 1) info(`${pc.dim('Kept channel open.')}\n`)
          } else {
            await closeChannel({
              channelId,
              cumulativeAmount,
              escrowContract,
              chainId,
              fetchUrl,
              fetchInit,
              session: _session,
              info,
              verbose,
              pc,
              tokenSymbol,
              tokenDecimals,
              explorerUrl,
              fmtBalance,
              confirmEnabled,
            })
          }
        }
      }

      return true
    },

    formatReceiptField(key, value) {
      if (
        (key === 'reference' || key === 'txHash') &&
        typeof value === 'string' &&
        value.startsWith('0x')
      )
        return undefined // let default explorer link handling apply
    },
  })
}

// --- Session helpers ---

type Pc = typeof pc

function printReceipt(
  receiptJson: Record<string, unknown>,
  opts: {
    info: (msg: string) => void
    pc: Pc
    shownKeys: Set<string>
    tokenSymbol: string
    tokenDecimals: number
    explorerUrl?: string | undefined
    fmtBalance: (b: bigint, symbol: string, decimals?: number) => string
    handler: CliHandler
    prefix?: string | undefined
  },
) {
  const { info, pc, shownKeys, tokenSymbol, tokenDecimals, explorerUrl, fmtBalance, handler } = opts
  info(`${opts.prefix ?? ''}${pc.bold(pc.green('Payment Receipt'))}\n`)
  const rows: [string, string][] = []
  const skipRef =
    receiptJson.channelId &&
    receiptJson.reference &&
    receiptJson.channelId === receiptJson.reference
  const receiptBalanceKeys = new Set(['acceptedCumulative', 'spent'])
  for (const [key, value] of Object.entries(receiptJson)) {
    if (value === undefined || shownKeys.has(key)) continue
    if (key === 'reference' && skipRef) continue
    const formatted = handler.formatReceiptField?.(key, value)
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
  if (opts.prefix) info('\n')
}

async function handleSseStream(
  response: Response,
  opts: {
    challenge: import('../../Challenge.js').Challenge
    channelId: string
    escrowContract: Address | undefined
    chainId: number
    cumulativeAmount: bigint
    fetchUrl: string
    fetchInit: RequestInit
    session: {
      signVoucher(params: {
        channelId: string
        cumulativeAmount: bigint
        escrowContract: Address
        chainId: number
      }): Promise<string>
    }
    info: (msg: string) => void
    verbose: number
    pc: Pc
    shownKeys: Set<string>
    tokenSymbol: string
    tokenDecimals: number
    explorerUrl?: string | undefined
    fmtBalance: (b: bigint, symbol: string, decimals?: number) => string
    handler: CliHandler
  },
) {
  const {
    channelId,
    escrowContract,
    chainId,
    fetchUrl,
    fetchInit,
    session,
    info,
    verbose,
    pc,
    shownKeys,
    tokenSymbol,
    tokenDecimals,
    explorerUrl,
    fmtBalance,
    handler,
  } = opts
  let { cumulativeAmount } = opts

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

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
      if (currentEvent === 'payment-need-voucher' && channelId && escrowContract && chainId) {
        try {
          const event = JSON.parse(data) as {
            channelId: string
            requiredCumulative: string
          }
          const required = BigInt(event.requiredCumulative)
          cumulativeAmount = cumulativeAmount > required ? cumulativeAmount : required

          const voucherCred = await session.signVoucher({
            channelId,
            cumulativeAmount,
            escrowContract,
            chainId,
          })
          await globalThis.fetch(fetchUrl, {
            method: 'POST',
            headers: { Authorization: voucherCred },
          })
        } catch (e) {
          info(pc.dim(pc.yellow(` [voucher failed: ${e instanceof Error ? e.message : e}]`)))
        }
        currentEvent = ''
        continue
      }
      if (currentEvent === 'payment-receipt') {
        if (verbose >= 1) {
          try {
            const receipt = JSON.parse(data) as Record<string, unknown>
            printReceipt(receipt, {
              info,
              pc,
              shownKeys,
              tokenSymbol,
              tokenDecimals,
              explorerUrl,
              fmtBalance,
              handler,
              prefix: '\n\n',
            })
          } catch {}
        }
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

  // Close channel after SSE stream ends
  if (channelId && escrowContract && chainId) {
    await closeChannel({
      channelId,
      cumulativeAmount,
      escrowContract,
      chainId,
      fetchUrl,
      fetchInit,
      session,
      info,
      verbose,
      pc,
      tokenSymbol,
      tokenDecimals,
      explorerUrl,
      fmtBalance,
      confirmEnabled: false,
    })
  }
}

async function closeChannel(opts: {
  channelId: string
  cumulativeAmount: bigint
  escrowContract: Address
  chainId: number
  fetchUrl: string
  fetchInit: RequestInit
  session: {
    signVoucher(params: {
      channelId: string
      cumulativeAmount: bigint
      escrowContract: Address
      chainId: number
    }): Promise<string>
  }
  info: (msg: string) => void
  verbose: number
  pc: Pc
  tokenSymbol: string
  tokenDecimals: number
  explorerUrl?: string | undefined
  fmtBalance: (b: bigint, symbol: string, decimals?: number) => string
  confirmEnabled: boolean
}) {
  const {
    channelId,
    cumulativeAmount,
    escrowContract,
    chainId,
    fetchUrl,
    fetchInit,
    session,
    info,
    verbose,
    pc,
    tokenSymbol,
    tokenDecimals,
    explorerUrl,
    fmtBalance,
    confirmEnabled,
  } = opts

  const closeCred = await session.signVoucher({
    channelId,
    cumulativeAmount,
    escrowContract,
    chainId,
  })
  const closeRes = await globalThis.fetch(fetchUrl, {
    ...fetchInit,
    headers: {
      ...(fetchInit.headers as Record<string, string>),
      Authorization: closeCred,
    },
  })
  if (closeRes.ok) {
    deleteChannelState(channelId)
    if (verbose >= 1) {
      const closeReceiptHeader = closeRes.headers.get('Payment-Receipt')
      let closeTxHash: string | undefined
      if (closeReceiptHeader) {
        try {
          const r = JSON.parse(Base64.toString(closeReceiptHeader)) as Record<string, unknown>
          if (typeof r.txHash === 'string') closeTxHash = r.txHash
        } catch {}
      }
      const txInfo =
        closeTxHash && explorerUrl
          ? ` ${pc.dim(pc.link(`${explorerUrl}/tx/${closeTxHash}`, closeTxHash))}`
          : ''
      const closePrefix = confirmEnabled ? '' : '\n'
      info(
        `${closePrefix}${pc.dim('Channel closed.')} ${pc.dim(`Spent ${fmtBalance(cumulativeAmount, tokenSymbol, tokenDecimals)}.`)}${txInfo}\n`,
      )
    }
  } else {
    const closeBody = await closeRes.text().catch(() => '')
    info(`\n${pc.dim(pc.yellow('Channel close failed'))} ${pc.dim(`(${closeRes.status})`)}\n`)
    info(
      `${pc.dim(`  channelId:          ${channelId}`)}\n` +
        `${pc.dim(`  cumulativeAmount:   ${cumulativeAmount}`)}\n` +
        `${pc.dim(`  escrowContract:     ${escrowContract}`)}\n` +
        `${pc.dim(`  chainId:            ${chainId}`)}\n` +
        `${pc.dim(`  response:           ${closeBody || '(empty)'}`)}\n`,
    )
  }
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

// --- Account helpers ---

function parseOptions<const schema extends z.ZodType>(
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

function isTempoAccount(accountName: string): boolean {
  return accountName.startsWith('tempo:')
}

function tempoKeystorePath(): string {
  const platform = os.platform()
  if (platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'tempo', 'wallet', 'keys.toml')
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'tempo',
    'wallet',
    'keys.toml',
  )
}

interface TempoKeyEntry {
  wallet_type: string
  wallet_address: string
  chain_id: number
}

function readTempoKeystore(): TempoKeyEntry[] {
  try {
    const raw = fs.readFileSync(tempoKeystorePath(), 'utf-8')
    const entries: TempoKeyEntry[] = []
    let current: Partial<TempoKeyEntry> | undefined
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '[[keys]]') {
        if (current?.wallet_address) entries.push(current as TempoKeyEntry)
        current = { wallet_type: 'local', wallet_address: '', chain_id: 0 }
        continue
      }
      if (!current) continue
      const m = trimmed.match(/^(\w+)\s*=\s*"?([^"]*)"?$/)
      if (!m) continue
      const [, key, value] = m
      if (key === 'wallet_type') current.wallet_type = value!
      else if (key === 'wallet_address') current.wallet_address = value!
      else if (key === 'chain_id') current.chain_id = Number.parseInt(value!, 10)
    }
    if (current?.wallet_address) entries.push(current as TempoKeyEntry)
    return entries
  } catch {
    return []
  }
}

export function resolveTempoAccount(accountName: string): TempoKeyEntry | undefined {
  const entries = readTempoKeystore()
  if (entries.length === 0) return undefined
  const suffix = accountName.slice('tempo:'.length)
  if (suffix === 'default' || suffix === '') return entries[0]
  const idx = Number.parseInt(suffix, 10)
  if (!Number.isNaN(idx) && idx >= 0 && idx < entries.length) return entries[idx]
  return undefined
}

export { readTempoKeystore }

let _tempoCliAvailable: boolean | undefined
function hasTempoCliSync(): boolean {
  if (_tempoCliAvailable !== undefined) return _tempoCliAvailable
  try {
    child.execFileSync('which', ['tempo'], { stdio: 'ignore' })
    _tempoCliAvailable = true
  } catch {
    _tempoCliAvailable = false
  }
  return _tempoCliAvailable
}

export { hasTempoCliSync }

async function tempoCliSign(wwwAuth: string): Promise<string> {
  return new Promise((resolve, reject) => {
    child.execFile('tempo', ['mpp', 'sign', '--challenge', wwwAuth], (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || error.message
        reject(new Error(`tempo mpp sign failed: ${msg}`))
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) {
        reject(new Error('tempo mpp sign returned empty output'))
        return
      }
      resolve(trimmed)
    })
  })
}

function fallbackFromTempo(): string | undefined {
  const store = createDefaultStore()
  const currentDefault = store.get()
  if (!isTempoAccount(currentDefault)) return undefined
  if (hasTempoCliSync()) return undefined
  const platform = os.platform()
  if (platform === 'darwin') {
    try {
      const stdout = child.execFileSync('security', ['dump-keychain'], { encoding: 'utf-8' })
      const mppxAccounts: string[] = []
      for (const block of stdout.split('keychain:')) {
        const serviceMatch = block.match(/"svce"<blob>="([^"]*)"/)
        const accountMatch = block.match(/"acct"<blob>="([^"]*)"/)
        if (serviceMatch?.[1] === name && accountMatch?.[1]) mppxAccounts.push(accountMatch[1])
      }
      if (mppxAccounts.length > 0) {
        store.set(mppxAccounts[0]!)
        return mppxAccounts[0]!
      }
    } catch {}
  }
  return undefined
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

function isTestnet(chain: Chain) {
  return chain.id !== tempoMainnet.id
}

const pathUsd = '0x20c0000000000000000000000000000000000000' as Address
const usdc = '0x20C000000000000000000000b9537d11c60E8b50' as Address

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
