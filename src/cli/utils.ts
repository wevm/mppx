import * as readline from 'node:readline'

import type { Chain } from 'viem'
import { type Address, createClient, http } from 'viem'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'

// Inlined from https://github.com/alexeyraspopov/picocolors (ISC License)
export const pc = (() => {
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

export function printRequestHeaders(
  reqUrl: string,
  init: RequestInit,
  info: (msg: string) => void,
) {
  const { pathname, host } = new URL(reqUrl)
  const method = (init.method ?? 'GET').toUpperCase()
  info(`> ${method} ${pathname} HTTP/1.1\n`)
  info(`> Host: ${host}\n`)
  for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
    info(`> ${k}: ${v}\n`)
  info('>\n')
}

export function printResponseHeaders(
  res: Response,
  opts: { include: boolean; verbose: number; silent: boolean },
) {
  if (!opts.include && opts.verbose < 2) return
  if (opts.silent) return
  const status = `HTTP/1.1 ${res.status} ${res.statusText}`
  const out = opts.verbose >= 2 ? process.stderr : process.stdout
  const prefix = opts.verbose >= 2 ? '< ' : ''
  out.write(`${prefix}${status}\n`)
  for (const [k, v] of res.headers) out.write(`${prefix}${k}: ${v}\n`)
  out.write(opts.verbose >= 2 ? '<\n' : '\n')
}

const balanceKeys = new Set(['amount', 'suggestedDeposit', 'minVoucherDelta'])

export function fmtRequestValue(
  key: string,
  value: unknown,
  ctx: { tokenSymbol: string; tokenDecimals: number; explorerUrl?: string | undefined },
): string {
  if (balanceKeys.has(key) && typeof value === 'string') {
    return `${value} ${pc.dim(`(${fmtBalance(BigInt(value), ctx.tokenSymbol, ctx.tokenDecimals)})`)}`
  }
  if (key === 'chainId' && typeof value === 'number') {
    const name = chainName({ id: value, name: '' })
    return name ? `${value} ${pc.dim(`(${name})`)}` : String(value)
  }
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value))
    return ctx.explorerUrl ? link(`${ctx.explorerUrl}/address/${value}`, value) : value
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return pc.link(value, value)
  return String(value)
}

export function decodeMemo(hex: string): string | undefined {
  try {
    const stripped = hex.replace(/^0x0*/, '')
    if (!stripped) return undefined
    const bytes = Uint8Array.from(stripped.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)))
    const decoded = new TextDecoder().decode(bytes)
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

export function fmtChallengeValue(key: string, value: unknown): string {
  if (key === 'realm' && typeof value === 'string') {
    try {
      const realmUrl = new URL(value.includes('://') ? value : `https://${value}`)
      return pc.link(realmUrl.href, value)
    } catch {}
  }
  return String(value)
}

export function link(url: string, text: string): string {
  return pc.link(url, text)
}

export function parseMethodOpts(raw: string | string[] | undefined): Record<string, string> {
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

export function isTempoAccount(accountName: string): boolean {
  return accountName.startsWith('tempo:')
}

export function prompt(message: string): Promise<string | undefined> {
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

export function confirm(prompt: string, defaultYes = false): Promise<boolean> {
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

export function fmtBalance(
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

/** Resolve RPC URL from explicit option, then MPPX_RPC_URL, then RPC_URL env vars. */
export function resolveRpcUrl(explicit?: string | undefined): string | undefined {
  return explicit ?? (process.env.MPPX_RPC_URL?.trim() || process.env.RPC_URL?.trim() || undefined)
}

export async function resolveChain(opts: { rpcUrl?: string | undefined } = {}): Promise<Chain> {
  const rpcUrl = resolveRpcUrl(opts.rpcUrl)
  if (!rpcUrl) return tempoMainnet
  const { getChainId } = await import('viem/actions')
  const chainId = await getChainId(createClient({ transport: http(rpcUrl) }))
  const allExports = Object.values(await import('viem/chains')) as unknown[]
  const candidates = allExports.filter(
    (c): c is Chain =>
      typeof c === 'object' && c !== null && 'id' in c && (c as Chain).id === chainId,
  )
  const found = candidates.find((c) => 'serializers' in c && c.serializers) ?? candidates[0]
  if (!found) throw new Error(`Unknown chain ID ${chainId} from RPC ${rpcUrl}`)
  return found
}

export function chainName(chain: { id: number; name: string }) {
  const chainNames: Record<number, string> = {
    [tempoMainnet.id]: 'mainnet',
    [tempoModerato.id]: 'testnet',
  }
  return chainNames[chain.id] ?? chain.name
}

export const pathUsd = '0x20c0000000000000000000000000000000000000' as Address
export const usdc = '0x20C000000000000000000000b9537d11c60E8b50' as Address
export const mainnetTokens = [pathUsd, usdc] as const
export const testnetTokens = [
  '0x20c0000000000000000000000000000000000000',
  '0x20c0000000000000000000000000000000000001',
  '0x20c0000000000000000000000000000000000002',
  '0x20c0000000000000000000000000000000000003',
] as const

export function isTestnet(chain: Chain) {
  return chain.id !== tempoMainnet.id
}

export async function fetchTokenInfo(
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

export async function fetchBalanceLines(
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
    transport: http(resolveRpcUrl()),
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
