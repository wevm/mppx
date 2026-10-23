import { erc20Abi, pad, type Hex } from 'viem'

import { config } from './config.ts'
import type { Event } from './events.ts'
import { allowance, chain, mode, walletAddress } from './wallet.ts'

const TRANSFER: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ME = pad(walletAddress).toLowerCase() as Hex
const MAX_RANGE = 100_000n // Tempo RPC eth_getLogs block-range limit
type Log = { address: string; topics: Hex[]; data: Hex; transactionHash: Hex }
const usd = (l: Log) => Number(BigInt(l.data)) / 1e6
const r6 = (n: number) => Math.round(n * 1e6) / 1e6
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6
const hex = (n: bigint): Hex => `0x${n.toString(16)}`
const outOfWallet = (l: Log) =>
  l.address.toLowerCase() === config.token &&
  l.topics[0] === TRANSFER &&
  l.topics[1]?.toLowerCase() === ME

/** USDC.e that left the wallet in one tx, including any fee-manager transfer it paid. */
async function spentInTx(hash: Hex): Promise<number> {
  const receipt = await chain.getTransactionReceipt({ hash })
  return (receipt.logs as Log[]).filter(outOfWallet).reduce((s, l) => s + usd(l), 0)
}

/** Re-derive a run's spend from the chain: every call.paid tx hash → receipt → Transfer logs from the wallet. */
export async function verifyRun(events: Event[]) {
  const paid = events.filter((e) => e.type === 'call.paid') as (Event & {
    callId: string
    chargedUsd: number
    txHashes: Hex[]
  })[]
  const fin = events.find((e) => e.type === 'run.finished') as
    | { totals?: { spentUsd: number } }
    | undefined
  const reportedUsd = fin?.totals?.spentUsd ?? paid.reduce((s, p) => s + p.chargedUsd, 0)
  const seen = new Set<string>(),
    missing: { callId: string; txHash: Hex | null; reason: string }[] = []
  const mismatches: { callId: string; reported: number; onchain: number; txHashes: Hex[] }[] = []
  let onchainUsd = 0
  await Promise.all(
    paid.map(async (p) => {
      if (!p.txHashes.length)
        missing.push({ callId: p.callId, txHash: null, reason: 'no tx hash recorded' })
      let onchain = 0
      for (const h of p.txHashes.filter((h) => !seen.has(h) && seen.add(h)))
        onchain += await spentInTx(h).catch(() => {
          missing.push({ callId: p.callId, txHash: h, reason: 'tx receipt not found' })
          return 0
        })
      onchainUsd += onchain
      if (!same(onchain, p.chargedUsd))
        mismatches.push({
          callId: p.callId,
          reported: p.chargedUsd,
          onchain: r6(onchain),
          txHashes: p.txHashes,
        })
    }),
  )
  const deltaUsd = onchainUsd - reportedUsd
  return {
    ok: same(deltaUsd, 0) && !missing.length && !mismatches.length,
    txCount: seen.size,
    payments: paid.length,
    onchainUsd: r6(onchainUsd),
    reportedUsd: r6(reportedUsd),
    deltaUsd: r6(deltaUsd),
    missing,
    mismatches,
  }
}

const balanceAt = (blockNumber: bigint) =>
  chain
    .readContract({
      address: config.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletAddress],
      blockNumber,
    })
    .catch(() => 0n)

/** First block where the wallet held any token: step back until the balance is 0, then binary search. */
async function fundingBlock(latest: bigint): Promise<bigint> {
  let hi = latest,
    lo = latest,
    back = 1000n
  while (lo > 0n && (await balanceAt(lo)) > 0n) {
    hi = lo
    lo = latest > back ? latest - back : 0n
    back *= 2n
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    if ((await balanceAt(mid)) > 0n) hi = mid
    else lo = mid
  }
  return hi
}

async function transfers(from: bigint, to: bigint, dir: 'in' | 'out'): Promise<Log[]> {
  const logs: Log[] = []
  for (let b = from; b <= to; b += MAX_RANGE)
    logs.push(
      ...((await chain.request({
        method: 'eth_getLogs',
        params: [
          {
            address: config.token,
            fromBlock: hex(b),
            toBlock: hex(b + MAX_RANGE - 1n < to ? b + MAX_RANGE - 1n : to),
            topics: dir === 'out' ? [TRANSFER, ME] : [TRANSFER, null, ME],
          },
        ],
      })) as Log[]),
    )
  return logs
}

/** Runs paid from this wallet: runs from the local demo wallet (before a migration) can't reconcile against the Tempo Wallet. */
const fromThisWallet = (evs: Event[]) => {
  const started = evs.find((e) => e.type === 'run.started') as
    | { wallet?: { address?: string } }
    | undefined
  return String(started?.wallet?.address ?? '').toLowerCase() === walletAddress.toLowerCase()
}

/**
 * Local demo wallet: every USDC.e that ever left the wallet vs. the sum of all runs vs. funded − balance.
 * Tempo Wallet: the user's own wallet has other activity, so check every payment the runs recorded against the chain,
 * and report the access key's allowance used alongside.
 */
export async function verifyWallet(allRuns: Event[][]) {
  if (mode === 'tempo-wallet') return verifyRunPayments(allRuns.filter(fromThisWallet))
  const latest = await chain.getBlockNumber()
  const start = await fundingBlock(latest)
  const [inbound, outbound, balance] = await Promise.all([
    transfers(start, latest, 'in'),
    transfers(start, latest, 'out'),
    balanceAt(latest),
  ])
  const runTx = new Set(
    allRuns
      .flat()
      .filter((e) => e.type === 'call.paid')
      .flatMap((e) => e.txHashes as string[]),
  )
  const fundedUsd = inbound.reduce((s, l) => s + usd(l), 0),
    onchainSpentUsd = outbound.reduce((s, l) => s + usd(l), 0)
  const runsReportedUsd = allRuns
    .flat()
    .filter((e) => e.type === 'call.paid')
    .reduce((s, e) => s + (e.chargedUsd as number), 0)
  const balanceUsd = Number(balance) / 1e6
  const outTx = [...new Set(outbound.map((l) => l.transactionHash))]
  return {
    ok: same(onchainSpentUsd, runsReportedUsd) && same(onchainSpentUsd, fundedUsd - balanceUsd),
    address: walletAddress,
    fundingBlock: Number(start),
    fundingTx: inbound[0]?.transactionHash ?? null,
    fundedUsd: r6(fundedUsd),
    balanceUsd: r6(balanceUsd),
    fundedMinusBalanceUsd: r6(fundedUsd - balanceUsd),
    onchainSpentUsd: r6(onchainSpentUsd),
    runsReportedUsd: r6(runsReportedUsd),
    runs: allRuns.length,
    outboundTxCount: outTx.length,
    unattributed: outTx.filter((h) => !runTx.has(h)),
    missing: [...runTx].filter((h) => !outTx.includes(h as Hex)),
  }
}

async function verifyRunPayments(allRuns: Event[][]) {
  const paid = allRuns.flat().filter((e) => e.type === 'call.paid')
  const runTx = [...new Set(paid.flatMap((e) => e.txHashes as Hex[]))]
  const missing: Hex[] = []
  const spent = await Promise.all(
    runTx.map((h) =>
      spentInTx(h).catch(() => {
        missing.push(h)
        return 0
      }),
    ),
  )
  const onchainSpentUsd = spent.reduce((s, n) => s + n, 0)
  const runsReportedUsd = paid.reduce((s, e) => s + (e.chargedUsd as number), 0)
  const a = await allowance().catch(() => null)
  return {
    ok: same(onchainSpentUsd, runsReportedUsd) && !missing.length,
    scope: 'runs' as const,
    address: walletAddress,
    onchainSpentUsd: r6(onchainSpentUsd),
    runsReportedUsd: r6(runsReportedUsd),
    runs: allRuns.length,
    outboundTxCount: runTx.length,
    unattributed: [],
    missing,
    allowance: a && {
      limitUsd: r6(a.limitUsd),
      remainingUsd: r6(a.remainingUsd),
      usedUsd: r6(a.limitUsd - a.remainingUsd),
    },
  }
}
