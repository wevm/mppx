import { beforeEach, describe, expect, test, vi } from 'vitest'
import { clearTokenGateCache, parseDid, tokenGate } from './token-gate.js'
import type { TokenContract } from './token-gate.js'
import type * as Method from './Method.js'
import type * as Receipt from './Receipt.js'
import type * as Credential from './Credential.js'
import type * as Challenge from './Challenge.js'

// ---------------------------------------------------------------------------
// viem mock
// ---------------------------------------------------------------------------

const mockReadContract = vi.fn()

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: () => ({ readContract: mockReadContract }),
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CHAIN = { id: 8453, name: 'Base', rpcUrls: { default: { http: ['https://mainnet.base.org'] } } } as const

const ERC20_CONTRACT: TokenContract = {
  address: '0xToken000000000000000000000000000000000001',
  chain: BASE_CHAIN as never,
  type: 'ERC-20',
  minBalance: 100n,
}

const ERC721_CONTRACT: TokenContract = {
  address: '0xNFT0000000000000000000000000000000000001',
  chain: BASE_CHAIN as never,
  type: 'ERC-721',
}

const ERC721_SPECIFIC: TokenContract = {
  address: '0xNFT0000000000000000000000000000000000001',
  chain: BASE_CHAIN as never,
  type: 'ERC-721',
  tokenId: 42n,
}

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`
const TEST_DID = `did:pkh:eip155:8453:${TEST_ADDRESS}`

function makeChallenge(): Challenge.Challenge {
  return {
    id: 'test-challenge-id',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'charge',
    request: { amount: '0.01' },
  }
}

function makeCredential(source?: string): Credential.Credential {
  return {
    challenge: makeChallenge(),
    payload: { signature: '0xdeadbeef', type: 'hash' as const },
    ...(source !== undefined && { source }),
  }
}

function makeFreeReceipt(methodName = 'tempo'): Receipt.Receipt {
  return {
    method: methodName,
    reference: 'token-gate:free',
    status: 'success',
    timestamp: expect.any(String) as unknown as string,
  }
}

/** Builds a minimal Method.Server for testing. */
function makeServer(
  name = 'tempo',
  intent = 'charge',
  verifyResult: Receipt.Receipt | Error = {
    method: name,
    reference: '0xpaid',
    status: 'success',
    timestamp: new Date().toISOString(),
  },
): Method.Server {
  const verify = vi.fn(async () => {
    if (verifyResult instanceof Error) throw verifyResult
    return verifyResult
  })
  return {
    name,
    intent,
    schema: {
      credential: { payload: {} as never },
      request: {} as never,
    },
    verify,
  } as unknown as Method.Server
}

// ---------------------------------------------------------------------------
// parseDid
// ---------------------------------------------------------------------------

describe('parseDid', () => {
  test('behavior: parses valid EIP-155 DID', () => {
    expect(parseDid(`did:pkh:eip155:1:${TEST_ADDRESS}`)).toBe(TEST_ADDRESS)
  })

  test('behavior: parses DID with different chainId', () => {
    expect(parseDid(TEST_DID)).toBe(TEST_ADDRESS)
  })

  test('behavior: returns null for non-eip155 DID', () => {
    expect(parseDid('did:pkh:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9')).toBeNull()
  })

  test('behavior: returns null for malformed DID (too few parts)', () => {
    expect(parseDid('did:pkh:eip155:1')).toBeNull()
  })

  test('behavior: returns null for empty string', () => {
    expect(parseDid('')).toBeNull()
  })

  test('behavior: returns null when address missing 0x prefix', () => {
    expect(parseDid('did:pkh:eip155:1:f39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// tokenGate — fallthrough cases
// ---------------------------------------------------------------------------

describe('tokenGate — fallthrough', () => {
  beforeEach(() => {
    clearTokenGateCache()
    mockReadContract.mockReset()
  })

  test('behavior: falls through when credential has no source', async () => {
    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential() // no source

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
    expect(mockReadContract).not.toHaveBeenCalled()
  })

  test('behavior: falls through for unparseable DID', async () => {
    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential('not-a-did')

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
    expect(mockReadContract).not.toHaveBeenCalled()
  })

  test('behavior: falls through for non-eip155 DID', async () => {
    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential('did:pkh:solana:mainnet:5eykt4UsFv8P8')

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// tokenGate — holder path (free receipt)
// ---------------------------------------------------------------------------

describe('tokenGate — holder', () => {
  beforeEach(() => {
    clearTokenGateCache()
    mockReadContract.mockReset()
  })

  test('behavior: returns free receipt for ERC-20 holder', async () => {
    mockReadContract.mockResolvedValue(1000n) // balance >= minBalance (100n)

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential(TEST_DID)

    const receipt = await gated.verify({ credential, request: { amount: '0.01' } })

    expect(receipt).toMatchObject(makeFreeReceipt('tempo'))
    expect(server.verify).not.toHaveBeenCalled()
  })

  test('behavior: receipt method matches server.name', async () => {
    mockReadContract.mockResolvedValue(1n)

    const server = makeServer('stripe', 'charge')
    const gated = tokenGate(server, { contracts: [ERC721_CONTRACT] })
    const credential = makeCredential(TEST_DID)

    const receipt = await gated.verify({ credential, request: { amount: '0.01' } })

    expect(receipt.method).toBe('stripe')
    expect(receipt.reference).toBe('token-gate:free')
  })

  test('behavior: returns free receipt for ERC-721 balanceOf holder', async () => {
    mockReadContract.mockResolvedValue(3n) // holds 3 NFTs

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC721_CONTRACT] })
    const credential = makeCredential(TEST_DID)

    const receipt = await gated.verify({ credential, request: { amount: '0.01' } })

    expect(receipt.reference).toBe('token-gate:free')
  })

  test('behavior: returns free receipt for ERC-721 ownerOf match', async () => {
    mockReadContract.mockResolvedValue(TEST_ADDRESS) // ownerOf returns payer address

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC721_SPECIFIC] })
    const credential = makeCredential(TEST_DID)

    const receipt = await gated.verify({ credential, request: { amount: '0.01' } })

    expect(receipt.reference).toBe('token-gate:free')
    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'ownerOf', args: [42n] }),
    )
  })
})

// ---------------------------------------------------------------------------
// tokenGate — non-holder path (fallthrough to verify)
// ---------------------------------------------------------------------------

describe('tokenGate — non-holder', () => {
  beforeEach(() => {
    clearTokenGateCache()
    mockReadContract.mockReset()
  })

  test('behavior: delegates to original verify when balance is 0', async () => {
    mockReadContract.mockResolvedValue(0n)

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
  })

  test('behavior: delegates to original verify when balance is below minBalance', async () => {
    mockReadContract.mockResolvedValue(50n) // below minBalance of 100n

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
  })

  test('behavior: delegates when ownerOf returns different address', async () => {
    mockReadContract.mockResolvedValue('0x000000000000000000000000000000000000dead')

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC721_SPECIFIC] })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
  })

  test('behavior: ownerOf revert treated as non-holder', async () => {
    mockReadContract.mockRejectedValue(new Error('execution reverted'))

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC721_SPECIFIC] })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// matchMode
// ---------------------------------------------------------------------------

describe('tokenGate — matchMode', () => {
  beforeEach(() => {
    clearTokenGateCache()
    mockReadContract.mockReset()
  })

  test('behavior: matchMode any — one holder is enough', async () => {
    // First contract: not a holder. Second contract: holder.
    mockReadContract
      .mockResolvedValueOnce(0n)   // ERC-20: not holder
      .mockResolvedValueOnce(5n)   // ERC-721: holder

    const server = makeServer()
    const gated = tokenGate(server, {
      contracts: [ERC20_CONTRACT, ERC721_CONTRACT],
      matchMode: 'any',
    })
    const credential = makeCredential(TEST_DID)

    const receipt = await gated.verify({ credential, request: { amount: '0.01' } })

    expect(receipt.reference).toBe('token-gate:free')
  })

  test('behavior: matchMode all — must hold all contracts', async () => {
    mockReadContract
      .mockResolvedValueOnce(1000n) // ERC-20: holder
      .mockResolvedValueOnce(0n)    // ERC-721: not holder

    const server = makeServer()
    const gated = tokenGate(server, {
      contracts: [ERC20_CONTRACT, ERC721_CONTRACT],
      matchMode: 'all',
    })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(server.verify).toHaveBeenCalledOnce()
  })

  test('behavior: matchMode all — holder of all grants free access', async () => {
    mockReadContract
      .mockResolvedValueOnce(1000n) // ERC-20: holder
      .mockResolvedValueOnce(2n)    // ERC-721: holder

    const server = makeServer()
    const gated = tokenGate(server, {
      contracts: [ERC20_CONTRACT, ERC721_CONTRACT],
      matchMode: 'all',
    })
    const credential = makeCredential(TEST_DID)

    const receipt = await gated.verify({ credential, request: { amount: '0.01' } })

    expect(receipt.reference).toBe('token-gate:free')
  })
})

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('tokenGate — cache', () => {
  beforeEach(() => {
    clearTokenGateCache()
    mockReadContract.mockReset()
  })

  test('behavior: second call uses cached result (no extra readContract)', async () => {
    mockReadContract.mockResolvedValue(1000n)

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })
    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(mockReadContract).toHaveBeenCalledOnce()
  })

  test('behavior: clearTokenGateCache forces fresh readContract call', async () => {
    mockReadContract.mockResolvedValue(1000n)

    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })
    clearTokenGateCache()
    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(mockReadContract).toHaveBeenCalledTimes(2)
  })

  test('behavior: expired cache entry triggers fresh readContract call', async () => {
    mockReadContract.mockResolvedValue(1000n)

    const server = makeServer()
    // Very short TTL: 0 seconds
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT], cacheTtlSeconds: 0 })
    const credential = makeCredential(TEST_DID)

    await gated.verify({ credential, request: { amount: '0.01' } })
    await gated.verify({ credential, request: { amount: '0.01' } })

    expect(mockReadContract).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Preserves server shape
// ---------------------------------------------------------------------------

describe('tokenGate — server shape', () => {
  test('behavior: preserves all original server fields', () => {
    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })

    expect(gated.name).toBe(server.name)
    expect(gated.intent).toBe(server.intent)
    expect(gated.schema).toBe(server.schema)
  })

  test('behavior: replaces only verify', () => {
    const server = makeServer()
    const gated = tokenGate(server, { contracts: [ERC20_CONTRACT] })

    expect(gated.verify).not.toBe(server.verify)
  })
})
