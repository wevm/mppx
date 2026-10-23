import { Receipt } from 'mppx'
import { pad, type Hex } from 'viem'

import { config } from './config.ts'
import { emit, truncate, type Events, type Run, type Status } from './events.ts'
import { checkPayment, type Kind } from './policy.ts'
import {
  allowance,
  BlockedError,
  chain,
  ensureActive,
  mode,
  mppx,
  walletAddress,
  walletSnapshot,
} from './wallet.ts'

export type CallResult = {
  callId?: string
  status: Status
  httpStatus: number
  host: string
  text: string
  reason?: string
  costUsd?: number
  costIsQuote?: boolean // costUsd: charged on chain, or the quote if unknown
  location?: string
  retryAfter?: string
} // response headers async jobs need (HTTP 202 + Location / Retry-After)
/** Optional tags for the polls and result fetch of a wait_for job (see src/jobs.ts). */
export type JobTag = Pick<Events['call.started'], 'jobId' | 'poll' | 'role'>
type Log = { transactionHash: Hex; topics: Hex[]; data: Hex }

const TRANSFER: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const attributed = new Set<string>() // tx hashes already charged to some call
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A payment-auth problem (application/problem+json from paymentauth.org) in a response body, if any. */
function paymentProblem(
  text: string,
): { type: string; detail?: string; title?: string } | undefined {
  try {
    const j = JSON.parse(text)
    return typeof j?.type === 'string' && j.type.includes('paymentauth.org/problems/')
      ? j
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Sum the wallet's outgoing token transfers: from the receipt's tx, or else (local demo wallet only) from logs since
 * `fromBlock`. A Tempo Wallet is the user's own wallet, so other spending from it must never be counted as the agent's:
 * without a receipt tx, the charge stays unknown and the caller counts the quote.
 */
async function findCharges(fromBlock: bigint, txHash?: Hex) {
  if (!txHash && mode === 'tempo-wallet') return { usd: undefined, hashes: [] }
  const from = pad(walletAddress).toLowerCase() as Hex
  for (let attempt = 0; attempt < 6; attempt++, await sleep(1000)) {
    const logs: Log[] = await (
      txHash
        ? chain.getTransactionReceipt({ hash: txHash }).then((r) => r.logs as Log[])
        : (chain.request({
            method: 'eth_getLogs',
            params: [
              {
                fromBlock: `0x${fromBlock.toString(16)}`,
                toBlock: 'latest',
                topics: [TRANSFER, from],
              },
            ],
          }) as Promise<Log[]>)
    ).catch(() => [])
    const mine = logs.filter(
      (l) =>
        l.topics[0] === TRANSFER &&
        l.topics[1]?.toLowerCase() === from &&
        !attributed.has(l.transactionHash),
    )
    if (!mine.length) continue
    const hashes = [...new Set(mine.map((l) => l.transactionHash))]
    hashes.forEach((h) => attributed.add(h)) // includes any fee-manager transfer in the same tx
    return { usd: mine.reduce((s, l) => s + Number(BigInt(l.data)) / 1e6, 0), hashes }
  }
  return { usd: undefined, hashes: txHash ? [txHash] : [] }
}

export async function paidFetch(
  run: Run,
  ctx: { step: number; kind: Kind; reason: string; job?: JobTag },
  url: string,
  init: RequestInit = {},
): Promise<CallResult> {
  const callId = String(++(run.parent ?? run).calls), // shared with sub-agents: one call table per run
    t0 = Date.now(),
    method = (init.method ?? 'GET').toUpperCase()
  const host = URL.canParse(url) ? new URL(url).host : url
  const body = typeof init.body === 'string' ? init.body : ''
  emit(run, 'call.started', {
    callId,
    step: ctx.step,
    kind: ctx.kind,
    method,
    url,
    host,
    reason: ctx.reason,
    requestExcerpt: truncate(body, 1500),
    ...ctx.job,
  })
  const headers = new Headers(init.headers)
  if (body && !headers.has('content-type')) headers.set('content-type', 'application/json') // also on the paid retry
  const svc = (run.spent.byService[host] ??= { calls: 0, spentUsd: 0 })
  svc.calls++
  const finish = (
    status: Status,
    httpStatus: number,
    text: string,
    extra: Partial<CallResult> = {},
  ): CallResult => {
    emit(run, 'call.finished', {
      callId,
      status,
      httpStatus,
      latencyMs: Date.now() - t0,
      responseBytes: Buffer.byteLength(text),
      responseExcerpt: truncate(text, 1500),
    })
    return { callId, status, httpStatus, host, text, ...extra }
  }
  const jobHeaders = (h: Headers) => ({
    location: h.get('location') ?? undefined,
    retryAfter: h.get('retry-after') ?? undefined,
  })
  try {
    // A dead connection must not hang a run: give each call (including its paid retry) a hard deadline.
    const prepared = await mppx.prepareRequest(url, {
      ...init,
      method,
      headers,
      signal: init.signal ?? AbortSignal.timeout(config.callTimeoutMs),
    })
    const payment = prepared.payment
    if (!payment)
      return finish(
        prepared.response.status >= 400 ? 'failed' : 'free',
        prepared.response.status,
        await prepared.response.text(),
        jobHeaders(prepared.response.headers),
      )

    const req = payment.challenge.request as {
      amount: string
      currency: string
      decimals?: number
      recipient?: string
      methodDetails?: { chainId?: number; feePayer?: boolean }
    }
    const quotedUsd = Number(req.amount) / 10 ** (req.decimals ?? 6)
    emit(run, 'call.challenge', {
      callId,
      quotedUsd,
      currency: req.currency,
      chainId: req.methodDetails?.chainId,
      recipient: req.recipient,
      feePayer: !!req.methodDetails?.feePayer,
    })
    // The chain enforces the access key's limit anyway; checking first turns a failed payment into a clear "blocked".
    const left = (await allowance().catch(() => null))?.remainingUsd
    const policy =
      left !== undefined && quotedUsd > left + 1e-9
        ? {
            decision: 'deny' as const,
            reason: `quote $${quotedUsd} exceeds the $${left.toFixed(4)} left on this agent's Tempo Wallet allowance (pnpm run setup -- --reauthorize)`,
          }
        : checkPayment(
            {
              quotedUsd,
              chainId: req.methodDetails?.chainId,
              currency: req.currency,
              host,
              path: URL.canParse(url) ? new URL(url).pathname : '',
              kind: ctx.kind,
            },
            run.spent,
            run.budget,
          )
    emit(run, 'call.policy', { callId, ...policy })
    if (policy.decision === 'deny')
      return finish('blocked', 402, `blocked by policy: ${policy.reason}`, {
        reason: policy.reason,
      })

    await ensureActive() // Tempo Wallet mode: register the access key on chain first (once); fee-sponsored payments need it
    const fromBlock = (await chain.getBlockNumber()) - 1n
    const res = await payment.pay()
    const text = await res.text()
    const receiptHeader = res.headers.get('payment-receipt')
    // Rejected, not settled: the server refused the payment credential (still 402, or a verification-failed problem)
    // and sent no receipt. Nothing was charged, so count $0 and no payment.
    const problem = paymentProblem(text)
    if (!receiptHeader && (res.status === 402 || problem?.type.endsWith('/verification-failed'))) {
      const why = (
        problem?.detail ??
        problem?.title ??
        `HTTP ${res.status} with no payment receipt`
      ).split('\n')[0]
      return finish('failed', res.status, text, { reason: `payment not accepted: ${why}` })
    }
    const ref = receiptHeader ? Receipt.deserialize(receiptHeader).reference : undefined
    const charge = await findCharges(
      fromBlock,
      /^0x[0-9a-fA-F]{64}$/.test(ref ?? '') ? (ref as Hex) : undefined,
    )
    const chargedUsd = charge.usd ?? quotedUsd // accepted but no on-chain evidence yet: count the quote, to be safe
    Object.assign(run.spent, {
      totalUsd: run.spent.totalUsd + chargedUsd,
      payments: run.spent.payments + 1,
    })
    run.spent[ctx.kind] += chargedUsd
    svc.spentUsd += chargedUsd
    emit(run, 'call.paid', {
      callId,
      chargedUsd,
      txHashes: charge.hashes,
      explorerUrls: charge.hashes.map((h) => `${config.explorer}/tx/${h}`),
    })
    emit(run, 'wallet.balance', {
      ...(await walletSnapshot()),
      spentUsd: run.spent.totalUsd,
      spentInferenceUsd: run.spent.llm,
      spentToolsUsd: run.spent.http,
      payments: run.spent.payments,
    })
    return finish(res.ok ? 'paid' : 'paid_failed', res.status, text, {
      costUsd: chargedUsd,
      costIsQuote: charge.usd === undefined,
      ...jobHeaders(res.headers),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return finish(err instanceof BlockedError ? 'blocked' : 'failed', 0, msg, { reason: msg })
  }
}

export { forLlm } from './events.ts' // moved to events.ts so src/jobs.ts can use it without loading the wallet
