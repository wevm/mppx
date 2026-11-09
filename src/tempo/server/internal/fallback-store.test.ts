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
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
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

  const productionRuntimes = [
    { name: 'NODE_ENV=production', stub: () => vi.stubEnv('NODE_ENV', 'production') },
    { name: 'Vercel', stub: () => vi.stubEnv('VERCEL', '1') },
    {
      name: 'Cloudflare Workers',
      stub: () => vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' }),
    },
  ] as const

  for (const runtime of productionRuntimes)
    test.each(cases)(
      `$name throws without store on ${runtime.name}`,
      async ({ create, method }) => {
        const modules = await load()
        runtime.stub()

        expect(() => create(modules, undefined)).toThrow(`${method}() has no \`store\` configured`)
      },
    )

  test.each(cases)('$name accepts an explicit memory store in production', async ({ create }) => {
    const modules = await load()
    vi.stubEnv('NODE_ENV', 'production')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => create(modules, modules.memory())).not.toThrow()
    expect(memoryStoreWarnings(warn.mock.calls)).toHaveLength(0)
  })

  test('tempo.charge sponsorBudget uses the configured store in production', async () => {
    const modules = await load()
    vi.stubEnv('NODE_ENV', 'production')

    expect(() =>
      modules.tempo.charge({ recipient, sponsorBudget: { store: modules.memory() } }),
    ).toThrow('tempo.charge() has no `store` configured')
    expect(() => modules.tempo.charge({ recipient, store: modules.memory() })).not.toThrow()
  })

  test('error names the fix', async () => {
    const modules = await load()
    vi.stubEnv('VERCEL', '1')

    expect(() => modules.tempo.charge({ recipient })).toThrowErrorMatchingInlineSnapshot(
      `[Error: tempo.charge() has no \`store\` configured, and VERCEL is set, so this server may run as several instances. An in-memory store would let a credential accepted by one instance be accepted again by another. Pass a shared atomic store, such as \`Store.redis()\`, \`Store.upstash()\`, \`Store.postgres()\`, \`Store.sql()\`, \`Store.d1()\`, \`Store.durableObject()\` or \`Store.cloudflare()\` with \`update\`, or pass \`store: Store.memory()\` to accept replay protection scoped to this instance.]`,
    )
  })
})
