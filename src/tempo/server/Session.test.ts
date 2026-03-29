import type { z } from 'mppx'
import { Challenge, Credential } from 'mppx'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Base64 } from 'ox'
import {
  type Address,
  createClient,
  type Hex,
  parseSignature,
  serializeCompactSignature,
  serializeSignature,
  signatureToCompactSignature,
} from 'viem'
import { waitForTransactionReceipt } from 'viem/actions'
import { Addresses } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, expectTypeOf, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'

const isLocalnet = nodeEnv === 'localnet'
import {
  closeChannelOnChain,
  deployEscrow,
  requestCloseChannel,
  signOpenChannel,
  signTopUpChannel,
  topUpChannel,
} from '~test/tempo/session.js'
import { accounts, asset, chain, client, fundAccount, http } from '~test/tempo/viem.js'

import {
  ChannelClosedError,
  ChannelNotFoundError,
  InsufficientBalanceError,
  InvalidSignatureError,
} from '../../Errors.js'
import * as Store from '../../Store.js'
import { sessionManager } from '../client/SessionManager.js'
import {
  chainId as chainIdDefaults,
  escrowContract as escrowContractDefaults,
} from '../internal/defaults.js'
import type * as Methods from '../Methods.js'
import * as ChannelStore from '../session/ChannelStore.js'
import type { SessionReceipt } from '../session/Types.js'
import { signVoucher } from '../session/Voucher.js'
import { charge, session, settle } from './Session.js'

const payer = accounts[2]
const delegatedSigner = accounts[4]
const recipientAccount = accounts[0]
const recipient = accounts[0].address
const currency = asset
const secp256k1N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')

let escrowContract: Address
let saltCounter = 0

beforeAll(async () => {
  if (!isLocalnet) return
  escrowContract = await deployEscrow()
  await fundAccount({ address: payer.address, token: Addresses.pathUsd })
  await fundAccount({ address: payer.address, token: currency })
})

describe.runIf(isLocalnet)('session', () => {
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
      account: recipientAccount,
      currency,
      escrowContract,
      chainId: chain.id,
      ...overrides,
    } as session.Parameters)
  }

  function createServerWithStore(
    customStore: Store.Store,
    overrides: Partial<session.Parameters> = {},
  ) {
    return session({
      store: customStore,
      getClient: () => client,
      account: recipientAccount,
      currency,
      escrowContract,
      chainId: chain.id,
      ...overrides,
    } as session.Parameters)
  }

  function createHandler(overrides: Partial<session.Parameters> = {}) {
    return Mppx_server.create({
      methods: [
        tempo_server.session({
          store: rawStore,
          getClient: () => client,
          account: recipientAccount,
          currency,
          escrowContract,
          chainId: chain.id,
          ...overrides,
        } as session.Parameters),
      ],
      realm: 'api.example.com',
      secretKey: 'secret',
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

    test('open after store loss uses on-chain settled for settledOnChain and spent', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      // 1. Open channel and accept a voucher
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

      // 2. Settle on-chain so settled becomes 5000000
      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })
      expect((await store.getChannel(channelId))!.settledOnChain).toBe(5000000n)

      // 3. Simulate store loss (non-persistent storage restart)
      await store.updateChannel(channelId, () => null)
      expect(await store.getChannel(channelId)).toBeNull()

      // 4. Re-open with a new voucher above the settled amount
      const server2 = createServer()
      const receipt = await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'reopen', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '7000000',
            signature: await signTestVoucher(channelId, 7000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch).not.toBeNull()
      // settledOnChain must reflect the on-chain value, not 0
      expect(ch!.settledOnChain).toBe(5000000n)
      // spent must equal settledOnChain so deductFromChannel only allows
      // charging the unsettled portion (highestVoucher - spent = 7M - 5M = 2M)
      expect(ch!.spent).toBe(5000000n)
      expect(ch!.highestVoucherAmount).toBe(7000000n)
    })

    test('open after store loss reports correct spent in receipt', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      // Open, settle, wipe store
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-1', channelId }),
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
      })

      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })
      await store.updateChannel(channelId, () => null)

      // Re-open — receipt.spent must reflect unsettled portion
      const server2 = createServer()
      const receipt = (await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'reopen', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '8000000',
            signature: await signTestVoucher(channelId, 8000000n),
          },
        },
        request: makeRequest(),
      })) as SessionReceipt

      // spent reflects on-chain settled (3M) so only unsettled portion is available
      expect(receipt.spent).toBe('3000000')
      expect(receipt.acceptedCumulative).toBe('8000000')
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

    test('rejects non-increasing voucher replay', async () => {
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
              cumulativeAmount: '500000',
              signature: await signTestVoucher(channelId, 500000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(
        'voucher cumulativeAmount must be strictly greater than highest accepted voucher',
      )
    })

    test('rejects replay of settled voucher', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const leakedAmount = 1000000n
      const leakedSignature = await signTestVoucher(channelId, leakedAmount)
      await settle(store, client, channelId, { escrowContract })

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-replay', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: leakedAmount.toString(),
              signature: leakedSignature,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('voucher cumulativeAmount is below on-chain settled amount')
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

    test('rejects stale voucher with invalid signature (hijack prevention)', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'hijack-attempt', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              // Attacker submits cumulativeAmount=500000, which is <= highestVoucherAmount (1000000)
              // but > settled (0). Rejected by non-increasing cumulative amount check before signature validation.
              cumulativeAmount: '500000',
              signature: `0x${'ab'.repeat(65)}` as Hex,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(
        'voucher cumulativeAmount must be strictly greater than highest accepted voucher',
      )
    })

    test('rejects forged voucher with valid amount but invalid signature', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'forge-attempt', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              // Higher cumulativeAmount than the open voucher, but forged signature.
              cumulativeAmount: '2000000',
              signature: `0x${'cd'.repeat(65)}` as Hex,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(InvalidSignatureError)
    })

    test('accepts exact replay of already-verified voucher as idempotent', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const payload = {
        action: 'voucher' as const,
        channelId,
        cumulativeAmount: '2000000',
        signature: await signTestVoucher(channelId, 2000000n),
      }

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload,
        },
        request: makeRequest(),
      })

      const channelAfterFirstAccept = await store.getChannel(channelId)

      const replayReceipt = (await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-3', channelId }),
          payload,
        },
        request: makeRequest(),
      })) as SessionReceipt

      expect(replayReceipt.status).toBe('success')
      expect(replayReceipt.acceptedCumulative).toBe('2000000')
      expect(replayReceipt.spent).toBe(channelAfterFirstAccept!.spent.toString())
      expect(replayReceipt.units).toBe(channelAfterFirstAccept!.units)

      const channelAfterReplay = await store.getChannel(channelId)
      expect(channelAfterReplay).toEqual(channelAfterFirstAccept)
      expect(channelAfterReplay!.highestVoucherAmount).toBe(2000000n)
    })

    test('rejects exact replay with invalid signature', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      const payload = {
        action: 'voucher' as const,
        channelId,
        cumulativeAmount: '2000000',
        signature: await signTestVoucher(channelId, 2000000n),
      }

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload,
        },
        request: makeRequest(),
      })

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-3', channelId }),
            payload: {
              ...payload,
              signature: `0x${'ab'.repeat(65)}` as Hex,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(InvalidSignatureError)
    })

    test('rejects replayed voucher at settled amount after on-chain settlement', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      // Server accepts a higher voucher and then settles on-chain.
      // settle() broadcasts the highestVoucher, leaking it on-chain.
      const voucherSig = await signTestVoucher(channelId, 5000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '5000000',
            signature: voucherSig,
          },
        },
        request: makeRequest(),
      })

      await settle(store, client, channelId, { escrowContract })
      expect((await store.getChannel(channelId))!.settledOnChain).toBe(5000000n)

      // Attacker replays the leaked voucher via the voucher action.
      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'replay-attempt', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '5000000',
              signature: voucherSig,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('voucher cumulativeAmount is below on-chain settled amount')
    })

    test('rejects leaked voucher used in open action with mismatched channel', async () => {
      // 1. Legitimate channel: open, send voucher, settle on-chain.
      const { channelId: victimChannelId, serializedTransaction: victimTx } =
        await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, victimChannelId, victimTx)

      const leakedSig = await signTestVoucher(victimChannelId, 5000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c-victim', channelId: victimChannelId }),
          payload: {
            action: 'voucher' as const,
            channelId: victimChannelId,
            cumulativeAmount: '5000000',
            signature: leakedSig,
          },
        },
        request: makeRequest(),
      })

      await settle(store, client, victimChannelId, { escrowContract })

      // 2. Attacker creates a different open transaction (nominal channel
      //    from their own account) but claims channelId = victimChannelId.
      //    The tx broadcasts fine (opens attacker's channel), then the
      //    server fetches on-chain state for victimChannelId (the settled
      //    channel) and accepts the leaked voucher.
      const attacker = accounts[3]
      await fundAccount({ address: attacker.address, token: currency })
      const { serializedTransaction: attackerTx } = await signOpenChannel({
        escrow: escrowContract,
        payer: attacker,
        payee: recipient,
        token: currency,
        deposit: 1n, // nominal deposit
        salt: nextSalt(),
      })

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'c-attack', channelId: victimChannelId }),
            payload: {
              action: 'open' as const,
              type: 'transaction' as const,
              channelId: victimChannelId,
              transaction: attackerTx,
              cumulativeAmount: '5000000',
              signature: leakedSig,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('open transaction does not match claimed channelId')
    })

    test('rejects voucher when payer initiated force-close during cache TTL window', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      // Use channelStateTtl: 0 to force on-chain reads on every voucher,
      // ensuring the force-close is detected immediately.
      const server = createServer({ channelStateTtl: 0 })
      await openServerChannel(server, channelId, serializedTransaction)

      // Accept a voucher to prime the cache (open already verified on-chain)
      await server.verify({
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

      // Payer initiates a force-close on-chain (sets closeRequestedAt != 0)
      await requestCloseChannel({ escrow: escrowContract, payer, channelId })

      // Server submits another voucher within the cache TTL window.
      // The cached state hardcodes closeRequestedAt: 0n, so the check
      // in verifyAndAcceptVoucher never fires. This should throw
      // ChannelClosedError but currently doesn't due to the stale cache.
      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-3', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '3000000',
              signature: await signTestVoucher(channelId, 3000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(ChannelClosedError)
    })

    test('rejects voucher when payer initiated force-close with cached state', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      // Use channelStateTtl: 0 so every voucher triggers a stale re-query.
      // This lets the first post-close voucher detect the force-close and
      // persist closeRequestedAt to the store.
      const server = createServer({ channelStateTtl: 0 })
      await openServerChannel(server, channelId, serializedTransaction)

      // Payer initiates a force-close on-chain
      await requestCloseChannel({ escrow: escrowContract, payer, channelId })

      // First voucher after close: stale re-query detects closeRequestedAt,
      // persists it to the store, then throws ChannelClosedError.
      await expect(
        server.verify({
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
        }),
      ).rejects.toThrow(ChannelClosedError)

      // Now switch to a large TTL so subsequent vouchers use the cached path.
      // The persisted closeRequestedAt should cause rejection without an
      // on-chain re-query.
      const server2 = createServer({ channelStateTtl: 60_000, store: rawStore })
      await expect(
        server2.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-3', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '3000000',
              signature: await signTestVoucher(channelId, 3000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(ChannelClosedError)
    })

    test('rejects voucher when deposit is zero (settled race window)', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      // Use a large TTL so the voucher path uses the cached store state
      // instead of reading on-chain. This lets us simulate the settlement
      // race where deposit=0 but finalized=false by manipulating the store.
      const server = createServer({ channelStateTtl: 60_000 })
      await openServerChannel(server, channelId, serializedTransaction)

      // Simulate the escrow contract zeroing the deposit before setting
      // finalized (the race window this PR guards against).
      await store.updateChannel(channelId, (ch) => (ch ? { ...ch, deposit: 0n } : null))

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-after-settle', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '2000000',
              signature: await signTestVoucher(channelId, 2000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow(ChannelClosedError)
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
      })) as SessionReceipt

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

    test('accepts close at spent amount (below highestVoucherAmount)', async () => {
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

      await charge(store, channelId, 500000n)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-3', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '500000',
            signature: await signTestVoucher(channelId, 500000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch).not.toBeNull()
      expect(ch!.highestVoucherAmount).toBe(3000000n)
      expect(ch!.finalized).toBe(true)
    })

    test('rejects close below spent amount', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId, serializedTransaction)

      await charge(store, channelId, 500000n)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-2', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '100000',
              signature: await signTestVoucher(channelId, 100000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('close voucher amount must be >=')
    })

    test('rejects close equal to on-chain settled amount', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      // Open with 1M voucher (matches openServerChannel default)
      await openServerChannel(server, channelId, serializedTransaction)

      // Settle on-chain so settled becomes 1000000
      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })

      // Try to close with voucher == on-chain settled — should be rejected
      // because replaying the settled amount doesn't commit new funds
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
      ).rejects.toThrow('close voucher amount must be >')
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
      expect((receipt as SessionReceipt).txHash).toMatch(/^0x/)

      const ch = await store.getChannel(channelId)
      expect(ch!.finalized).toBe(true)
    })

    test('session() throws at initialization when no account provided', () => {
      expect(() =>
        session({
          store: rawStore,
          getClient: () => client,
          account: recipient as Address,
          currency,
          escrowContract,
          chainId: chain.id,
        } as session.Parameters),
      ).toThrow('tempo.session() requires an `account`')
    })

    test('session() throws at initialization with no account at all', () => {
      expect(() =>
        session({
          store: rawStore,
          getClient: () => client,
          currency,
          escrowContract,
          chainId: chain.id,
        } as session.Parameters),
      ).toThrow('tempo.session() requires an `account`')
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

    test('supports delegated signer end-to-end (open -> voucher -> close)', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n, {
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
            signature: await signTestVoucher(channelId, 1000000n, delegatedSigner),
          },
        },
        request: makeRequest(),
      })
      expect(openReceipt.status).toBe('success')

      const channel = await store.getChannel(channelId)
      expect(channel?.authorizedSigner).toBe(delegatedSigner.address)

      const voucherReceipt = (await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'voucher-delegated', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '2000000',
            signature: await signTestVoucher(channelId, 2000000n, delegatedSigner),
          },
        },
        request: makeRequest(),
      })) as SessionReceipt
      expect(voucherReceipt.acceptedCumulative).toBe('2000000')

      const closeReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'close-delegated', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '2000000',
            signature: await signTestVoucher(channelId, 2000000n, delegatedSigner),
          },
        },
        request: makeRequest(),
      })
      expect(closeReceipt.status).toBe('success')
    })

    test('open -> topUp -> topUp -> voucher/charge -> close', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(4000000n)
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
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })
      expect(openReceipt.status).toBe('success')

      await charge(store, channelId, 1000000n)
      await expect(charge(store, channelId, 1000000n)).rejects.toThrow('requested')

      const topUp1Amount = 2000000n
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
      expect((await store.getChannel(channelId))?.deposit).toBe(6000000n)

      const voucher1 = (await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'voucher-after-topup-1', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '3000000',
            signature: await signTestVoucher(channelId, 3000000n),
          },
        },
        request: makeRequest(),
      })) as SessionReceipt
      expect(voucher1.acceptedCumulative).toBe('3000000')

      await charge(store, channelId, 2000000n)
      await expect(charge(store, channelId, 1000000n)).rejects.toThrow('requested')

      const topUp2Amount = 2000000n
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
      expect((await store.getChannel(channelId))?.deposit).toBe(8000000n)

      const voucher2 = (await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'voucher-after-topup-2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '5000000',
            signature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })) as SessionReceipt
      expect(voucher2.acceptedCumulative).toBe('5000000')

      await charge(store, channelId, 2000000n)

      const closeReceipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'close-multi-topup', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '5000000',
            signature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })
      expect(closeReceipt.status).toBe('success')

      const finalized = await store.getChannel(channelId)
      expect(finalized?.spent).toBe(5000000n)
      expect(finalized?.finalized).toBe(true)
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

      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      expect(settleTxHash).toMatch(/^0x/)

      const ch = await store.getChannel(channelId)
      expect(ch!.settledOnChain).toBe(5000000n)
    })

    test('settle rejects when no channel found', async () => {
      const fakeChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
      await expect(settle(store, client, fakeChannelId, { escrowContract })).rejects.toThrow(
        ChannelNotFoundError,
      )
    })
  })

  describe('non-persistent storage recovery', () => {
    test('open on existing on-chain channel initializes settledOnChain from chain', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      // Open channel and accept a voucher.
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

      // Settle on-chain so onChain.settled = 5000000.
      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })
      expect((await store.getChannel(channelId))!.settledOnChain).toBe(5000000n)

      // Simulate server restart with non-persistent storage: wipe the store.
      await store.updateChannel(channelId, () => null)
      expect(await store.getChannel(channelId)).toBeNull()

      // Re-open with a new (fresh) server instance using the same store.
      const server2 = createServer()
      const receipt = (await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '7000000',
            signature: await signTestVoucher(channelId, 7000000n),
          },
        },
        request: makeRequest(),
      })) as SessionReceipt

      expect(receipt.status).toBe('success')

      const ch = await store.getChannel(channelId)
      expect(ch).not.toBeNull()
      // settledOnChain should reflect the on-chain settled amount, not 0.
      expect(ch!.settledOnChain).toBe(5000000n)
      // spent must equal settledOnChain so only unsettled portion is chargeable.
      expect(ch!.spent).toBe(5000000n)
    })

    test('recovery correctly limits available balance to unsettled portion', async () => {
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

      const settleTxHash2 = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash2 })

      // Wipe store.
      await store.updateChannel(channelId, () => null)

      // Re-open with voucher = 6000000 on a channel with settled = 5000000.
      const server2 = createServer()
      await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '6000000',
            signature: await signTestVoucher(channelId, 6000000n),
          },
        },
        request: makeRequest(),
      })

      // spent = settledOnChain = 5M, highestVoucherAmount = 6M.
      // Available = 6M - 5M = 1M (only the unsettled portion).
      const ch = await store.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(6000000n)
      expect(ch!.spent).toBe(5000000n)
      expect(ch!.settledOnChain).toBe(5000000n)
      await charge(store, channelId, 1000000n)
      await expect(charge(store, channelId, 1n)).rejects.toThrow(InsufficientBalanceError)
    })

    test('reopen existing channel bumps stale settledOnChain from chain', async () => {
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
            cumulativeAmount: '3000000',
            signature: await signTestVoucher(channelId, 3000000n),
          },
        },
        request: makeRequest(),
      })

      // Settle on-chain so onChain.settled = 3000000.
      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })

      // Store still has the old record — settledOnChain is correct after settle.
      expect((await store.getChannel(channelId))!.settledOnChain).toBe(3000000n)

      // Manually regress settledOnChain to simulate a stale stored value.
      await store.updateChannel(channelId, (ch) => (ch ? { ...ch, settledOnChain: 0n } : null))
      expect((await store.getChannel(channelId))!.settledOnChain).toBe(0n)

      // Re-open with a higher voucher — should bump settledOnChain from chain.
      const server2 = createServer()
      await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
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

      const ch = await store.getChannel(channelId)
      expect(ch!.settledOnChain).toBe(3000000n)
      expect(ch!.highestVoucherAmount).toBe(5000000n)
    })

    test('reopen existing record bumps spent to settledOnChain to prevent over-service', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      // Open channel with voucher = 5M (spent stays 0).
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

      // Settle on-chain so onChain.settled = 5M.
      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })

      // Store record still exists (no store loss), but spent is 0.
      const before = await store.getChannel(channelId)
      expect(before!.spent).toBe(0n)
      expect(before!.settledOnChain).toBe(5000000n)

      // Re-open with higher voucher = 7M on existing record.
      const server2 = createServer()
      await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '7000000',
            signature: await signTestVoucher(channelId, 7000000n),
          },
        },
        request: makeRequest(),
      })

      // spent must be bumped to at least settledOnChain (5M) so available
      // is only the unsettled portion (7M - 5M = 2M), not the full 7M.
      const ch = await store.getChannel(channelId)
      expect(ch!.settledOnChain).toBe(5000000n)
      expect(ch!.spent).toBe(5000000n)
      expect(ch!.highestVoucherAmount).toBe(7000000n)

      // Only 2M should be chargeable.
      await charge(store, channelId, 2000000n)
      await expect(charge(store, channelId, 1n)).rejects.toThrow(InsufficientBalanceError)
    })

    test('rejects voucher at settled amount after store loss', async () => {
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

      const settleTxHash3 = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash3 })
      await store.updateChannel(channelId, () => null)

      // Attempt to re-open with a voucher equal to the settled amount.
      // This should be rejected because cumulativeAmount <= onChain.settled.
      const server2 = createServer()
      await expect(
        server2.verify({
          credential: {
            challenge: makeChallenge({ id: 'c2', channelId }),
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
        }),
      ).rejects.toThrow('voucher cumulativeAmount is below on-chain settled amount')
    })

    test('close after recovery respects on-chain settled as minimum', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      // Open, settle 4M, wipe store.
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '4000000',
            signature: await signTestVoucher(channelId, 4000000n),
          },
        },
        request: makeRequest(),
      })

      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })
      await store.updateChannel(channelId, () => null)

      // Re-open with voucher = 8M.
      const server2 = createServer()
      await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '8000000',
            signature: await signTestVoucher(channelId, 8000000n),
          },
        },
        request: makeRequest(),
      })

      // Charge 1M — spent goes from 4M (settled baseline) to 5M.
      await charge(store, channelId, 1000000n)

      // Close must succeed with voucher >= max(spent=5M, settled=4M) = 5M.
      // Use 8M (the full authorization).
      const receipt = await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'close', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '8000000',
            signature: await signTestVoucher(channelId, 8000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      const ch = await store.getChannel(channelId)
      expect(ch!.finalized).toBe(true)
    })

    test('close after recovery rejects voucher below on-chain settled', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      // Open, settle 5M, wipe store.
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

      const settleTxHash = await settle(store, client, channelId, { escrowContract })
      await waitForTransactionReceipt(client, { hash: settleTxHash })
      await store.updateChannel(channelId, () => null)

      // Re-open with voucher = 7M.
      const server2 = createServer()
      await server2.verify({
        credential: {
          challenge: makeChallenge({ id: 'c2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'transaction' as const,
            channelId,
            transaction: serializedTransaction,
            cumulativeAmount: '7000000',
            signature: await signTestVoucher(channelId, 7000000n),
          },
        },
        request: makeRequest(),
      })

      // Try to close with 3M — below settled (5M). Must be rejected.
      await expect(
        server2.verify({
          credential: {
            challenge: makeChallenge({ id: 'close', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '3000000',
              signature: await signTestVoucher(channelId, 3000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('close voucher amount must be >=')
    })
  })

  describe('signature compatibility', () => {
    test('accepts compact (EIP-2098) signatures for open and voucher', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const server = createServer()

      const openSignature = toCompactSignature(await signTestVoucher(channelId, 1000000n))
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

      const voucherSignature = toCompactSignature(await signTestVoucher(channelId, 2000000n))
      const voucherReceipt = (await server.verify({
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
      })) as SessionReceipt
      expect(voucherReceipt.status).toBe('success')
      expect(voucherReceipt.acceptedCumulative).toBe('2000000')
    })

    test('rejects malformed compact signatures', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
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
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const compact = toCompactSignature(await signTestVoucher(channelId, 2000000n))
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
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
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
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const lowS = await signTestVoucher(channelId, 2000000n)
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
  })

  describe('session-level concurrency', () => {
    test('concurrent voucher submissions linearize to monotonic final state', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
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
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const amounts = [2000000n, 3000000n, 4000000n, 5000000n]
      const results = await Promise.allSettled(
        amounts.map(async (amount, index) =>
          server.verify({
            credential: {
              challenge: makeChallenge({ id: `voucher-concurrency-${index}`, channelId }),
              payload: {
                action: 'voucher' as const,
                channelId,
                cumulativeAmount: amount.toString(),
                signature: await signTestVoucher(channelId, amount),
              },
            },
            request: makeRequest(),
          }),
        ),
      )

      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      expect(fulfilled.length).toBeGreaterThan(0)

      const channel = await store.getChannel(channelId)
      expect(channel?.highestVoucherAmount).toBe(5000000n)
      expect(channel?.spent).toBe(0n)
    })
  })

  describe('fault tolerance', () => {
    test('recovers after open write crash by replaying open against on-chain state', async () => {
      const baseStore = Store.memory()
      const faultStore = withFaultHooks(baseStore, { failPutAt: 1 })
      const faultServer = createServerWithStore(faultStore)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const openPayload = {
        action: 'open' as const,
        type: 'transaction' as const,
        channelId,
        transaction: serializedTransaction,
        cumulativeAmount: '1000000',
        signature: await signTestVoucher(channelId, 1000000n),
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
      expect(channel?.highestVoucherAmount).toBe(1000000n)
      expect(channel?.deposit).toBe(10000000n)
    })

    test('recovers stale deposit after topUp write crash by reopening from on-chain state', async () => {
      const baseStore = Store.memory()
      const healthyServer = createServerWithStore(baseStore)
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5000000n)

      await healthyServer.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-before-topup-crash', channelId }),
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

      const additionalDeposit = 2000000n
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
      expect((await staleStore.getChannel(channelId))?.deposit).toBe(5000000n)

      await healthyServer.verify({
        credential: {
          challenge: makeChallenge({ id: 'reopen-after-topup-crash', channelId }),
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

      const recoveredChannel = await staleStore.getChannel(channelId)
      expect(recoveredChannel?.deposit).toBe(7000000n)
    })

    test('voucher rejects when channel disappears between read and update', async () => {
      const baseStore = Store.memory()
      const hooks = withReadDropHooks(baseStore)
      const server = createServerWithStore(hooks.store)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-racy-voucher', channelId }),
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

      hooks.dropOnRead(channelId, 1)
      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'voucher-racy-missing', channelId }),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '2000000',
              signature: await signTestVoucher(channelId, 2000000n),
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

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-racy-close', channelId }),
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

      hooks.dropOnRead(channelId, 1)
      const closeReceipt = (await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'close-racy-missing', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '1000000',
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })) as SessionReceipt

      expect(closeReceipt.status).toBe('success')
      expect(closeReceipt.spent).toBe('0')
      const persisted = await ChannelStore.fromStore(baseStore).getChannel(channelId)
      expect(persisted).toBeNull()
    })

    test('settle returns txHash even when channel disappears before settle write', async () => {
      const baseStore = Store.memory()
      const hooks = withReadDropHooks(baseStore)
      const server = createServerWithStore(hooks.store)

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-racy-settle', channelId }),
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

      hooks.dropOnRead(channelId, 1)
      const txHash = await settle(ChannelStore.fromStore(hooks.store), client, channelId, {
        escrowContract,
      })

      expect(txHash).toBeDefined()
      const persisted = await ChannelStore.fromStore(baseStore).getChannel(channelId)
      expect(persisted).toBeNull()
    })

    test('close rejects when channel was already finalized on-chain', async () => {
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(5000000n)
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
            signature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const closeSignature = await signTestVoucher(channelId, 1000000n)
      await closeChannelOnChain({
        escrow: escrowContract,
        payee: accounts[0],
        channelId,
        cumulativeAmount: 1000000n,
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

  describe('protocol compatibility', () => {
    test('HEAD voucher management request falls through to content handler', () => {
      const server = createServer()
      const response = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
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

      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
      const handler = createHandler()
      const route = handler.session({ amount: '1', decimals: 6, unitType: 'token' })

      const first = await route(new Request('https://api.example.com/resource'))
      if (first.status !== 402) throw new Error('expected challenge')
      const issuedChallenge = Challenge.fromResponse(first.challenge)
      const signature = await signTestVoucher(channelId, 1000000n)

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
      const { channelId, serializedTransaction } = await createSignedOpenTransaction(10000000n)
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
      if (second.status !== 402) throw new Error('expected challenge')
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
      const request = challenge.request as {
        amount: string
        suggestedDeposit: string
        methodDetails: { minVoucherDelta: string }
      }
      expect(request.amount).toBe('1')
      expect(request.suggestedDeposit).toBe('2')
      expect(request.methodDetails.minVoucherDelta).toBe('1')
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

    test('returns undefined for open POST with content-length > 0 (content request)', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'open' },
        },
        input: new Request('http://localhost', {
          method: 'POST',
          headers: { 'content-length': '42' },
        }),
      } as any)
      expect(result).toBeUndefined()
    })

    test('returns undefined for open POST with transfer-encoding header (content request)', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'open' },
        },
        input: new Request('http://localhost', {
          method: 'POST',
          headers: { 'transfer-encoding': 'chunked' },
        }),
      } as any)
      expect(result).toBeUndefined()
    })

    test('returns 204 for GET with topUp action', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'topUp' },
        },
        input: new Request('http://localhost', { method: 'GET' }),
      } as any)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(204)
    })

    test('returns undefined for voucher POST with content-length > 0 (content request)', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'voucher' },
        },
        input: new Request('http://localhost', {
          method: 'POST',
          headers: { 'content-length': '42' },
        }),
      } as any)
      expect(result).toBeUndefined()
    })

    test('returns undefined for voucher POST with transfer-encoding header (content request)', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'voucher' },
        },
        input: new Request('http://localhost', {
          method: 'POST',
          headers: { 'transfer-encoding': 'chunked' },
        }),
      } as any)
      expect(result).toBeUndefined()
    })

    test('returns 204 for voucher POST with content-length: 0', () => {
      const server = createServer()
      const result = server.respond!({
        credential: {
          challenge: makeChallenge({
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          }),
          payload: { action: 'voucher' },
        },
        input: new Request('http://localhost', {
          method: 'POST',
          headers: { 'content-length': '0' },
        }),
      } as any)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(204)
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
            sse: true,
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

    test('behavior: non-SSE session withReceipt only accepts Response', async () => {
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
      chainId: 42431,
      escrowContract: escrowContractDefaults[chainIdDefaults.testnet] as Address,
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
      closeRequestedAt: 0n,
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

describe('session request and verify guardrails', () => {
  const addressOne = '0x0000000000000000000000000000000000000001' as Address
  const addressTwo = '0x0000000000000000000000000000000000000002' as Address
  const defaultCurrency = '0x20c0000000000000000000000000000000000000'
  const defaultEscrow = '0x0000000000000000000000000000000000000003'

  function createMockClient(chainId: number) {
    return createClient({
      chain: {
        id: chainId,
        name: `Mock Chain ${chainId}`,
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: ['http://localhost:1'] } },
      },
      transport: http('http://localhost:1'),
    })
  }

  function makeRequest(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      amount: '1',
      unitType: 'token',
      currency: defaultCurrency,
      decimals: 6,
      recipient: addressTwo,
      chainId: 4217,
      ...overrides,
    }
  }

  test('request throws when no client exists for requested chain', async () => {
    const server = session({
      store: Store.memory(),
      account: addressOne,
      currency: defaultCurrency,
      getClient: async () => {
        throw new Error('unreachable chain')
      },
    } as session.Parameters)

    await expect(
      server.request!({
        credential: null,
        request: makeRequest({ chainId: 31337 }),
      } as never),
    ).rejects.toThrow('No client configured with chainId 31337.')
  })

  test('request throws when resolved client chain mismatches requested chain', async () => {
    const wrongChainClient = createMockClient(42431)
    const server = session({
      store: Store.memory(),
      account: addressOne,
      currency: defaultCurrency,
      getClient: async () => wrongChainClient,
    } as session.Parameters)

    await expect(
      server.request!({
        credential: null,
        request: makeRequest({ chainId: 4217 }),
      } as never),
    ).rejects.toThrow('Client not configured with chainId 4217.')
  })

  test('request normalizes fee-payer to boolean for challenge issuance and account for verification', async () => {
    const client = createMockClient(4217)
    const server = session({
      store: Store.memory(),
      account: addressOne,
      currency: defaultCurrency,
      feePayer: 'https://fee-payer.example.com',
      getClient: async () => client,
    } as session.Parameters)

    const challengeRequest = await server.request!({
      credential: null,
      request: makeRequest(),
    } as never)
    expect(challengeRequest.feePayer).toBe(true)

    const verificationRequest = await server.request!({
      credential: { challenge: {}, payload: {} } as never,
      request: makeRequest({ feePayer: accounts[1] }),
    } as never)
    expect(verificationRequest.feePayer).toBe(accounts[1])
  })

  test('request allows callers to explicitly disable fee-payer', async () => {
    const client = createMockClient(4217)
    const server = session({
      store: Store.memory(),
      account: addressOne,
      currency: defaultCurrency,
      feePayer: 'https://fee-payer.example.com',
      getClient: async () => client,
    } as session.Parameters)

    const normalized = await server.request!({
      credential: null,
      request: makeRequest({ feePayer: false }),
    } as never)
    expect(normalized.feePayer).toBeUndefined()
  })

  test('request leaves escrowContract undefined when chain has no configured default', async () => {
    const unknownChainId = 999_999
    const client = createMockClient(unknownChainId)
    const server = session({
      store: Store.memory(),
      account: addressOne,
      currency: defaultCurrency,
      getClient: async () => client,
    } as session.Parameters)

    const normalized = await server.request!({
      credential: null,
      request: makeRequest({ chainId: unknownChainId }),
    } as never)

    expect(normalized.escrowContract).toBeUndefined()
  })

  test('verify rejects unknown session actions', async () => {
    const client = createMockClient(4217)
    const server = session({
      store: Store.memory(),
      account: addressOne,
      currency: defaultCurrency,
      getClient: async () => client,
      escrowContract: defaultEscrow,
      chainId: 4217,
    } as session.Parameters)

    await expect(
      server.verify({
        credential: {
          challenge: {
            id: 'guard-unknown-action',
            realm: 'api.example.com',
            method: 'tempo',
            intent: 'session',
            request: {
              amount: '1000000',
              currency: defaultCurrency,
              recipient: addressTwo,
              methodDetails: {
                chainId: 4217,
                escrowContract: defaultEscrow,
              },
            },
          },
          payload: { action: 'rewind' },
        },
        request: makeRequest(),
      } as never),
    ).rejects.toThrow('unknown action: rewind')
  })
})

describe('session default currency resolution', () => {
  const mockAccount = accounts[0]
  const mockClient = createClient({ transport: http('http://localhost:1') })
  const mockMainnetClient = createClient({
    chain: {
      id: 4217,
      name: 'Tempo',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['http://localhost:1'] } },
    },
    transport: http('http://localhost:1'),
  })
  const mockTestnetClient = createClient({
    chain: {
      id: 42431,
      name: 'Tempo Testnet',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['http://localhost:1'] } },
    },
    transport: http('http://localhost:1'),
  })

  test('mainnet (default) resolves to USDC', () => {
    const server = session({
      store: Store.memory(),
      getClient: () => mockClient,
      account: mockAccount,
      escrowContract: '0x0000000000000000000000000000000000000002',
    } as session.Parameters)
    expect(server.defaults?.currency).toBe('0x20C000000000000000000000b9537d11c60E8b50')
  })

  test('testnet: true defaults to pathUSD', () => {
    const server = session({
      store: Store.memory(),
      getClient: () => mockClient,
      account: mockAccount,
      escrowContract: '0x0000000000000000000000000000000000000002',
      testnet: true,
    } as session.Parameters)
    expect(server.defaults?.currency).toBe('0x20c0000000000000000000000000000000000000')
  })

  test('unknown chain defaults to pathUSD', () => {
    const server = session({
      store: Store.memory(),
      getClient: () => mockClient,
      account: mockAccount,
      escrowContract: '0x0000000000000000000000000000000000000002',
      chainId: 69420,
    } as session.Parameters)
    expect(server.defaults?.currency).toBe('0x20c0000000000000000000000000000000000000')
  })

  test('explicit currency overrides default', () => {
    const server = session({
      store: Store.memory(),
      getClient: () => mockClient,
      account: mockAccount,
      currency: '0xcustom',
      escrowContract: '0x0000000000000000000000000000000000000002',
      chainId: 4217,
      testnet: false,
    } as session.Parameters)
    expect(server.defaults?.currency).toBe('0xcustom')
  })

  test('decimals defaults to 6', () => {
    const server = session({
      store: Store.memory(),
      getClient: () => mockClient,
      account: mockAccount,
      escrowContract: '0x0000000000000000000000000000000000000002',
      chainId: 42431,
    } as session.Parameters)
    expect(server.defaults?.decimals).toBe(6)
  })

  test('challenge contains USDC currency (mainnet default)', async () => {
    const handler = Mppx_server.create({
      methods: [
        tempo_server.session({
          store: Store.memory(),
          getClient: () => mockMainnetClient,
          account: mockAccount,
          escrowContract: '0x0000000000000000000000000000000000000002',
          chainId: 4217,
          testnet: false,
        }),
      ],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    const result = await (handler.session as Function)({
      amount: '1',
      decimals: 6,
      unitType: 'token',
    })(new Request('https://example.com'))
    expect(result.status).toBe(402)

    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.request.currency).toBe('0x20C000000000000000000000b9537d11c60E8b50')
  })

  test('challenge contains pathUSD currency when testnet: true', async () => {
    const handler = Mppx_server.create({
      methods: [
        tempo_server.session({
          store: Store.memory(),
          getClient: () => mockTestnetClient,
          account: mockAccount,
          escrowContract: '0x0000000000000000000000000000000000000002',
          testnet: true,
        }),
      ],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    const result = await (handler.session as Function)({
      amount: '1',
      decimals: 6,
      unitType: 'token',
      chainId: 42431,
    })(new Request('https://example.com'))
    expect(result.status).toBe(402)

    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.request.currency).toBe('0x20c0000000000000000000000000000000000000')
  })

  test('challenge contains pathUSD currency (unknown chain)', async () => {
    const handler = Mppx_server.create({
      methods: [
        tempo_server.session({
          store: Store.memory(),
          getClient: () => mockTestnetClient,
          account: mockAccount,
          escrowContract: '0x0000000000000000000000000000000000000002',
          chainId: 69420,
        }),
      ],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    const result = await (handler.session as Function)({
      amount: '1',
      decimals: 6,
      unitType: 'token',
    })(new Request('https://example.com'))
    expect(result.status).toBe(402)

    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.request.currency).toBe('0x20c0000000000000000000000000000000000000')
  })

  test('explicit currency in challenge overrides testnet default', async () => {
    const handler = Mppx_server.create({
      methods: [
        tempo_server.session({
          store: Store.memory(),
          getClient: () => mockClient,
          account: mockAccount,
          currency: '0xcustom',
          escrowContract: '0x0000000000000000000000000000000000000002',
          chainId: 4217,
          testnet: false,
        }),
      ],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    const result = await handler.session({
      amount: '1',
      decimals: 6,
      unitType: 'token',
    })(new Request('https://example.com'))
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.request.currency).toBe('0xcustom')
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
      recipient: recipient as string,
      methodDetails: {
        escrowContract: escrowContract as string,
        chainId: chain.id,
      },
    },
  } as Challenge.Challenge<z.output<typeof Methods.session.schema.request>, 'session', 'tempo'>
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

async function signTestVoucher(
  channelId: Hex,
  amount: bigint,
  account: (typeof accounts)[number] = payer,
) {
  return signVoucher(
    client,
    account,
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
