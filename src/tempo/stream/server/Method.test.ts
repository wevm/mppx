import { type Address, createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { OnChainChannel } from '../Chain.js'
import type { ChannelState, ChannelStorage, SessionState } from '../Storage.js'
import { signVoucher } from '../Voucher.js'
import { stream } from './Method.js'

// Mock Chain module to avoid real RPC calls
vi.mock('../Chain.js', () => {
  let mockOnChainChannel: OnChainChannel

  return {
    getOnChainChannel: vi.fn(async () => mockOnChainChannel),
    verifyTopUpTransaction: vi.fn(
      async (
        _rpcUrl: string,
        _escrow: Address,
        _channelId: Hex,
        _txHash: Hex,
        previousDeposit: bigint,
      ) => {
        if (mockOnChainChannel.finalized) throw new Error('Channel is finalized on-chain')
        if (mockOnChainChannel.deposit <= previousDeposit)
          throw new Error('Channel deposit did not increase')
        return { deposit: mockOnChainChannel.deposit }
      },
    ),
    __setMockChannel: (channel: OnChainChannel) => {
      mockOnChainChannel = channel
    },
  }
})

// Access the mock setter
const { __setMockChannel } = (await import('../Chain.js')) as typeof import('../Chain.js') & {
  __setMockChannel: (channel: OnChainChannel) => void
}

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const escrowContract = '0x1234567890abcdef1234567890abcdef12345678' as Address
const chainId = 42431
const recipient = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const currency = '0x20C0000000000000000000000000000000000001' as Address
const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

const client = createClient({
  account,
  transport: http('http://127.0.0.1'), // only used for local signTypedData
})

// ---- In-memory ChannelStorage ----

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

// ---- Helpers ----

// The challenge object (output type) has methodDetails nested.
// Optional fields must be explicitly present as `undefined` (exactOptionalPropertyTypes).
function makeChallenge(id = 'challenge-1') {
  return {
    id,
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
        chainId: chainId as number | undefined,
      },
    },
  }
}

// The request parameter (input type) has methodDetails flattened.
function makeRequest() {
  return {
    amount: '1000000',
    unitType: 'token',
    currency: currency as string,
    recipient: recipient as string,
    escrowContract: escrowContract as string,
    chainId,
  }
}

function makeOnChainChannel(overrides: Partial<OnChainChannel> = {}): OnChainChannel {
  return {
    payer: account.address,
    payee: recipient,
    token: currency,
    authorizedSigner: account.address,
    deposit: 10000000n,
    settled: 0n,
    closeRequestedAt: 0n,
    finalized: false,
    ...overrides,
  }
}

async function signTestVoucher(amount: bigint) {
  return signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: amount },
    escrowContract,
    chainId,
  )
}

// ---- Tests ----

describe('stream server Method', () => {
  let storage: ChannelStorage

  beforeEach(() => {
    storage = createMemoryStorage()
    __setMockChannel(makeOnChainChannel())
  })

  function createServer(overrides: Partial<Parameters<typeof stream>[0]> = {}) {
    return stream({
      storage,
      rpcUrl: 'http://mock-rpc',
      recipient,
      currency,
      escrowContract,
      chainId,
      ...overrides,
    })
  }

  describe('open', () => {
    test('accepts a valid open with voucher', async () => {
      const server = createServer()
      const voucherSig = await signTestVoucher(1000000n)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge(),
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

    test('rejects open when channel not funded', async () => {
      __setMockChannel(makeOnChainChannel({ deposit: 0n }))
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
            payload: {
              action: 'open' as const,
              type: 'hash' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Channel not funded on-chain')
    })

    test('rejects open when channel is finalized', async () => {
      __setMockChannel(makeOnChainChannel({ finalized: true }))
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
            payload: {
              action: 'open' as const,
              type: 'hash' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Channel is finalized on-chain')
    })

    test('rejects open when payee mismatch', async () => {
      __setMockChannel(
        makeOnChainChannel({ payee: '0x0000000000000000000000000000000000000099' as Address }),
      )
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
            payload: {
              action: 'open' as const,
              type: 'hash' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('On-chain payee does not match server destination')
    })

    test('rejects open when voucher exceeds deposit', async () => {
      __setMockChannel(makeOnChainChannel({ deposit: 500000n }))
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
            payload: {
              action: 'open' as const,
              type: 'hash' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Voucher amount exceeds on-chain deposit')
    })

    test('rejects open with invalid voucher signature', async () => {
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
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
      const server = createServer()

      // First open
      await server.verify({
        credential: {
          challenge: makeChallenge('open-1'),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(1000000n),
          },
        },
        request: makeRequest(),
      })

      const ch1 = await storage.getChannel(channelId)
      expect(ch1!.highestVoucherAmount).toBe(1000000n)

      // Reopen same channel with a higher voucher
      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge('open-2'),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '5000000',
            voucherSignature: await signTestVoucher(5000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
      const ch2 = await storage.getChannel(channelId)
      expect(ch2!.highestVoucherAmount).toBe(5000000n)
    })

    test('reopen existing channel with same voucher keeps existing state', async () => {
      const server = createServer()

      // First open
      await server.verify({
        credential: {
          challenge: makeChallenge('open-1'),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(1000000n),
          },
        },
        request: makeRequest(),
      })

      // Reopen with same amount — should not update highestVoucher
      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge('open-2'),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(1000000n),
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
    async function openChannel(server: ReturnType<typeof createServer>) {
      const voucherSig = await signTestVoucher(1000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge('open-challenge'),
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
      const server = createServer()
      await openChannel(server)

      const voucherSig = await signTestVoucher(2000000n)
      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge('challenge-2'),
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
      const server = createServer()
      await openChannel(server)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge('challenge-2'),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '500000',
              signature: await signTestVoucher(500000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Voucher amount must be increasing')
    })

    test('rejects voucher exceeding deposit', async () => {
      const server = createServer()
      await openChannel(server)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge('challenge-2'),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '99999999',
              signature: await signTestVoucher(99999999n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Voucher amount exceeds on-chain deposit')
    })

    test('rejects voucher below minVoucherDelta', async () => {
      const server = createServer({ minVoucherDelta: 2000000n })
      await openChannel(server)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge('challenge-2'),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '1500000',
              signature: await signTestVoucher(1500000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Voucher delta 500000 below minimum 2000000')
    })

    test('rejects voucher on unknown channel', async () => {
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
            payload: {
              action: 'voucher' as const,
              channelId,
              cumulativeAmount: '1000000',
              signature: await signTestVoucher(1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Channel not found')
    })
  })

  describe('topUp', () => {
    async function openChannel(server: ReturnType<typeof createServer>) {
      const voucherSig = await signTestVoucher(1000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge('open-challenge'),
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
      const server = createServer()
      await openChannel(server)

      // Simulate on-chain deposit increase
      __setMockChannel(makeOnChainChannel({ deposit: 20000000n }))

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge('challenge-2'),
          payload: {
            action: 'topUp' as const,
            channelId,
            topUpTxHash: '0xabcdef' as Hex,
            cumulativeAmount: '5000000',
            voucherSignature: await signTestVoucher(5000000n),
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
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
            payload: {
              action: 'topUp' as const,
              channelId,
              topUpTxHash: '0xabcdef' as Hex,
              cumulativeAmount: '5000000',
              voucherSignature: await signTestVoucher(5000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Channel not found')
    })
  })

  describe('close', () => {
    async function openChannel(server: ReturnType<typeof createServer>) {
      const voucherSig = await signTestVoucher(1000000n)
      await server.verify({
        credential: {
          challenge: makeChallenge('open-challenge'),
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
      const server = createServer()
      await openChannel(server)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge('challenge-2'),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(1000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      // Session should be cleaned up
      const session = await storage.getSession('challenge-2')
      expect(session).toBeNull()

      // Channel should still exist with final voucher preserved
      const ch = await storage.getChannel(channelId)
      expect(ch).not.toBeNull()
      expect(ch!.highestVoucherAmount).toBe(1000000n)
    })

    test('accepts close with voucher higher than previous highest', async () => {
      const server = createServer()
      await openChannel(server)

      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge('challenge-2'),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '5000000',
            voucherSignature: await signTestVoucher(5000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')

      const ch = await storage.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(5000000n)
    })

    test('rejects close with voucher below highest', async () => {
      const server = createServer()
      await openChannel(server)

      // Submit a higher voucher first
      await server.verify({
        credential: {
          challenge: makeChallenge('challenge-2'),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '3000000',
            signature: await signTestVoucher(3000000n),
          },
        },
        request: makeRequest(),
      })

      // Try to close with a lower amount
      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge('challenge-3'),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '2000000',
              voucherSignature: await signTestVoucher(2000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Close voucher amount must be >= highest accepted voucher')
    })

    test('rejects close exceeding on-chain deposit', async () => {
      const server = createServer()
      await openChannel(server)

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge('challenge-2'),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '99999999',
              voucherSignature: await signTestVoucher(99999999n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Close voucher amount exceeds on-chain deposit')
    })

    test('close re-reads on-chain deposit (not stale stored value)', async () => {
      const server = createServer()
      await openChannel(server)

      // Simulate deposit increase on-chain after open
      __setMockChannel(makeOnChainChannel({ deposit: 20000000n }))

      // Close with amount above original deposit (10M) but below new deposit (20M).
      // Would fail if handleClose used stored deposit; succeeds because it re-reads on-chain.
      const receipt = await server.verify({
        credential: {
          challenge: makeChallenge('challenge-2'),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '15000000',
            voucherSignature: await signTestVoucher(15000000n),
          },
        },
        request: makeRequest(),
      })

      expect(receipt.status).toBe('success')
    })

    test('rejects close on unknown channel', async () => {
      const server = createServer()

      await expect(
        server.verify({
          credential: {
            challenge: makeChallenge(),
            payload: {
              action: 'close' as const,
              channelId,
              cumulativeAmount: '1000000',
              voucherSignature: await signTestVoucher(1000000n),
            },
          },
          request: makeRequest(),
        }),
      ).rejects.toThrow('Channel not found')
    })
  })

  describe('full lifecycle', () => {
    test('open -> voucher -> voucher -> close', async () => {
      const server = createServer()

      // 1. Open
      await server.verify({
        credential: {
          challenge: makeChallenge('c1'),
          payload: {
            action: 'open' as const,
            type: 'hash' as const,
            channelId,
            cumulativeAmount: '1000000',
            voucherSignature: await signTestVoucher(1000000n),
          },
        },
        request: makeRequest(),
      })

      // 2. First voucher
      const r2 = await server.verify({
        credential: {
          challenge: makeChallenge('c2'),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '3000000',
            signature: await signTestVoucher(3000000n),
          },
        },
        request: makeRequest(),
      })
      expect(r2.status).toBe('success')

      // 3. Second voucher
      const r3 = await server.verify({
        credential: {
          challenge: makeChallenge('c3'),
          payload: {
            action: 'voucher' as const,
            channelId,
            cumulativeAmount: '7000000',
            signature: await signTestVoucher(7000000n),
          },
        },
        request: makeRequest(),
      })
      expect(r3.status).toBe('success')

      // Verify channel state
      const ch = await storage.getChannel(channelId)
      expect(ch!.highestVoucherAmount).toBe(7000000n)

      // 4. Close
      const r4 = await server.verify({
        credential: {
          challenge: makeChallenge('c4'),
          payload: {
            action: 'close' as const,
            channelId,
            cumulativeAmount: '7000000',
            voucherSignature: await signTestVoucher(7000000n),
          },
        },
        request: makeRequest(),
      })
      expect(r4.status).toBe('success')
      expect(r4.reference).toBe(channelId)

      // Channel preserved, session cleaned
      const chAfter = await storage.getChannel(channelId)
      expect(chAfter).not.toBeNull()
      expect(chAfter!.highestVoucherAmount).toBe(7000000n)
    })
  })
})
