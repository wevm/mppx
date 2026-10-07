import { privateKeyToAccount } from 'viem/accounts'
import { tempo } from 'viem/chains'

import { sessionManager } from '../../tempo/session/client/SessionManager.js'
import { resolvePersistentAccount } from '../account.js'
import { fetchTokenInfo } from '../utils.js'
import { runPersistentSessionRequest } from './request.js'
import type { SessionRegistry } from './store.js'

vi.mock('../account.js', () => ({ resolvePersistentAccount: vi.fn() }))
vi.mock('../utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils.js')>()),
  resolveChain: async () => tempo,
  fetchTokenInfo: vi.fn(),
}))
vi.mock('../../tempo/session/client/SessionManager.js', () => ({
  sessionManager: vi.fn(() => {
    throw new Error('manager reached')
  }),
}))

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const token = '0x20c0000000000000000000000000000000000000'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolvePersistentAccount).mockResolvedValue({
    account,
    source: 'environment',
  } as Awaited<ReturnType<typeof resolvePersistentAccount>>)
})

function run(methodOptions: Record<string, string> = {}) {
  const release = vi.fn()
  return runPersistentSessionRequest({
    challenge: {
      id: 'challenge',
      realm: 'example.test',
      method: 'tempo',
      intent: 'session',
      request: {
        amount: '1',
        currency: token,
        ...{ decimals: 30 },
        unitType: 'request',
        recipient: account.address,
        suggestedDeposit: '1000000',
        methodDetails: { chainId: tempo.id, escrowContract: undefined },
      },
    },
    challengeResponse: new Response(null, { status: 402 }),
    endpoint: 'https://example.test/',
    fetchInput: 'https://example.test/',
    fetch: vi.fn(),
    init: {},
    info: vi.fn(),
    methodOptions,
    options: { session: 'new', silent: true, verbose: 0 },
    registry: { acquire: async () => ({ release }) } as unknown as SessionRegistry,
  })
}

test.each([{}, { deposit: '2' }])(
  'manager uses on-chain decimals with options %j',
  async (options) => {
    vi.mocked(fetchTokenInfo).mockResolvedValue({ token, decimals: 6, balance: 0n, symbol: 'USD' })
    await expect(run(options)).rejects.toThrow('manager reached')
    expect(fetchTokenInfo).toHaveBeenCalledWith(expect.anything(), token, account.address, {
      requireDecimals: true,
    })
    expect(sessionManager).toHaveBeenCalledWith(
      expect.objectContaining({ decimals: 6, maxDeposit: options.deposit ?? '1' }),
    )
  },
)

test('does not create a signing manager when metadata is unavailable', async () => {
  vi.mocked(fetchTokenInfo).mockRejectedValue(new Error('metadata unavailable'))
  await expect(run({ deposit: '2' })).rejects.toThrow('metadata unavailable')
  expect(sessionManager).not.toHaveBeenCalled()
})
