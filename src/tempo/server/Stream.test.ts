import type { Address, Hex } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { rpcUrl } from '~test/tempo/prool.js'
import {
  deployEscrow,
  signOpenChannel,
  signTopUpChannel,
  topUpChannel,
} from '~test/tempo/stream.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'
import {
  ChannelClosedError,
  ChannelConflictError,
  ChannelNotFoundError,
  InsufficientBalanceError,
  InvalidSignatureError,
} from '../../Errors.js'
import type { ChannelState, ChannelStorage, SessionState } from '../stream/Storage.js'
import type { StreamReceipt } from '../stream/Types.js'
import { signVoucher } from '../stream/Voucher.js'
import { charge, settle, stream } from './Stream.js'

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

describe('stream server Method', () => {
  let storage: ChannelStorage

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  function createServer(overrides: Partial<Parameters<typeof stream>[0]> = {}) {
    return stream({
      storage,
      rpcUrl,
      recipient,
      currency,
      escrowContract,
      chainId: chain.id,
      ...overrides,
    })
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

      const ch = await storage.getChannel(channelId)
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

      await storage.updateChannel(channelId, (ch) =>
        ch ? { ...ch, activeSessionId: undefined } : null,
      )

      const ch1 = await storage.getChannel(channelId)
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
      const ch2 = await storage.getChannel(channelId)
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

      await storage.updateChannel(channelId, (ch) =>
        ch ? { ...ch, activeSessionId: undefined } : null,
      )

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
      const ch = await storage.getChannel(channelId)
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

      await storage.updateChannel(channelId, (ch) =>
        ch ? { ...ch, settledOnChain: 5000000n, activeSessionId: undefined } : null,
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

    test('rejects concurrent stream on same channel', async () => {
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

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'c2', channelId }),
            payload: {
              action: 'open' as const,
              type: 'transaction' as const,
              channelId,
              transaction: serializedTransaction,
              cumulativeAmount: '2000000',
              signature: await signTestVoucher(channelId, 2000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(ChannelConflictError)
    })

    test('allows reopen when previous session is stale', async () => {
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

      await storage.updateSession('c1', () => null)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '2000000',
            signature: await signTestVoucher(channelId, 2000000n),
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

      const ch = await storage.getChannel(channelId)
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
      const server = createServer({ minVoucherDelta: 2000000n })
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

      const ch = await storage.getChannel(channelId)
      expect(ch!.deposit).toBe(20000000n)
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

      const session = await storage.getSession('challenge-2')
      expect(session).toBeNull()

      const ch = await storage.getChannel(channelId)
      expect(ch).not.toBeNull()
      expect(ch!.highestVoucherAmount).toBe(1000000n)
      expect(ch!.activeSessionId).toBeUndefined()
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

      const ch = await storage.getChannel(channelId)
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

    test('close submits on-chain when client provided', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer({ client })
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

      const ch = await storage.getChannel(channelId)
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

      const chAfter = await storage.getChannel(channelId)
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

      const session = await charge(storage, 'c1', 1000000n)
      expect(session.spent).toBe(1000000n)
      expect(session.units).toBe(1)

      const session2 = await charge(storage, 'c1', 2000000n)
      expect(session2.spent).toBe(3000000n)
      expect(session2.units).toBe(2)
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

      await expect(charge(storage, 'c1', 2000000n)).rejects.toThrow(InsufficientBalanceError)
    })

    test('rejects charge on missing session', async () => {
      await expect(charge(storage, 'nonexistent', 100n)).rejects.toThrow(ChannelClosedError)
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

      const settleTxHash = await settle(storage, client, escrowContract, channelId)
      expect(settleTxHash).toMatch(/^0x/)

      const ch = await storage.getChannel(channelId)
      expect(ch!.settledOnChain).toBe(5000000n)
    })

    test('settle rejects when no channel found', async () => {
      const fakeChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
      await expect(settle(storage, client, escrowContract, fakeChannelId)).rejects.toThrow(
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
})

describe('monotonicity and TOCTOU (unit tests)', () => {
  const testChannelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

  function seedChannel(storage: ChannelStorage, overrides: Partial<ChannelState> = {}) {
    return storage.updateChannel(testChannelId, () => ({
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
      finalized: false,
      createdAt: new Date(),
      ...overrides,
    }))
  }

  function seedSession(
    storage: ChannelStorage,
    challengeId: string,
    overrides: Partial<SessionState> = {},
  ) {
    return storage.updateSession(challengeId, () => ({
      challengeId,
      channelId: testChannelId,
      acceptedCumulative: 5000000n,
      spent: 1000000n,
      units: 3,
      createdAt: new Date(),
      ...overrides,
    }))
  }

  test('charge does not allow acceptedCumulative to decrease', async () => {
    const storage = createMemoryStorage()
    await seedSession(storage, 's1', { acceptedCumulative: 5000000n, spent: 0n, units: 0 })

    const session = await charge(storage, 's1', 1000000n)
    expect(session.spent).toBe(1000000n)
    expect(session.acceptedCumulative).toBe(5000000n)
  })

  test('settle uses max(settledOnChain) and does not regress', async () => {
    const storage = createMemoryStorage()
    await seedChannel(storage, { settledOnChain: 3000000n })

    await storage.updateChannel(testChannelId, (current) => {
      if (!current) return null
      const settledAmount = 2000000n
      const nextSettled =
        settledAmount > current.settledOnChain ? settledAmount : current.settledOnChain
      return { ...current, settledOnChain: nextSettled }
    })

    const ch = await storage.getChannel(testChannelId)
    expect(ch!.settledOnChain).toBe(3000000n)
  })

  test('settle updates settledOnChain when higher', async () => {
    const storage = createMemoryStorage()
    await seedChannel(storage, { settledOnChain: 1000000n })

    await storage.updateChannel(testChannelId, (current) => {
      if (!current) return null
      const settledAmount = 5000000n
      const nextSettled =
        settledAmount > current.settledOnChain ? settledAmount : current.settledOnChain
      return { ...current, settledOnChain: nextSettled }
    })

    const ch = await storage.getChannel(testChannelId)
    expect(ch!.settledOnChain).toBe(5000000n)
  })

  test('acceptVoucher is monotonic — lower value does not decrease acceptedCumulative', async () => {
    const storage = createMemoryStorage()
    await seedSession(storage, 's1', { acceptedCumulative: 5000000n, spent: 2000000n, units: 3 })

    const session = await storage.updateSession('s1', (existing) => {
      if (!existing) return null
      const nextAccepted =
        3000000n > existing.acceptedCumulative ? 3000000n : existing.acceptedCumulative
      return { ...existing, acceptedCumulative: nextAccepted }
    })

    expect(session!.acceptedCumulative).toBe(5000000n)
    expect(session!.spent).toBe(2000000n)
    expect(session!.units).toBe(3)
  })

  test('session cleanup on conflict — pre-created session is removed', async () => {
    const storage = createMemoryStorage()
    await seedChannel(storage, { activeSessionId: 'existing-session' })
    await seedSession(storage, 'existing-session')

    await storage.updateSession('new-session', () => ({
      challengeId: 'new-session',
      channelId: testChannelId,
      acceptedCumulative: 2000000n,
      spent: 0n,
      units: 0,
      createdAt: new Date(),
    }))

    try {
      await storage.updateChannel(testChannelId, (existing) => {
        if (existing?.activeSessionId && existing.activeSessionId !== 'new-session') {
          throw new ChannelConflictError({ reason: 'another stream is active on this channel' })
        }
        return { ...existing!, activeSessionId: 'new-session' }
      })
      expect.unreachable()
    } catch (e) {
      await storage.updateSession('new-session', () => null)
      expect(e).toBeInstanceOf(ChannelConflictError)
    }

    const cleaned = await storage.getSession('new-session')
    expect(cleaned).toBeNull()

    const original = await storage.getSession('existing-session')
    expect(original).not.toBeNull()
  })
})

function nextSalt(): Hex {
  saltCounter++
  return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
}

function createMemoryStorage(): ChannelStorage {
  const channels = new Map<string, ChannelState>()
  const sessions = new Map<string, SessionState>()

  return {
    async getChannel(channelId) {
      return channels.get(channelId) ?? null
    },
    async getSession(challengeId) {
      return sessions.get(challengeId) ?? null
    },
    async updateChannel(channelId, fn) {
      const current = channels.get(channelId) ?? null
      const result = fn(current)
      if (result) channels.set(channelId, result)
      else channels.delete(channelId)
      return result
    },
    async updateSession(challengeId, fn) {
      const current = sessions.get(challengeId) ?? null
      const result = fn(current)
      if (result) sessions.set(challengeId, result)
      else sessions.delete(challengeId)
      return result
    },
  }
}

function makeChallenge(opts: { id?: string; channelId: Hex }) {
  return {
    id: opts.id ?? 'challenge-1',
    realm: 'test.example.com',
    method: 'tempo' as const,
    intent: 'stream' as const,
    request: {
      amount: '1000000',
      unitType: 'token',
      currency: currency as string,
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
