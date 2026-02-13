import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { type Address, createClient, type Hex } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  deployEscrow,
  signOpenChannel,
  signTopUpChannel,
  topUpChannel,
} from '~test/tempo/stream.js'
import { accounts, asset, chain, client, fundAccount, http } from '~test/tempo/viem.js'
import {
  ChannelClosedError,
  ChannelNotFoundError,
  InsufficientBalanceError,
  InvalidSignatureError,
} from '../../Errors.js'
import * as Store from '../../Store.js'
import * as ChannelStore from '../stream/ChannelStore.js'
import type { StreamReceipt } from '../stream/Types.js'
import { signVoucher } from '../stream/Voucher.js'
import { charge, session, settle } from './Session.js'

const payer = accounts[2]
const recipient = accounts[0].address
const currency = asset

let escrowContract: Address
let saltCounter = 0

beforeAll(async () => {
  escrowContract = await deployEscrow()
  await fundAccount({ address: payer.address, token: Addresses.pathUsd })
  await fundAccount({ address: payer.address, token: currency })
})

describe('session', () => {
  let rawStore: Store.Store
  let store: ChannelStore.ChannelStore

  beforeEach(() => {
    rawStore = Store.memory()
    store = ChannelStore.fromStore(rawStore)
  })

  function createServer(overrides: Partial<session.Parameters> = {}) {
    return session({
      store: rawStore,
      getClient: () => client,
      account: recipient,
      currency,
      escrowContract,
      chainId: chain.id,
      ...overrides,
    } as session.Parameters)
  }

  describe('open', () => {
    test('accepts a valid open with voucher', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.method).toBe('tempo')
      expect(receipt.status).toBe('success')
      expect(receipt.reference).toBe(channelId)

      const ch = await store.getChannel(channelId)
      expect(ch).not.toBeNull()
      expect(ch!.highestVoucherAmount).toBe(1000000n)
    })

    test('rejects open when payee mismatch', async () => {
      const wrongPayee = accounts[3].address
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n, {
        payee: wrongPayee,
      })
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'open' as const,
              type: 'transaction' as const,
              channelId,
              transaction: serializedTransaction,
              cumulativeAmount: '1000000',
              signature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('open transaction payee does not match server recipient')
    })

    test('rejects open when voucher exceeds deposit', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(500000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'open' as const,
              type: 'transaction' as const,
              channelId,
              transaction: serializedTransaction,
              cumulativeAmount: '1000000',
              signature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('channel available balance insufficient for requested amount')
    })

    test('rejects open with invalid voucher signature', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'open' as const,
              type: 'transaction' as const,
              channelId,
              transaction: serializedTransaction,
              cumulativeAmount: '1000000',
              signature: `0x${'ab'.repeat(65)}` as Hex,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('invalid voucher signature')
    })

    test('reopen existing channel with higher voucher updates state', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const ch1 = await store.getChannel(channelId)
      expect(ch1!.highestVoucherAmount).toBe(1000000n)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '5000000',
            signature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      const ch2 = await store.getChannel(channelId)
      expect(ch2!.highestVoucherAmount).toBe(5000000n)
    })

    test('reopen existing channel with same voucher keeps existing state', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      const ch = await store.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(1000000n)
    })

    test('rejects voucher below settledOnChain', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '5000000',
            signature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      await store.updateChannel(channelId, (ch) =>
        ch ? { ...ch, settledOnChain: 5000000n } : null,
      )

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'open-2', channelId }),
            payload: {
              action: 'open' as const,
              type: 'transaction' as const,
              channelId,
              transaction: serializedTransaction,
              cumulativeAmount: '3000000',
              signature: await signTestVoucher(channelId, 3000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('voucher amount is below settled on-chain amount')
    })

    test('zero signer fallback uses payer', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n, {
        authorizedSigner: '0x0000000000000000000000000000000000000000' as Address,
      })
      const server = createServer()

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
    })
  })

  describe('voucher', () => {
    async function openServerChannel(
      server: ReturnType<typeof createServer>,
      channelId: Hex,
      serializedTransaction: Hex,
    ) {
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-challenge', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })
    }

    test('accepts increasing voucher', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '2000000',
            signature: await signTestVoucher(channelId, 2000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(2000000n)
    })

    test('returns success for non-increasing voucher (idempotency)', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '500000',
            signature: await signTestVoucher(channelId, 500000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      expect((receipt as StreamReceipt).acceptedCumulative).toBe('1000000')
    })

    test('rejects voucher exceeding deposit', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-2', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '99999999',
              signature: await signTestVoucher(channelId, 99999999n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('voucher amount exceeds on-chain deposit')
    })

    test('rejects voucher below minVoucherDelta', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer({ minVoucherDelta: '2' })
      await openServerChannel(server, channelId, serializedTransaction)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-2', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '1500000',
              signature: await signTestVoucher(channelId, 1500000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('voucher delta 500000 below minimum 2000000')
    })

    test('rejects voucher on unknown channel', async () => {
      const { channelId } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(ChannelNotFoundError)
    })
  })

  describe('topUp', () => {
    async function openServerChannel(
      server: ReturnType<typeof createServer>,
      channelId: Hex,
      serializedTransaction: Hex,
    ) {
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-challenge', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })
    }

    test('accepts topUp with increased deposit', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const { serializedTransaction: topUpTx } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: 10000000n,
      })

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'topUp' as const,
            type: 'transaction' as const,
            channelId,
            transaction: topUpTx,
            additionalDeposit: '10000000',
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch!.deposit).toBe(20000000n)
    })

    test('topUp receipt preserves spent and units from prior charges', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await charge(store, channelId, 500000n)
      await charge(store, channelId, 300000n)

      const chBefore = await store.getChannel(channelId)
      expect(chBefore!.spent).toBe(800000n)
      expect(chBefore!.units).toBe(2)

      const { serializedTransaction: topUpTx } = await signTopUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: 5000000n,
      })

      const receipt = (await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-topup', channelId }),
          payload: {
            action: 'topUp' as const,
            type: 'transaction' as const,
            channelId,
            transaction: topUpTx,
            additionalDeposit: '5000000',
          },
        },
        request: makeRequest(),
      })) as StreamReceipt

      expect(receipt.status).toBe('success')
      expect(receipt.spent).toBe('800000')
      expect(receipt.units).toBe(2)

      const chAfter = await store.getChannel(channelId)
      expect(chAfter!.spent).toBe(800000n)
      expect(chAfter!.units).toBe(2)
      expect(chAfter!.deposit).toBe(15000000n)
    })

    test('rejects topUp on unknown channel', async () => {
      const { channelId } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'topUp' as const,
              type: 'transaction' as const,
              channelId,
              transaction: '0xabcdef' as Hex,
              additionalDeposit: '5000000',
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(ChannelNotFoundError)
    })
  })

  describe('close', () => {
    async function openServerChannel(
      server: ReturnType<typeof createServer>,
      channelId: Hex,
      serializedTransaction: Hex,
    ) {
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-challenge', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })
    }

    test('accepts close with final voucher >= highest', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch).not.toBeNull()
      expect(ch!.highestVoucherAmount).toBe(1000000n)
    })

    test('accepts close with voucher higher than previous highest', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '5000000',
            signature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(5000000n)
    })

    test('rejects close with voucher below highest', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '3000000',
            signature: await signTestVoucher(channelId, 3000000n),
          },
        },
        request: makeRequest(),
      })

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-3', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '2000000',
              signature: await signTestVoucher(channelId, 2000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('close voucher amount must be >= highest accepted voucher')
    })

    test('rejects close exceeding on-chain deposit', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-2', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '99999999',
              signature: await signTestVoucher(channelId, 99999999n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('close voucher amount exceeds on-chain deposit')
    })

    test('close re-reads on-chain deposit (not stale stored value)', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await topUpChannel({
        escrow: escrowContract,
        payer,
        channelId,
        token: currency,
        amount: 10000000n,
      })

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '15000000',
            signature: await signTestVoucher(channelId, 15000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
    })

    test('rejects close on unknown channel', async () => {
      const { channelId } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(ChannelNotFoundError)
    })

    test('close submits on-chain and returns txHash', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer({ getClient: () => client })
      await openServerChannel(server, channelId, serializedTransaction)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      expect((receipt as StreamReceipt).txHash).toMatch(/^0x/)

      const ch = await store.getChannel(channelId)
      expect(ch!.finalized).toBe(true)
    })

    test('close throws when client has no account', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer({
        getClient: () => createClient({ chain, transport: http() }),
      })
      await openServerChannel(server, channelId, serializedTransaction)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-2', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Cannot close channel: client has no account')
    })
  })

  describe('full lifecycle', () => {
    test('open -> voucher -> voucher -> close', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const r2 = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '3000000',
            signature: await signTestVoucher(channelId, 3000000n),
          },
        },
        request: makeRequest(),
      })
      expect(r2.status).toBe('success')

      const r3 = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c3', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '7000000',
            signature: await signTestVoucher(channelId, 7000000n),
          },
        },
        request: makeRequest(),
      })
      expect(r3.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(7000000n)

      const r4 = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c4', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '7000000',
            signature: await signTestVoucher(channelId, 7000000n),
          },
        },
        request: makeRequest(),
      })
      expect(r4.status).toBe('success')
      expect(r4.reference).toBe(channelId)

      const chAfter = await store.getChannel(channelId)
      expect(chAfter).not.toBeNull()
      expect(chAfter!.highestVoucherAmount).toBe(7000000n)
    })
  })

  describe('charge', () => {
    test('deducts balance from session', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '5000000',
            signature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      const result = await charge(store, channelId, 1000000n)
      expect(result.spent).toBe(1000000n)
      expect(result.units).toBe(1)

      const result2 = await charge(store, channelId, 2000000n)
      expect(result2.spent).toBe(3000000n)
      expect(result2.units).toBe(2)
    })

    test('rejects overdraft with InsufficientBalanceError', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      await expect(charge(store, channelId, 2000000n)).rejects.toThrow(InsufficientBalanceError)
    })

    test('rejects charge on missing channel', async () => {
      const fakeChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
      await expect(charge(store, fakeChannelId, 100n)).rejects.toThrow(ChannelClosedError)
    })
  })

  describe('settle', () => {
    test('one-shot settle updates settledOnChain', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '5000000',
            signature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      const settleTxHash = await settle(store, client, escrowContract, channelId)
      expect(settleTxHash).toMatch(/^0x/)

      const ch = await store.getChannel(channelId)
      expect(ch!.settledOnChain).toBe(5000000n)
    })

    test('settle rejects when no channel found', async () => {
      const fakeChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
      await expect(settle(store, client, escrowContract, fakeChannelId)).rejects.toThrow(
        ChannelNotFoundError,
      )
    })
  })

  describe('structured errors', () => {
    test('ChannelNotFoundError on unknown channel', async () => {
      const { channelId } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      try {
        await server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        })
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(ChannelNotFoundError)
        expect((e as ChannelNotFoundError).status).toBe(410)
      }
    })

    test('InvalidSignatureError has status 402', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      try {
        await server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'open' as const,
              type: 'transaction' as const,
              channelId,
              transaction: serializedTransaction,
              cumulativeAmount: '1000000',
              signature: `0x${'ab'.repeat(65)}` as Hex,
            },
          },
          request: makeRequest(),
        })
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidSignatureError)
        expect((e as InvalidSignatureError).status).toBe(402)
      }
    })
  })

  describe('respond', () => {
    test('returns 204 for POST with open action', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'open' },
        },
        input: new Request('http://localhost', { method: 'POST' }),
      } as any)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(204)
    })

    test('returns 204 for POST with topUp action', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'topUp' },
        },
        input: new Request('http://localhost', { method: 'POST' }),
      } as any)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(204)
    })

    test('returns 204 for POST with close action', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'close' },
        },
        input: new Request('http://localhost', { method: 'POST' }),
      } as any)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(204)
    })

    test('returns 204 for GET with close action', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'close' },
        },
        input: new Request('http://localhost', { method: 'GET' }),
      } as any)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(204)
    })

    test('returns 204 for POST with voucher action', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'voucher' },
        },
        input: new Request('http://localhost', { method: 'POST' }),
      } as any)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(204)
    })

    test('returns undefined for GET with open action (management actions only gated on POST)', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'open' },
        },
        input: new Request('http://localhost', { method: 'GET' }),
      } as any)
      expect(result).toBeUndefined()
    })

    test('returns undefined for GET with voucher action (auto-mode)', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'voucher' },
        },
        input: new Request('http://localhost', { method: 'GET' }),
      } as any)
      expect(result).toBeUndefined()
    })
  })

  describe('SSE', () => {
    test('behavior: withReceipt accepts async generator and returns Response', async () => {
      const handler = Mppx_server.create({
        methods: [
          tempo_server.session({
            account: accounts[0],
            currency: asset,
            escrowContract,
            getClient: () => client,
            stream: true,
          }),
        ],
        realm: 'api.example.com',
        secretKey: 'secret',
      })

      const result = await handler.session({
        amount: '1000',
        decimals: 6,
        unitType: 'token',
      })(new Request('https://example.com'))

      if (result.status === 200) {
        // async generator function should be accepted and return Response
        const response = result.withReceipt(async function* (_stream) {
          yield 'token'
        })
        expectTypeOf(response).toEqualTypeOf<Response>()

        // plain Response should also be accepted
        const response2 = result.withReceipt(new Response())
        expectTypeOf(response2).toEqualTypeOf<Response>()

        // async iterable should also be accepted
        const iterable: AsyncIterable<string> = (async function* () {
          yield 'token'
        })()
        const response3 = result.withReceipt(iterable)
        expectTypeOf(response3).toEqualTypeOf<Response>()

        // no-arg form should return Response
        const response4 = result.withReceipt()
        expectTypeOf(response4).toEqualTypeOf<Response>()
      }
    })

    test('behavior: non-stream session withReceipt only accepts Response', async () => {
      const handler = Mppx_server.create({
        methods: [
          tempo_server.session({
            account: accounts[0],
            currency: asset,
            escrowContract,
            getClient: () => client,
          }),
        ],
        realm: 'api.example.com',
        secretKey: 'secret',
      })

      const result = await handler.session({
        amount: '1000',
        decimals: 6,
        unitType: 'token',
      })(new Request('https://example.com'))

      if (result.status === 200) {
        const response = result.withReceipt(new Response())
        expectTypeOf(response).toEqualTypeOf<Response>()
      }
    })

    test('behavior: charge withReceipt returns Response', async () => {
      const handler = Mppx_server.create({
        methods: [tempo_server.charge({ account: accounts[0], currency: asset })],
        realm: 'api.example.com',
        secretKey: 'secret',
      })

      const result = await handler.charge({
        amount: '1000',
        decimals: 6,
      })(new Request('https://example.com'))

      if (result.status === 200) {
        const response = result.withReceipt(new Response())
        expectTypeOf(response).toEqualTypeOf<Response>()
      }
    })
  })
})

describe('monotonicity and TOCTOU (unit tests)', () => {
  const testChannelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

  function seedChannel(
    store: ChannelStore.ChannelStore,
    overrides: Partial<ChannelStore.State> = {},
  ) {
    return store.updateChannel(testChannelId, () => ({
      channelId: testChannelId,
      payer: '0x0000000000000000000000000000000000000001' as Address,
      payee: '0x0000000000000000000000000000000000000002' as Address,
      token: '0x0000000000000000000000000000000000000003' as Address,
      authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
      deposit: 10000000n,
      settledOnChain: 0n,
      highestVoucherAmount: 5000000n,
      highestVoucher: {
        channelId: testChannelId,
        cumulativeAmount: 5000000n,
        signature: '0xdeadbeef' as Hex,
      },
      spent: 0n,
      units: 0,
      finalized: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    }))
  }

  test('charge does not allow highestVoucherAmount to decrease', async () => {
    const store = ChannelStore.fromStore(Store.memory())
    await seedChannel(store, { highestVoucherAmount: 5000000n, spent: 0n, units: 0 })

    const channel = await charge(store, testChannelId, 1000000n)
    expect(channel.spent).toBe(1000000n)
    expect(channel.highestVoucherAmount).toBe(5000000n)
  })

  test('settle uses max(settledOnChain) and does not regress', async () => {
    const store = ChannelStore.fromStore(Store.memory())
    await seedChannel(store, { settledOnChain: 3000000n })

    await store.updateChannel(testChannelId, (current) => {
      if (!current) return null
      const settledAmount = 2000000n
      const nextSettled =
        settledAmount > current.settledOnChain ? settledAmount : current.settledOnChain
      return { ...current, settledOnChain: nextSettled }
    })

    const ch = await store.getChannel(testChannelId)
    expect(ch!.settledOnChain).toBe(3000000n)
  })

  test('settle updates settledOnChain when higher', async () => {
    const store = ChannelStore.fromStore(Store.memory())
    await seedChannel(store, { settledOnChain: 1000000n })

    await store.updateChannel(testChannelId, (current) => {
      if (!current) return null
      const settledAmount = 5000000n
      const nextSettled =
        settledAmount > current.settledOnChain ? settledAmount : current.settledOnChain
      return { ...current, settledOnChain: nextSettled }
    })

    const ch = await store.getChannel(testChannelId)
    expect(ch!.settledOnChain).toBe(5000000n)
  })

  test('acceptVoucher is monotonic — lower value does not decrease highestVoucherAmount', async () => {
    const store = ChannelStore.fromStore(Store.memory())
    await seedChannel(store, { highestVoucherAmount: 5000000n, spent: 2000000n, units: 3 })

    const channel = await store.updateChannel(testChannelId, (existing) => {
      if (!existing) return null
      const nextHighest =
        3000000n > existing.highestVoucherAmount ? 3000000n : existing.highestVoucherAmount
      return { ...existing, highestVoucherAmount: nextHighest }
    })

    expect(channel!.highestVoucherAmount).toBe(5000000n)
    expect(channel!.spent).toBe(2000000n)
    expect(channel!.units).toBe(3)
  })
})

function nextSalt(): Hex {
  saltCounter++
  return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
}

function makeChallenge(opts: { id?: string; channelId: Hex }) {
  return {
    id: opts.id ?? 'challenge-1',
    realm: 'test.example.com',
    method: 'tempo' as const,
    intent: 'session' as const,
    request: {
      amount: '1000000',
      unitType: 'token',
      currency: currency as string,
      decimals: 6,
      recipient: recipient as string,
      suggestedDeposit: undefined as string | undefined,
      methodDetails: {
        escrowContract: escrowContract as string,
        channelId: undefined as string | undefined,
        minVoucherDelta: undefined as string | undefined,
        chainId: chain.id as number | undefined,
        feePayer: undefined as boolean | undefined,
      },
    },
  }
}

function makeRequest() {
  return {
    amount: '1000000',
    unitType: 'token',
    currency: currency as string,
    decimals: 6,
    recipient: recipient as string,
    escrowContract: escrowContract as string,
    chainId: chain.id,
  }
}

async function signTestVoucher(channelId: Hex, amount: bigint) {
  return signVoucher(
    client,
    payer,
    { channelId, cumulativeAmount: amount },
    escrowContract,
    chain.id,
  )
}

async function createSignedOpenTransaction(
  deposit: bigint,
  opts?: { payee?: Address; authorizedSigner?: Address },
) {
  const salt = nextSalt()
  const { channelId, serializedTransaction } = await signOpenChannel({
    escrow: escrowContract,
    payer,
    payee: opts?.payee ?? recipient,
    token: currency,
    deposit,
    salt,
    ...(opts?.authorizedSigner !== undefined && { authorizedSigner: opts.authorizedSigner }),
  })
  return { channelId, serializedTransaction }
}
