import { Base64 } from 'ox'
import { Challenge, Credential } from 'mppx'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import {
  type Address,
  type Hex,
  parseSignature,
  serializeCompactSignature,
  serializeSignature,
  signatureToCompactSignature,
} from 'viem'
import { waitForTransactionReceipt } from 'viem/actions'
import { Addresses } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { nodeEnv } from '~test/config.js'
import { closeChannelOnChain, deployEscrow, signOpenChannel, signTopUpChannel } from '~test/tempo/session.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'

import * as Store from '../../Store.js'
import * as ChannelStore from '../session/ChannelStore.js'
import { signVoucher } from '../session/Voucher.js'
import { sessionManager } from '../client/SessionManager.js'
import { charge, session, settle } from './Session.js'

const isLocalnet = nodeEnv === 'localnet'
const payer = accounts[2]
const delegatedSigner = accounts[4]
const recipient = accounts[0].address
const currency = asset
const secp256k1N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')

let escrowContract: Address
let saltCounter = 0

beforeAll(async () => {
  escrowContract = await deployEscrow()
  await fundAccount({ address: payer.address, token: Addresses.pathUsd })
  await fundAccount({ address: payer.address, token: currency })
})

describe.runIf(isLocalnet)('session coverage gaps', () => {
  let rawStore: Store.Store
  let store: ChannelStore.ChannelStore

  beforeEach(() => {
    rawStore = Store.memory()
    store = ChannelStore.fromStore(rawStore)
  })

  function createServer(parameters: Partial<session.Parameters> = {}) {
    return session({
      store: rawStore,
      getClient: () => client,
      account: recipient,
      currency,
      escrowContract,
      chainId: chain.id,
      ...parameters,
    } as session.Parameters)
  }

  function createServerWithStore(rawStore: Store.Store, parameters: Partial<session.Parameters> = {}) {
    return session({
      store: rawStore,
      getClient: () => client,
      account: recipient,
      currency,
      escrowContract,
      chainId: chain.id,
      ...parameters,
    } as session.Parameters)
  }

  function createHandler(parameters: Partial<session.Parameters> = {}) {
    return Mppx_server.create({
      methods: [
        tempo_server.session({
          store: rawStore,
          getClient: () => client,
          account: recipient,
          currency,
          escrowContract,
          chainId: chain.id,
          ...parameters,
        }),
      ],
      realm: 'api.example.com',
      secretKey: 'secret',
    })
  }

  function makeChallenge(parameters: { channelId: Hex; id?: string | undefined }) {
    return {
      id: parameters.id ?? 'challenge-1',
      realm: 'api.example.com',
      method: 'tempo' as const,
      intent: 'session' as const,
      request: {
        amount: '1000000',
        unitType: 'token',
        currency: currency as string,
        recipient: recipient as string,
        methodDetails: {
          escrowContract: escrowContract as string,
          chainId: chain.id,
        },
      },
    }
  }

  function makeRequest(parameters?: { decimals?: number | undefined }) {
    return {
      amount: '1000000',
      unitType: 'token',
      currency: currency as string,
      decimals: parameters?.decimals ?? 6,
      recipient: recipient as string,
      escrowContract: escrowContract as string,
      chainId: chain.id,
    }
  }

  function nextSalt(): Hex {
    saltCounter++
    return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
  }

  async function createSignedOpenTransaction(
    deposit: bigint,
    options?: { payee?: Address | undefined; authorizedSigner?: Address | undefined },
  ) {
    const { channelId, serializedTransaction } = await signOpenChannel({
      escrow: escrowContract,
      payer,
      payee: options?.payee ?? recipient,
      token: currency,
      deposit,
      salt: nextSalt(),
      ...(options?.authorizedSigner !== undefined && { authorizedSigner: options.authorizedSigner }),
    })
    return { channelId, serializedTransaction }
  }

  async function signVoucherFor(
    account: (typeof accounts)[number],
    channelId: Hex,
    cumulativeAmount: bigint,
  ) {
    return signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chain.id,
    )
  }

  function toCompactSignature(signature: Hex): Hex {
    const compact = signatureToCompactSignature(parseSignature(signature))
    return serializeCompactSignature(compact)
  }

  function mutateSignature(signature: Hex): Hex {
    const last = signature.at(-1)
    const replacement = last === '0' ? '1' : '0'
    return `${signature.slice(0, -1)}${replacement}` as Hex
  }

  function toHighSSignature(signature: Hex): Hex {
    const parsed = parseSignature(signature)
    const highS = secp256k1N - BigInt(parsed.s)
    return serializeSignature({
      r: parsed.r,
      s: `0x${highS.toString(16).padStart(64, '0')}`,
      yParity: parsed.yParity === 0 ? 1 : 0,
    })
  }

  function withFaultHooks(store: Store.Store, options: { failPutAt: number }) {
    let putCalls = 0
    return Store.from({
      get: (key) => store.get(key),
      delete: (key) => store.delete(key),
      put: async (key, value) => {
        putCalls++
        if (putCalls === options.failPutAt)
          throw new Error(`simulated store crash before persisting key ${key}`)
        await store.put(key, value)
      },
    })
  }

  function withReadDropHooks(store: Store.Store) {
    const pending = new Map<string, number>()
    const wrapped = Store.from({
      async get(key) {
        const remaining = pending.get(key)
        if (remaining !== undefined) {
          if (remaining === 0) {
            pending.delete(key)
            return null
          }
          pending.set(key, remaining - 1)
        }
        return store.get(key)
      },
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
    })
    return {
      store: wrapped,
      dropOnRead(channelId: Hex, readsBeforeDrop = 0) {
        pending.set(channelId, readsBeforeDrop)
      },
    }
  }

  describe('PR3: signature and protocol behavior', () => {
    test('accepts compact (EIP-2098) signatures for open and voucher', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const server = createServer()

      const openSignature = toCompactSignature(await signVoucherFor(payer, channelId, 1_000_000n))
      const openReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-compact', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: openSignature,
          },
        },
        request: makeRequest(),
      })
      expect(openReceipt.status).toBe('success')

      const voucherSignature = toCompactSignature(await signVoucherFor(payer, channelId, 2_000_000n))
      const voucherReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'voucher-compact', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '2000000',
            signature: voucherSignature,
          },
        },
        request: makeRequest(),
      })
      expect(voucherReceipt.status).toBe('success')
      expect(voucherReceipt.acceptedCumulative).toBe('2000000')
    })

    test('rejects malformed compact signatures', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-baseline', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      const compact = toCompactSignature(await signVoucherFor(payer, channelId, 2_000_000n))
      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'voucher-invalid-compact', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '2000000',
              signature: mutateSignature(compact),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('invalid voucher signature')
    })

    test('rejects high-s malleable signatures in session voucher path', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-for-high-s', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      const lowS = await signVoucherFor(payer, channelId, 2_000_000n)
      const highS = toHighSSignature(lowS)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'voucher-high-s', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '2000000',
              signature: highS,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('invalid voucher signature')
    })

    test('supports delegated signer end-to-end (open -> voucher -> close)', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n, {
        authorizedSigner: delegatedSigner.address,
      })
      const server = createServer()

      const openReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-delegated', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(delegatedSigner, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })
      expect(openReceipt.status).toBe('success')

      const channel = await store.getChannel(channelId)
      expect(channel?.authorizedSigner).toBe(delegatedSigner.address)

      const voucherReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'voucher-delegated', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '2000000',
            signature: await signVoucherFor(delegatedSigner, channelId, 2_000_000n),
          },
        },
        request: makeRequest(),
      })
      expect(voucherReceipt.acceptedCumulative).toBe('2000000')

      const closeReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'close-delegated', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '2000000',
            signature: await signVoucherFor(delegatedSigner, channelId, 2_000_000n),
          },
        },
        request: makeRequest(),
      })
      expect(closeReceipt.status).toBe('success')
    })

    test('HEAD voucher management request falls through to content handler', () => {
      const server = createServer()
      const response = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId:
              '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'voucher' },
        },
        input: new Request('https://api.example.com/resource', { method: 'HEAD' }),
      } as never)

      expect(response).toBeUndefined()
    })

    test('ignores unknown challenge and credential fields for forward compatibility', async () => {
      const challenge = Challenge.from({
        id: 'forward-compat',
        realm: 'api.example.com',
        method: 'tempo',
        intent: 'session',
        request: {
          amount: '1000000',
          currency: '0x20c0000000000000000000000000000000000001',
          recipient: '0x0000000000000000000000000000000000000002',
          unitType: 'token',
        },
      })
      const parsed = Challenge.deserialize(`${Challenge.serialize(challenge)}, future="v1"`)
      expect(parsed.id).toBe(challenge.id)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const handler = createHandler()
      const route = handler.session({ amount: '1', decimals: 6, unitType: 'token' })

      const first = await route(new Request('https://api.example.com/resource'))
      if (first.status !== 402) throw new Error('expected challenge')
      const issuedChallenge = Challenge.fromResponse(first.challenge)
      const signature = await signVoucherFor(payer, channelId, 1_000_000n)

      const header = Credential.serialize({
        challenge: issuedChallenge,
        payload: {
          action: 'open',
          type: 'transaction',
          channelId,
          transaction: serializedTransaction,
          cumulativeAmount: '1000000',
          signature,
        },
      })
      const encoded = header.replace(/^Payment\s+/i, '')
      const decoded = JSON.parse(Base64.toString(encoded)) as Record<string, any>
      decoded.payload.futureField = { enabled: true }
      decoded.unrecognized = 'ignored'
      const mutatedHeader = `Payment ${Base64.fromString(JSON.stringify(decoded), { url: true, pad: false })}`

      const second = await route(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: mutatedHeader },
        }),
      )
      expect(second.status).toBe(200)
    })

    test('does not return Payment-Receipt on verification errors', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const handler = createHandler()
      const route = handler.session({ amount: '1', decimals: 6, unitType: 'token' })

      const first = await route(new Request('https://api.example.com/resource'))
      if (first.status !== 402) throw new Error('expected challenge')
      const issuedChallenge = Challenge.fromResponse(first.challenge)

      const invalidCredential = Credential.serialize({
        challenge: issuedChallenge,
        payload: {
          action: 'open',
          type: 'transaction',
          channelId,
          transaction: serializedTransaction,
          cumulativeAmount: '1000000',
          signature: `0x${'ab'.repeat(65)}`,
        },
      })

      const second = await route(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: invalidCredential },
        }),
      )

      expect(second.status).toBe(402)
      expect(second.challenge.headers.get('Payment-Receipt')).toBeNull()
    })

    test('converts amount/suggestedDeposit/minVoucherDelta with decimals=18', async () => {
      const handler = createHandler()
      const route = handler.session({
        amount: '0.000000000000000001',
        suggestedDeposit: '0.000000000000000002',
        minVoucherDelta: '0.000000000000000001',
        decimals: 18,
        unitType: 'token',
      })

      const result = await route(new Request('https://api.example.com/resource'))
      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error('expected challenge')

      const challenge = Challenge.fromResponse(result.challenge)
      expect(challenge.request.amount).toBe('1')
      expect(challenge.request.suggestedDeposit).toBe('2')
      expect(challenge.request.methodDetails.minVoucherDelta).toBe('1')
    })

    test('documents idempotency semantics for duplicate open/voucher/close requests', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const server = createServer()

      const openSignature = await signVoucherFor(payer, channelId, 1_000_000n)
      const firstOpen = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-first', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: openSignature,
          },
        },
        request: makeRequest(),
      })
      expect(firstOpen.status).toBe('success')

      const secondOpen = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-duplicate', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: openSignature,
          },
        },
        request: makeRequest(),
      })
      expect(secondOpen.status).toBe('success')

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'voucher-duplicate', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: openSignature,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('strictly greater')

      const closeSignature = await signVoucherFor(payer, channelId, 1_000_000n)
      const closeReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'close-first', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '1000000',
            signature: closeSignature,
          },
        },
        request: makeRequest(),
      })
      expect(closeReceipt.status).toBe('success')

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'close-duplicate', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: closeSignature,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('already finalized')
    })
  })

  describe('PR4: session-level concurrency', () => {
    test('concurrent voucher submissions linearize to monotonic final state', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-concurrency', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      const amounts = [2_000_000n, 3_000_000n, 4_000_000n, 5_000_000n]
      const results = await Promise.allSettled(
        amounts.map(async (amount, index) =>
          server.verify({
            credential: {
              challenge: makeChallenge({ id: `voucher-concurrency-${index}`, channelId }),
              payload: {
                action: 'voucher' as const,
                channelId,
                cumulativeAmount: amount.toString(),
                signature: await signVoucherFor(payer, channelId, amount),
              },
            },
            request: makeRequest(),
          }),
        ),
      )

      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      expect(fulfilled.length).toBeGreaterThan(0)

      const channel = await store.getChannel(channelId)
      expect(channel?.highestVoucherAmount).toBe(5_000_000n)
      expect(channel?.spent).toBe(0n)
    })
  })

  describe('PR6: durability and recovery fault hooks', () => {
    test('recovers after open write crash by replaying open against on-chain state', async () => {
      const baseStore = Store.memory()
      const faultStore = withFaultHooks(baseStore, { failPutAt: 1 })
      const faultServer = createServerWithStore(faultStore)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10_000_000n)
      const openPayload = {
        action: 'open' as const,
        type: 'transaction' as const,
        channelId,
        transaction: serializedTransaction,
        cumulativeAmount: '1000000',
        signature: await signVoucherFor(payer, channelId, 1_000_000n),
      }

      await expect(
        faultServer.verify({
          credential: {
            challenge: makeChallenge({ id: 'open-crash-1', channelId }),
            payload: openPayload,
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('simulated store crash before persisting')

      const afterCrashStore = ChannelStore.fromStore(baseStore)
      expect(await afterCrashStore.getChannel(channelId)).toBeNull()

      const healthyServer = createServerWithStore(baseStore)
      const recovered = await healthyServer.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-crash-retry', channelId }),
          payload: openPayload,
        },
        request: makeRequest(),
      })

      expect(recovered.status).toBe('success')
      const channel = await afterCrashStore.getChannel(channelId)
      expect(channel?.highestVoucherAmount).toBe(1_000_000n)
      expect(channel?.deposit).toBe(10_000_000n)
    })

    test('recovers stale deposit after topUp write crash by reopening from on-chain state', async () => {
      const baseStore = Store.memory()
      const healthyServer = createServerWithStore(baseStore)
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5_000_000n)

      await healthyServer.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-before-topup-crash', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      const additionalDeposit = 2_000_000n
      const { serializedTransaction: topUpTransaction } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: additionalDeposit,
      })

      const faultStore = withFaultHooks(baseStore, { failPutAt: 1 })
      const faultServer = createServerWithStore(faultStore)

      await expect(
        faultServer.verify({
          credential: {
            challenge: makeChallenge({ id: 'topup-crash', channelId }),
            payload: {
              action: 'topUp' as const,
              type: 'transaction' as const,
              channelId,
              transaction: topUpTransaction,
              additionalDeposit: additionalDeposit.toString(),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('simulated store crash before persisting')

      const staleStore = ChannelStore.fromStore(baseStore)
      expect((await staleStore.getChannel(channelId))?.deposit).toBe(5_000_000n)

      await healthyServer.verify({
        credential: {
          challenge: makeChallenge({ id: 'reopen-after-topup-crash', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '2000000',
            signature: await signVoucherFor(payer, channelId, 2_000_000n),
          },
        },
        request: makeRequest(),
      })

      const recoveredChannel = await staleStore.getChannel(channelId)
      expect(recoveredChannel?.deposit).toBe(7_000_000n)
    })

    test('voucher rejects when channel disappears between read and update', async () => {
      const baseStore = Store.memory()
      const hooks = withReadDropHooks(baseStore)
      const server = createServerWithStore(hooks.store)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5_000_000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-racy-voucher', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      hooks.dropOnRead(channelId, 1)
      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'voucher-racy-missing', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '2000000',
              signature: await signVoucherFor(payer, channelId, 2_000_000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('channel not found')

      const persisted = await ChannelStore.fromStore(baseStore).getChannel(channelId)
      expect(persisted).not.toBeNull()
    })

    test('close still returns a receipt when channel disappears before final write', async () => {
      const baseStore = Store.memory()
      const hooks = withReadDropHooks(baseStore)
      const server = createServerWithStore(hooks.store)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5_000_000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-racy-close', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      hooks.dropOnRead(channelId, 1)
      const closeReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'close-racy-missing', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      expect(closeReceipt.status).toBe('success')
      expect(closeReceipt.spent).toBe('0')
      const persisted = await ChannelStore.fromStore(baseStore).getChannel(channelId)
      expect(persisted).toBeNull()
    })

    test('settle returns txHash even when channel disappears before settle write', async () => {
      const baseStore = Store.memory()
      const hooks = withReadDropHooks(baseStore)
      const server = createServerWithStore(hooks.store)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5_000_000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-racy-settle', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      hooks.dropOnRead(channelId, 1)
      const txHash = await settle(ChannelStore.fromStore(hooks.store), client, channelId, {
        escrowContract,
      })

      expect(txHash).toBeDefined()
      const persisted = await ChannelStore.fromStore(baseStore).getChannel(channelId)
      expect(persisted).toBeNull()
    })

    test('close rejects when channel was already finalized on-chain', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5_000_000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-before-external-close', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })

      const closeSignature = await signVoucherFor(payer, channelId, 1_000_000n)
      await closeChannelOnChain({
        escrow: escrowContract,
        payee: accounts[0],
        channelId,
        cumulativeAmount: 1_000_000n,
        signature: closeSignature,
      })

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'close-after-external-finalize', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: closeSignature,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('channel is finalized on-chain')
    })
  })

  describe('PR7: multi top-up continuity', () => {
    test('open -> topUp -> topUp -> voucher/charge -> close', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(4_000_000n)
      const server = createServer()

      const openReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-multi-topup', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signVoucherFor(payer, channelId, 1_000_000n),
          },
        },
        request: makeRequest(),
      })
      expect(openReceipt.status).toBe('success')

      await charge(store, channelId, 1_000_000n)
      await expect(charge(store, channelId, 1_000_000n)).rejects.toThrow('requested')

      const topUp1Amount = 2_000_000n
      const { serializedTransaction: topUp1 } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: topUp1Amount,
      })

      const topUp1Receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'topup-1', channelId }),
          payload: {
            action: 'topUp' as const,
            type: 'transaction' as const,
            channelId,
            transaction: topUp1,
            additionalDeposit: topUp1Amount.toString(),
          },
        },
        request: makeRequest(),
      })
      expect(topUp1Receipt.status).toBe('success')
      expect((await store.getChannel(channelId))?.deposit).toBe(6_000_000n)

      const voucher1 = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'voucher-after-topup-1', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '3000000',
            signature: await signVoucherFor(payer, channelId, 3_000_000n),
          },
        },
        request: makeRequest(),
      })
      expect(voucher1.acceptedCumulative).toBe('3000000')

      await charge(store, channelId, 2_000_000n)
      await expect(charge(store, channelId, 1_000_000n)).rejects.toThrow('requested')

      const topUp2Amount = 2_000_000n
      const { serializedTransaction: topUp2 } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: topUp2Amount,
      })

      const topUp2Receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'topup-2', channelId }),
          payload: {
            action: 'topUp' as const,
            type: 'transaction' as const,
            channelId,
            transaction: topUp2,
            additionalDeposit: topUp2Amount.toString(),
          },
        },
        request: makeRequest(),
      })
      expect(topUp2Receipt.status).toBe('success')
      expect((await store.getChannel(channelId))?.deposit).toBe(8_000_000n)

      const voucher2 = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'voucher-after-topup-2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '5000000',
            signature: await signVoucherFor(payer, channelId, 5_000_000n),
          },
        },
        request: makeRequest(),
      })
      expect(voucher2.acceptedCumulative).toBe('5000000')

      await charge(store, channelId, 2_000_000n)

      const closeReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'close-multi-topup', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '5000000',
            signature: await signVoucherFor(payer, channelId, 5_000_000n),
          },
        },
        request: makeRequest(),
      })
      expect(closeReceipt.status).toBe('success')

      const finalized = await store.getChannel(channelId)
      expect(finalized?.spent).toBe(5_000_000n)
      expect(finalized?.finalized).toBe(true)
    })
  })

  describe('PR7: e2e streaming loop', () => {
    test('open -> stream -> need-voucher -> resume -> close', async () => {
      const backingStore = Store.memory()
      const routeHandler = Mppx_server.create({
        methods: [
          tempo_server.session({
            store: backingStore,
            getClient: () => client,
            account: recipient,
            currency,
            escrowContract,
            chainId: chain.id,
            sse: true,
          }),
        ],
        realm: 'api.example.com',
        secretKey: 'secret',
      }).session({ amount: '1', decimals: 6, unitType: 'token' })

      let voucherPosts = 0
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        let action: 'open' | 'topUp' | 'voucher' | 'close' | undefined

        if (request.method === 'POST' && request.headers.has('Authorization')) {
          try {
            const credential = Credential.fromRequest<any>(request)
            action = credential.payload?.action
            if (action === 'voucher') voucherPosts++
          } catch {}
        }

        const result = await routeHandler(request)
        if (result.status === 402) return result.challenge

        if (action === 'voucher') {
          return new Response(null, { status: 200 })
        }

        if (request.headers.get('Accept')?.includes('text/event-stream')) {
          return result.withReceipt(async function* (stream) {
            await stream.charge()
            yield 'chunk-1'
            await stream.charge()
            yield 'chunk-2'
            await stream.charge()
            yield 'chunk-3'
          })
        }

        return result.withReceipt(new Response('ok'))
      }

      const manager = sessionManager({
        account: payer,
        client,
        escrowContract,
        fetch,
        maxDeposit: '3',
      })

      const chunks: string[] = []
      const stream = await manager.sse('https://api.example.com/stream')
      for await (const chunk of stream) chunks.push(chunk)

      expect(chunks).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
      expect(voucherPosts).toBeGreaterThan(0)

      const closeReceipt = await manager.close()
      expect(closeReceipt?.status).toBe('success')
      expect(closeReceipt?.spent).toBe('3000000')

      const channelId = manager.channelId
      expect(channelId).toBeTruthy()

      const persisted = await ChannelStore.fromStore(backingStore).getChannel(channelId!)
      expect(persisted?.finalized).toBe(true)
    })

    test('handles repeated exhaustion/resume cycles within one stream', async () => {
      const backingStore = Store.memory()
      const routeHandler = Mppx_server.create({
        methods: [
          tempo_server.session({
            store: backingStore,
            getClient: () => client,
            account: recipient,
            currency,
            escrowContract,
            chainId: chain.id,
            sse: true,
          }),
        ],
        realm: 'api.example.com',
        secretKey: 'secret',
      }).session({ amount: '1', decimals: 6, unitType: 'token' })

      let voucherPosts = 0
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        let action: 'open' | 'topUp' | 'voucher' | 'close' | undefined

        if (request.method === 'POST' && request.headers.has('Authorization')) {
          try {
            const credential = Credential.fromRequest<any>(request)
            action = credential.payload?.action
            if (action === 'voucher') voucherPosts++
          } catch {}
        }

        const result = await routeHandler(request)
        if (result.status === 402) return result.challenge

        if (action === 'voucher') {
          return new Response(null, { status: 200 })
        }

        if (request.headers.get('Accept')?.includes('text/event-stream')) {
          return result.withReceipt(async function* (stream) {
            await stream.charge()
            yield 'chunk-1'
            await stream.charge()
            yield 'chunk-2'
            await stream.charge()
            yield 'chunk-3'
            await stream.charge()
            yield 'chunk-4'
          })
        }

        return result.withReceipt(new Response('ok'))
      }

      const manager = sessionManager({
        account: payer,
        client,
        escrowContract,
        fetch,
        maxDeposit: '4',
      })

      const chunks: string[] = []
      const stream = await manager.sse('https://api.example.com/stream')
      for await (const chunk of stream) chunks.push(chunk)

      expect(chunks).toEqual(['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4'])
      expect(voucherPosts).toBeGreaterThanOrEqual(2)

      const closeReceipt = await manager.close()
      expect(closeReceipt?.status).toBe('success')
      expect(closeReceipt?.spent).toBe('4000000')
    })
  })
})
