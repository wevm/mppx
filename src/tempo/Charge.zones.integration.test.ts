import { Challenge, Credential, Errors, Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { type Address, createClient, custom, defineChain, type Hex, http, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readContract, waitForTransactionReceipt } from 'viem/actions'
import { tempoLocalnet } from 'viem/chains'
import { Abis, Actions, Addresses, Store } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'

import type { Context } from '../../test/zones/setup.global.js'
import * as Attribution from './Attribution.js'
import * as Zone from './internal/zone.js'

/*
 * End to end against a Tempo dev node and a dev Zone (see test/zones/setup.global.ts):
 * a payer whose balance is inside the Zone pays an MPP service on Tempo.
 */

const context = JSON.parse(process.env.MPPX_ZONES_CONTEXT ?? 'null') as Context
const realm = 'zones.example.com'
const secretKey = 'zones-integration-secret-key-32-bytes'
const price = '0.05'

const l1Chain = defineChain({
  ...tempoLocalnet,
  rpcUrls: { default: { http: [context?.l1RpcUrl] } },
})
const zoneChain = defineChain({
  ...tempoLocalnet,
  id: context?.zoneChainId,
  name: 'Dev Zone',
  rpcUrls: { default: { http: [context?.zoneRpcUrl] } },
})
const l1 = createClient({ chain: l1Chain, transport: http() })

function balanceOf(client: ReturnType<typeof createClient>, address: Address) {
  return readContract(client, {
    abi: Abis.tip20,
    address: context.token,
    args: [address],
    functionName: 'balanceOf',
  })
}

/** Creates a Zone client that authenticates to the Zone RPC as `account`. */
async function zoneClientFor(account: ReturnType<typeof privateKeyToAccount>) {
  const store = Store.memory()
  const client = createClient({
    account,
    chain: zoneChain,
    transport: http(context.zoneRpcUrl, {
      async onFetchRequest(_, init) {
        const token = (await store.getItem(
          `auth:${account.address.toLowerCase()}:${zoneChain.id}`,
        )) as Hex | null
        const headers = new Headers(init.headers)
        if (token) headers.set('X-Authorization-Token', token)
        return { ...init, headers }
      },
    }),
  })
  await Actions.zone.signAuthorizationToken(client, { store, zoneId: context.zoneId })
  return client
}

/** Funds a fresh account on Tempo and deposits `amount` of it into the Zone. */
async function fundedZoneAccount(amount: bigint) {
  const account = privateKeyToAccount(generatePrivateKey())
  await l1.request({ method: 'tempo_fundAddress', params: [account.address] } as never)
  const deadline = Date.now() + 30_000
  while ((await balanceOf(l1, account.address)) < amount) {
    if (Date.now() > deadline) throw new Error('Faucet did not fund the payer.')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const hash = await Actions.zone.encryptedDeposit(
    createClient({ account, chain: l1Chain, transport: http() }),
    { amount, recipient: account.address, token: context.token, zoneId: context.zoneId } as never,
  )
  await waitForTransactionReceipt(l1, { hash })
  const zone = await zoneClientFor(account)
  while ((await balanceOf(zone, account.address)) < amount) {
    if (Date.now() > deadline + 60_000) throw new Error('Deposit did not reach the Zone.')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { account, zone }
}

function service(parameters: { recipient: Address; zones?: number[] | true }) {
  const server = Mppx_server.create({
    realm,
    secretKey,
    methods: [
      tempo_server.charge({
        chainId: l1Chain.id,
        currency: context.token,
        getClient: () => l1,
        recipient: parameters.recipient,
        zones: parameters.zones ?? [context.zoneId],
      }),
    ],
  })
  const handler = async (request: Request) => {
    const result = await server.charge({ amount: price, decimals: 6 })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(Response.json({ ok: true }))
  }
  return { handler, server }
}

describe.runIf(context)('tempo charge paid from a Zone', () => {
  let payer: Awaited<ReturnType<typeof fundedZoneAccount>>
  let otherPayer: Awaited<ReturnType<typeof fundedZoneAccount>>

  beforeAll(async () => {
    ;[payer, otherPayer] = await Promise.all([
      fundedZoneAccount(parseUnits('10', 6)),
      fundedZoneAccount(parseUnits('10', 6)),
    ])
  }, 180_000)

  test('pays an MPP service on Tempo', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    const zoneBefore = await balanceOf(payer.zone, payer.account.address)

    const client = Mppx_client.create({
      fetch: (input, init) => handler(new Request(input, init)),
      methods: [tempo_client.charge({ getClient: () => l1, zone: { client: payer.zone } })],
      polyfill: false,
    })
    const response = await client.fetch('https://zones.example.com/resource')

    expect(response.status).toBe(200)
    const receipt = Receipt.fromResponse(response)
    expect(receipt).toMatchObject({ method: 'tempo', status: 'success' })
    expect(await balanceOf(l1, recipient)).toBe(parseUnits(price, 6))
    const fee = await Actions.zone.getWithdrawalFee(payer.zone)
    expect(await balanceOf(payer.zone, payer.account.address)).toBe(
      zoneBefore - parseUnits(price, 6) - fee,
    )
  }, 120_000)

  test('settles concurrent payments from two payers', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    const responses = await Promise.all(
      [payer, otherPayer].map((p) =>
        Mppx_client.create({
          fetch: (input, init) => handler(new Request(input, init)),
          methods: [tempo_client.charge({ getClient: () => l1, zone: { client: p.zone } })],
          polyfill: false,
        }).fetch('https://zones.example.com/resource'),
      ),
    )
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    expect(await balanceOf(l1, recipient)).toBe(2n * parseUnits(price, 6))
  }, 120_000)

  test('rejects a replayed Zone credential', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    let credential: string | undefined
    const client = Mppx_client.create({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        credential ??= request.headers.get('Authorization') ?? undefined
        return handler(request)
      },
      methods: [tempo_client.charge({ getClient: () => l1, zone: { client: payer.zone } })],
      polyfill: false,
    })
    expect((await client.fetch('https://zones.example.com/resource')).status).toBe(200)

    const replay = await handler(
      new Request('https://zones.example.com/resource', {
        headers: { Authorization: credential! },
      }),
    )
    expect(replay.status).not.toBe(200)
    expect(await replay.text()).toContain('Zone withdrawal has already been used')
  }, 120_000)

  test('rejects a withdrawal bound to another challenge', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    const first = Challenge.fromResponse(await handler(new Request('https://zones.example.com')))
    const second = Challenge.fromResponse(await handler(new Request('https://zones.example.com')))

    // Pay the first challenge's memo, then present the withdrawal for the second.
    const { hash, senderTag } = await withdraw(recipient, first)
    const response = await handler(
      new Request('https://zones.example.com', {
        headers: {
          Authorization: Credential.serialize({
            challenge: second,
            payload: { hash, senderTag, type: 'zone', zoneId: context.zoneId },
          }),
        },
      }),
    )
    expect(response.status).not.toBe(200)
    expect(await response.text()).toContain('memo is not bound to this challenge')
  }, 120_000)

  test('pays a service that accepts any Zone', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient, zones: true })
    const challenge = Challenge.fromResponse(
      await handler(new Request('https://zones.example.com')),
    )
    expect(challenge.request.methodDetails).toMatchObject({ zones: true })

    const client = Mppx_client.create({
      fetch: (input, init) => handler(new Request(input, init)),
      methods: [tempo_client.charge({ getClient: () => l1, zone: { client: payer.zone } })],
      polyfill: false,
    })
    const response = await client.fetch('https://zones.example.com/resource')
    expect(response.status).toBe(200)
    expect(await balanceOf(l1, recipient)).toBe(parseUnits(price, 6))
  }, 120_000)

  test('resumes a settlement wait without withdrawing again', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    const challenge = Challenge.fromResponse(
      await handler(new Request('https://zones.example.com')),
    )
    const zoneBefore = await balanceOf(payer.zone, payer.account.address)
    // Give up on settlement at once, as a timeout would.
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: payer.zone, settlementTimeoutMs: 0 },
    })

    const error = await method
      .createCredential({ challenge: challenge as never, context: {} })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Errors.ZoneSettlementPendingError)
    const { senderTag, senderTags, zoneId } = error as Errors.ZoneSettlementPendingError
    expect(zoneId).toBe(context.zoneId)
    expect(senderTags).toEqual([senderTag])
    await Zone.waitForSettledWithdrawal(l1, { portal: Zone.portalAddress(zoneId), senderTags })

    // The retry finds the same withdrawal settled instead of paying again.
    const credential = await method.createCredential({
      challenge: challenge as never,
      context: {},
    })
    expect(Credential.deserialize(credential).payload).toMatchObject({ senderTag, type: 'zone' })
    const response = await handler(
      new Request('https://zones.example.com', { headers: { Authorization: credential } }),
    )
    expect(response.status).toBe(200)
    const fee = await Actions.zone.getWithdrawalFee(payer.zone)
    expect(await balanceOf(payer.zone, payer.account.address)).toBe(
      zoneBefore - parseUnits(price, 6) - fee,
    )
  }, 120_000)

  test('recovers a withdrawal whose send response is lost', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    const challenge = Challenge.fromResponse(
      await handler(new Request('https://zones.example.com')),
    )
    // The Zone accepts the withdrawal, but its response never reaches the client.
    const zone = createClient({
      account: payer.account,
      chain: zoneChain,
      transport: custom({
        async request(args) {
          const result = await payer.zone.request(args as never)
          if (args.method === 'eth_sendRawTransactionSync') throw new Error('response lost')
          return result
        },
      }),
    })
    const method = tempo_client.charge({ getClient: () => l1, zone: { client: zone } })

    const credential = await method.createCredential({
      challenge: challenge as never,
      context: {},
    })
    expect(Credential.deserialize(credential).payload).toMatchObject({ type: 'zone' })
    const response = await handler(
      new Request('https://zones.example.com', { headers: { Authorization: credential } }),
    )
    expect(response.status).toBe(200)
  }, 120_000)

  test('pays when the Zone RPC redacts the outbox events', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    // A production Zone RPC leaves other contracts' events, such as the outbox's, out of receipts.
    const redact = (receipt: { logs: { address: Address }[] }) => ({
      ...receipt,
      logs: receipt.logs.filter(
        (log) => log.address.toLowerCase() !== Addresses.zoneOutbox.toLowerCase(),
      ),
    })
    const zone = createClient({
      account: payer.account,
      chain: zoneChain,
      transport: custom({
        async request(args) {
          const result = await payer.zone.request(args as never)
          if (
            result &&
            (args.method === 'eth_sendRawTransactionSync' ||
              args.method === 'eth_getTransactionReceipt')
          )
            return redact(result as never)
          return result
        },
      }),
    })

    const client = Mppx_client.create({
      fetch: (input, init) => handler(new Request(input, init)),
      methods: [tempo_client.charge({ getClient: () => l1, zone: { client: zone } })],
      polyfill: false,
    })
    const response = await client.fetch('https://zones.example.com/resource')

    expect(response.status).toBe(200)
    expect(await balanceOf(l1, recipient)).toBe(parseUnits(price, 6))
  }, 120_000)

  test('retries a failed sender tag read without withdrawing again', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient })
    const challenge = Challenge.fromResponse(
      await handler(new Request('https://zones.example.com')),
    )
    const zoneBefore = await balanceOf(payer.zone, payer.account.address)
    let sends = 0
    let failReads = true
    // A redacting Zone RPC whose historical reads fail until the test lets them through.
    const zone = createClient({
      account: payer.account,
      chain: zoneChain,
      transport: custom({
        async request(args) {
          if (args.method === 'eth_sendRawTransactionSync') sends++
          if (failReads && args.method === 'eth_call') {
            const [call, block] = (args.params ?? []) as [{ to?: string }, unknown]
            // Only the reads at a past block, which derive the tag after the send.
            if (
              call?.to?.toLowerCase() === Addresses.zoneOutbox.toLowerCase() &&
              typeof block === 'string' &&
              block.startsWith('0x')
            )
              throw new Error('read failed')
          }
          const result = await payer.zone.request(args as never)
          if (
            result &&
            (args.method === 'eth_sendRawTransactionSync' ||
              args.method === 'eth_getTransactionReceipt')
          ) {
            const receipt = result as { logs: { address: string }[] }
            return {
              ...receipt,
              logs: receipt.logs.filter(
                (log) => log.address.toLowerCase() !== Addresses.zoneOutbox.toLowerCase(),
              ),
            }
          }
          return result
        },
      }),
    })
    const method = tempo_client.charge({ getClient: () => l1, zone: { client: zone } })

    await expect(
      method.createCredential({ challenge: challenge as never, context: {} }),
    ).rejects.toThrow('sender tag could not be read')
    failReads = false
    const credential = await method.createCredential({
      challenge: challenge as never,
      context: {},
    })

    expect(sends).toBe(1)
    const response = await handler(
      new Request('https://zones.example.com', { headers: { Authorization: credential } }),
    )
    expect(response.status).toBe(200)
    const fee = await Actions.zone.getWithdrawalFee(payer.zone)
    expect(await balanceOf(payer.zone, payer.account.address)).toBe(
      zoneBefore - parseUnits(price, 6) - fee,
    )
  }, 120_000)

  test('rejects a Zone the service does not accept', async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const { handler } = service({ recipient, zones: [context.zoneId + 1] })
    const challenge = Challenge.fromResponse(
      await handler(new Request('https://zones.example.com')),
    )
    const { hash, senderTag } = await withdraw(recipient, challenge)
    const response = await handler(
      new Request('https://zones.example.com', {
        headers: {
          Authorization: Credential.serialize({
            challenge,
            payload: { hash, senderTag, type: 'zone', zoneId: context.zoneId },
          }),
        },
      }),
    )
    expect(response.status).not.toBe(200)
    expect(await response.text()).toContain('Zone is not accepted for this challenge')
  }, 120_000)

  /** Withdraws to `recipient` with `challenge`'s memo and waits for it to settle on Tempo. */
  async function withdraw(recipient: Address, challenge: Challenge.Challenge) {
    const memo = Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm })
    const amount = parseUnits(price, 6)
    const fee = await Actions.zone.getWithdrawalFee(payer.zone)
    const [, call] = Actions.zone.requestWithdrawal.calls({
      amount,
      memo,
      to: recipient,
      token: context.token,
    })
    const { sendTransactionSync } = await import('viem/actions')
    const receipt = await sendTransactionSync(payer.zone, {
      calls: [
        Actions.token.approve.call({
          amount: amount + fee,
          spender: '0x1c00000000000000000000000000000000000002',
          token: context.token,
        }),
        call,
      ],
    } as never)
    const { parseEventLogs } = await import('viem')
    const [event] = parseEventLogs({
      abi: Abis.zoneOutbox,
      eventName: 'WithdrawalRequested',
      logs: receipt.logs,
    })
    const senderTag = Zone.senderTag({
      fallbackNonce: event!.args.fallbackNonce,
      sender: event!.args.sender,
      transactionHash: receipt.transactionHash,
    })
    const hash = await Zone.waitForSettlement(l1, {
      portal: Zone.portalAddress(context.zoneId),
      senderTag,
    })
    return { hash, senderTag }
  }
})
