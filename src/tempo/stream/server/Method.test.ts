import type { Address, Hex } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { rpcUrl } from '~test/tempo/prool.js'
import { deployEscrow, openChannel as openOnChain, topUpChannel } from '~test/tempo/stream.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'
import type { ChannelState, ChannelStorage, SessionState } from '../Storage.js'
import { signVoucher } from '../Voucher.js'
import { stream } from './Method.js'

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
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      const voucherSig = await signTestVoucher(channelId, 1000000n)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: voucherSig,
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
      const channelId = await createOnChainChannel(10000000n, { payee: wrongPayee })
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'open' as const,
              type: 'hash' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('On-chain payee does not match server destination')
    })

    test('rejects open when voucher exceeds deposit', async () => {
      const channelId = await createOnChainChannel(500000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'open' as const,
              type: 'hash' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Voucher amount exceeds on-chain deposit')
    })

    test('rejects open with invalid voucher signature', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'open' as const,
              type: 'hash' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: `0x${'ab'.repeat(65)}` as Hex,
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Invalid voucher signature')
    })

    test('reopen existing channel with higher voucher updates state', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const ch1 = await storage.getChannel(channelId)
      expect(ch1!.highestVoucherAmount).toBe(1000000n)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '5000000',
            voucherSignature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      const ch2 = await storage.getChannel(channelId)
      expect(ch2!.highestVoucherAmount).toBe(5000000n)
    })

    test('reopen existing channel with same voucher keeps existing state', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-2', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(channelId, 1000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      const ch = await storage.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(1000000n)
    })
  })

  describe('voucher', () => {
    async function openServerChannel(server: ReturnType<typeof createServer>, channelId: Hex) {
      const voucherSig = await signTestVoucher(channelId, 1000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-challenge', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: voucherSig,
          },
        },
        request: makeRequest(),
      })
    }

    test('accepts increasing voucher', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

      const voucherSig = await signTestVoucher(channelId, 2000000n)
      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '2000000',
            signature: voucherSig,
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await storage.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(2000000n)
    })

    test('rejects non-increasing voucher', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

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
      ).rejects.toThrow('Voucher amount must be increasing')
    })

    test('rejects voucher exceeding deposit', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

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
      ).rejects.toThrow('Voucher amount exceeds on-chain deposit')
    })

    test('rejects voucher below minVoucherDelta', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer({ minVoucherDelta: 2000000n })
      await openServerChannel(server, channelId)

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
      ).rejects.toThrow('Voucher delta 500000 below minimum 2000000')
    })

    test('rejects voucher on unknown channel', async () => {
      const channelId = await createOnChainChannel(10000000n)
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
      ).rejects.toThrow('Channel not found')
    })
  })

  describe('topUp', () => {
    async function openServerChannel(server: ReturnType<typeof createServer>, channelId: Hex) {
      const voucherSig = await signTestVoucher(channelId, 1000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-challenge', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: voucherSig,
          },
        },
        request: makeRequest(),
      })
    }

    test('accepts topUp with increased deposit', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

      const { txHash: topUpTxHash } = await topUpChannel({
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
            channelId,
            topUpTxHash,
            cumulativeAmount: '5000000',
            voucherSignature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await storage.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(5000000n)
      expect(ch!.deposit).toBe(20000000n)
    })

    test('rejects topUp on unknown channel', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'topUp' as const,
              channelId,
              topUpTxHash: '0xabcdef' as Hex,
              cumulativeAmount: '5000000',
              voucherSignature: await signTestVoucher(channelId, 5000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Channel not found')
    })
  })

  describe('close', () => {
    async function openServerChannel(server: ReturnType<typeof createServer>, channelId: Hex) {
      const voucherSig = await signTestVoucher(channelId, 1000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'open-challenge', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: voucherSig,
          },
        },
        request: makeRequest(),
      })
    }

    test('accepts close with final voucher >= highest', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(channelId, 1000000n),
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
    })

    test('accepts close with voucher higher than previous highest', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'challenge-2', channelId }),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '5000000',
            voucherSignature: await signTestVoucher(channelId, 5000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await storage.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(5000000n)
    })

    test('rejects close with voucher below highest', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

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
              voucherSignature: await signTestVoucher(channelId, 2000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Close voucher amount must be >= highest accepted voucher')
    })

    test('rejects close exceeding on-chain deposit', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ id: 'challenge-2', channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '99999999',
              voucherSignature: await signTestVoucher(channelId, 99999999n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Close voucher amount exceeds on-chain deposit')
    })

    test('close re-reads on-chain deposit (not stale stored value)', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()
      await openServerChannel(server, channelId)

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
            voucherSignature: await signTestVoucher(channelId, 15000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
    })

    test('rejects close on unknown channel', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge({ channelId }),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(channelId, 1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Channel not found')
    })
  })

  describe('full lifecycle', () => {
    test('open -> voucher -> voucher -> close', async () => {
      const channelId = await createOnChainChannel(10000000n)
      const server = createServer()

      await server.verify({
        credential: {
          challenge: makeChallenge({ id: 'c1', channelId }),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(channelId, 1000000n),
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
            voucherSignature: await signTestVoucher(channelId, 7000000n),
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

async function createOnChainChannel(
  deposit: bigint,
  opts?: { payee?: Address; authorizedSigner?: Address },
) {
  const salt = nextSalt()
  const { channelId } = await openOnChain({
    escrow: escrowContract,
    payer,
    payee: opts?.payee ?? recipient,
    token: currency,
    deposit,
    salt,
    ...(opts?.authorizedSigner !== undefined && { authorizedSigner: opts.authorizedSigner }),
  })
  return channelId
}
