import { afterEach, describe, expect, test, vi } from 'vp/test'

import type * as Store from '../../../Store.js'

const recipient = '0x1234567890123456789012345678901234567890'
const subscriptionParameters = {
  amount: '10',
  chainId: 4217,
  currency: '0x20c0000000000000000000000000000000000001',
  periodCount: '1',
  periodUnit: 'day',
  recipient,
  resolve: async () => ({ key: 'user-1:plan:pro' }),
  subscriptionExpires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
} as const

/** Loads fresh module instances so each test observes its own one-time warning state. */
async function load() {
  vi.resetModules()
  const [{ tempo }, { session }, { subscription }, { memory }] = await Promise.all([
    import('../Methods.js'),
    import('../../session/server/Session.js'),
    import('../Subscription.js'),
    import('../../../Store.js'),
  ])
  return { memory, session, subscription, tempo }
}

type Create = (
  modules: Awaited<ReturnType<typeof load>>,
  store: Store.AtomicStore | undefined,
) => unknown

const cases: readonly { name: string; method: string; create: Create }[] = [
  {
    name: 'tempo.charge',
    method: 'tempo.charge',
    create: ({ tempo }, store) => tempo.charge({ recipient, store }),
  },
  {
    name: 'tempo.session',
    method: 'tempo.session',
    create: ({ tempo }, store) => tempo.session({ recipient, store }),
  },
  {
    name: 'session',
    method: 'tempo.session',
    create: ({ session }, store) => session({ recipient, store }),
  },
  {
    name: 'tempo.subscription',
    method: 'tempo.subscription',
    create: ({ tempo }, store) => tempo.subscription({ ...subscriptionParameters, store }),
  },
  {
    name: 'subscription',
    method: 'tempo.subscription',
    create: ({ subscription }, store) => subscription({ ...subscriptionParameters, store }),
  },
]

function memoryStoreWarnings(calls: readonly unknown[][]) {
  return calls.filter(([message]) => String(message).includes('in-memory store'))
}

describe('fallbackStore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test.each(cases)('$name warns once when store is omitted', async ({ create, method }) => {
    const modules = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    create(modules, undefined)
    create(modules, undefined)

    const warnings = memoryStoreWarnings(warn.mock.calls)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]![0]).toContain(`[mppx] ${method}() has no \`store\` configured`)
  })

  test.each(cases)('$name does not warn when store is provided', async ({ create }) => {
    const modules = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    create(modules, modules.memory())

    expect(memoryStoreWarnings(warn.mock.calls)).toHaveLength(0)
  })
})
